// VibeTracker desktop shell.
//
// What this process is for, and what it deliberately is not.
//
// It is **not** a second implementation of anything. Every number it shows was
// computed by the engine, and the window it opens is the daemon's own dashboard
// served over loopback. The rule the note window follows applies here too: the
// engine decides, the surface draws.
//
// What it adds is the three things a browser tab cannot do — a tray icon that
// says how many agents are waiting without you looking at anything, a native
// notification when one starts waiting, and a supervisor that keeps the daemon
// alive. Those are the reasons this exists; a wrapper around a URL would not be.
//
// It also carries a Node runtime, which is the point of a desktop build: the
// person it is for does not have Node and should not have to get it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

/// How often the tray asks the daemon what it is looking at.
///
/// Not the daemon's own poll interval. This is a readout of a readout, and a
/// tray badge that updated four times a second would cost more than it says.
const POLL: Duration = Duration::from_secs(3);

/// How long to wait for the daemon to publish its port and token on first run.
const STARTUP_GRACE: Duration = Duration::from_secs(30);

#[derive(serde::Deserialize)]
struct Runtime {
    port: u16,
    token: String,
}

#[derive(serde::Deserialize)]
struct Counts {
    #[serde(rename = "needsYou")]
    needs_you: u32,
}

#[derive(serde::Deserialize)]
struct Overview {
    counts: Counts,
}

/// Where the daemon writes the port and token it chose.
///
/// The same three locations `dataDir()` returns in the TypeScript, because they
/// have to agree: a desktop app that looked in the wrong place would sit there
/// showing nothing while a perfectly healthy daemon ran beside it.
fn data_dir() -> Option<PathBuf> {
    // The same override the TypeScript honours. If these two ever disagreed,
    // the shell would sit there showing nothing beside a perfectly healthy
    // daemon -- which is the failure this whole function exists to avoid.
    if let Some(over) = std::env::var_os("VT_DATA_DIR") {
        if !over.is_empty() {
            return Some(PathBuf::from(over));
        }
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("VibeTracker"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("VibeTracker")
        })
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(x).join("vibetracker"));
        }
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".local").join("share").join("vibetracker"))
    }
}

/// A log file, because a tray app has nowhere else to say anything.
///
/// There is no console (`windows_subsystem = "windows"`), no terminal to run it
/// from and no window to print into: everything this process learns about a
/// failure is otherwise learned by nobody. One line per event, appended, and
/// the file is truncated when it passes a megabyte so it cannot grow into a
/// problem of its own. Paths and counts only -- the same rule the daemon's log
/// obeys, and pure ASCII, because `Get-Content` on Windows PowerShell decodes a
/// file as the system codepage and would turn a Turkish sentence into mojibake
/// in the one place somebody reads when something has already gone wrong.
fn log(msg: &str) {
    let Some(dir) = data_dir() else { return };
    let path = dir.join("desktop.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            let _ = std::fs::remove_file(&path);
        }
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ms} {msg}");
    }
}

fn read_runtime() -> Option<Runtime> {
    let path = data_dir()?.join("daemon.json");
    let body = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&body).ok()
}

/// \\?\C:\x  back to  C:\x.
///
/// Windows' verbatim prefix is what `resource_dir()` hands back, and it is
/// perfectly valid -- to Windows. It is not valid to everything that reads a
/// path *as a string*, and Node is one of those: handed
/// \\?\C:\...\index.ts as its main module it parses its way down to
/// `lstat('C:')` and exits with EISDIR before a line of user code runs.
///
/// Which is the whole of "the desktop app cannot start its own daemon". The
/// child launched, died in milliseconds, wrote nothing anywhere, and the tray
/// reported an empty board for ever. The path existed, `exists()` said so, and
/// every check this process was able to make passed.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p
}

/// The staged Node runtime that ships inside the bundle.
fn runtime_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let base = plain(app.path().resource_dir().ok()?).join("runtime");
    let node = base.join(if cfg!(windows) { "node.exe" } else { "node" });
    let entry = base
        .join("packages")
        .join("cli")
        .join("src")
        .join("index.ts");
    if node.exists() && entry.exists() {
        Some((node, entry))
    } else {
        None
    }
}

/// Start the daemon, unless one is already answering.
///
/// The check is the daemon's own single-instance rule turned around: if
/// `daemon.json` names a port that responds, there is nothing to start. Two
/// daemons on one machine is not a failure mode this app should be able to
/// create, and the second one would exit anyway — noisily, in a log nobody
/// opens.
fn spawn_daemon(app: &AppHandle) -> Option<Child> {
    if let Some(rt) = read_runtime() {
        if health(&rt).is_some() {
            log("daemon zaten yanit veriyor, baslatilmadi");
            return None;
        }
    }
    match run_cli(app, &["daemon"]) {
        Some(c) => {
            log(&format!("daemon baslatildi pid={}", c.id()));
            Some(c)
        }
        None => {
            // The one failure that used to be completely silent. A supervisor
            // that cannot start the thing it supervises, and says nothing
            // about it, is indistinguishable from a healthy one -- and the
            // symptom is a tray icon reporting nothing at all, for ever.
            log("daemon BASLATILAMADI");
            None
        }
    }
}

/// Run the bundled `vt` with the given arguments.
///
/// The same runtime the daemon runs on, because there is only one: the app
/// carries a Node and the CLI's sources, and every subcommand is reachable
/// from here without the user having installed anything.
fn run_cli(app: &AppHandle, args: &[&str]) -> Option<Child> {
    let Some((node, entry)) = runtime_paths(app) else {
        // Which half is missing matters: no `node` means the bundle was built
        // without a runtime, no entry means it was built without the sources.
        // Both look identical from the outside -- nothing happens -- and both
        // are build faults rather than anything the user did.
        let base = app
            .path()
            .resource_dir()
            .map(|d| d.join("runtime").display().to_string())
            .unwrap_or_else(|_| "(resource_dir yok)".into());
        log(&format!("calisma zamani bulunamadi: {base}"));
        return None;
    };
    // Written down, because a wrong one produces a child that dies before it
    // can say anything and a tray that reports nothing for ever.
    log(&format!("calistiriliyor: node={} entry={} {args:?}", node.display(), entry.display()));
    let mut cmd = Command::new(node);
    cmd.arg("--no-warnings=ExperimentalWarning").arg(&entry);
    for a in args {
        cmd.arg(a);
    }
    // Somewhere to write, and not the handles this process was given.
    //
    // This process has no console -- `windows_subsystem = "windows"` -- so what
    // a child inherits is not a handle to anything. The daemon prints its
    // startup lines to stdout before its own logger exists, which is exactly
    // the window in which it can die without leaving a trace: the tray then
    // reports an empty board for ever and nothing anywhere says why.
    //
    // A file rather than `Stdio::null()` for that reason. Null would fix the
    // writing and keep the silence, and the silence is the part that costs a
    // day.
    cmd.stdin(Stdio::null());
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir().map(|d| d.join("daemon-stdout.log")).unwrap_or_default())
    {
        Ok(f) => {
            let e = match f.try_clone() {
                Ok(c) => c,
                Err(_) => {
                    cmd.stdout(Stdio::null()).stderr(Stdio::null());
                    return spawn_it(cmd);
                }
            };
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(e));
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: without it every launch flashes a console.
        cmd.creation_flags(0x0800_0000);
    }
    spawn_it(cmd)
}

fn spawn_it(mut cmd: Command) -> Option<Child> {
    match cmd.spawn() {
        Ok(c) => Some(c),
        Err(e) => {
            log(&format!("calistirilamadi: {e}"));
            None
        }
    }
}

/// Open the sticky note.
///
/// The dashboard window and the note are two sizes of one board, and until now
/// you could only get from the small one to the big one -- the note has had an
/// arrow to the full dashboard since it was written, while the only route back
/// was typing `vt mini` in a terminal. A tray app whose smaller surface is
/// reachable only from a terminal has not really shipped it.
///
/// **Which note you get depends on the platform, and that is the honest part.**
///
/// On Windows there is a real one: a painted, chromeless, always-on-top panel
/// with its own chooser, three shapes and a voice. It is fifteen hundred lines
/// of WinForms reached through PowerShell and it is never going to run anywhere
/// else.
///
/// Everywhere else `vt mini` falls back to a Chromium `--app` window that it
/// cannot pin, because pinning is `SetWindowPos` and that is Win32. So on macOS
/// and Linux the tool's whole premise -- a corner of the screen that answers
/// "is anything waiting for me" while you work on something else -- did not
/// hold: the window went behind the editor and stayed there, and the command
/// line said so politely and left it at that.
///
/// This process can fix it, and it is the only part of the product that can.
/// Tauri gives a small, undecorated, genuinely always-on-top window on all
/// three platforms, and the page it needs already exists: the dashboard's own
/// `#mini` view, which is now drawn in the note's grammar rather than as a
/// narrow web page. So the sticky note on macOS and Linux is a real sticky
/// note, showing the same numbers drawn the same way as the Windows one.
fn open_note(app: &AppHandle) {
    let app = app.clone();
    // Spawned, like the panel: window creation must not happen on the event
    // loop, and `vt mini` waits on a window handshake before it returns.
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            // The native panel is strictly better where it exists.
            let _ = run_cli(&app, &["mini"]);
        }
        #[cfg(not(windows))]
        {
            build_note(&app);
        }
    });
}

/// The post-it, as a window this process owns.
///
/// Undecorated on purpose: a title bar on a 260-pixel readout spends a fifth of
/// its height on a name you already know. The page carries its own strip with
/// the drag region on it, which is what `-webkit-app-region: drag` in the
/// minibar rule is for.
#[cfg(not(windows))]
fn build_note(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("note") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(rt) = read_runtime() else { return };
    // The fragment never reaches the server -- it is a view preference, and the
    // daemon has no business knowing which shape of the page you are reading.
    let url = format!("http://127.0.0.1:{}/?t={}#mini", rt.port, rt.token);
    let Ok(parsed) = url.parse() else { return };
    let _ = WebviewWindowBuilder::new(app, "note", WebviewUrl::External(parsed))
        .title("VibeTracker")
        .inner_size(380.0, 260.0)
        .min_inner_size(300.0, 90.0)
        .always_on_top(true)
        .decorations(false)
        .resizable(true)
        .visible(true)
        .build();
}

fn health(rt: &Runtime) -> Option<()> {
    let url = format!("http://127.0.0.1:{}/api/v1/health", rt.port);
    ureq::get(&url)
        .set("X-VT-Token", &rt.token)
        .timeout(Duration::from_secs(2))
        .call()
        .ok()
        .map(|_| ())
}

fn overview(rt: &Runtime) -> Option<Overview> {
    let url = format!("http://127.0.0.1:{}/api/v1/overview", rt.port);
    let resp = ureq::get(&url)
        .set("X-VT-Token", &rt.token)
        .timeout(Duration::from_secs(3))
        .call()
        .ok()?;
    // Parsed by hand rather than through `ureq`'s json feature: that feature
    // pulls in a TLS stack, and this process talks to 127.0.0.1 over plain HTTP
    // and to nothing else. Not compiling a TLS client into an observer that has
    // no use for one is worth two lines.
    let body = resp.into_string().ok()?;
    serde_json::from_str::<Overview>(&body).ok()
}

/// Guards the one moment two clicks can collide.
///
/// Creating the window is now asynchronous, so a double click can put two
/// threads past the `get_webview_window` check before either has built
/// anything. The loser's `build` would fail on the duplicate label -- harmless,
/// but it would also spend a WebView2 startup to find that out.
static OPENING: AtomicBool = AtomicBool::new(false);

/// Open (or focus) the dashboard window.
///
/// The page is the daemon's, fetched over loopback with the token in the query
/// — which the page strips from its own address bar on load, so it does not sit
/// in a title or a history entry.
///
/// **The window is built on a spawned thread, and it has to be.** Tauri's own
/// runtime says so twice, in `tauri-runtime-wry`:
///
/// > Creates a webview by dispatching a message to the event loop. Note that
/// > this must be called from a separate thread, otherwise the channel will
/// > introduce a deadlock.
///
/// Both callers here -- the tray click and the tray menu -- are synchronous
/// handlers running *on* that event loop. Building from inside one asks the
/// loop for a window and then blocks the loop that would deliver it, so the
/// whole app stops: no window, and a tray icon that no longer answers. That is
/// exactly what it did, and the half-created window at -32000,-32000 that an
/// earlier fix chased was this deadlock's wreckage rather than a missing
/// `unminimize`.
///
/// Showing an existing window stays inline, because that path is not a
/// deadlock: `send_user_message` runs the message directly when it is already
/// on the main thread instead of posting it and waiting.
fn open_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        // Closing the window only hides it, so the one being reopened is
        // usually hidden -- but it can also be minimised, and `show` alone
        // leaves a minimised window minimised.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // The same check the close path makes, for the same reason and in the
        // same direction: `show` reporting success is not the window being on
        // screen. A handle that is still registered but no longer backed by a
        // live window answers every call with `Ok` and does nothing, and the
        // symptom is a tray icon you can click all day for no result. Dropping
        // it and falling through rebuilds from scratch, which always works.
        if w.is_visible().unwrap_or(false) {
            return;
        }
        log("panel gosterilemedi, yeniden kuruluyor");
        let _ = w.destroy();
    }
    if OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        build_panel(&app);
        OPENING.store(false, Ordering::SeqCst);
    });
}

fn build_panel(app: &AppHandle) {
    let Some(rt) = read_runtime() else { return };
    let url = format!("http://127.0.0.1:{}/?t={}", rt.port, rt.token);
    let Ok(parsed) = url.parse() else { return };
    if let Ok(w) = WebviewWindowBuilder::new(app, "panel", WebviewUrl::External(parsed))
        .title("VibeTracker")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 320.0)
        .visible(true)
        .focused(true)
        .build()
    {
        // Asked for again after the build. The window is created while a tray
        // flyout owns the foreground, and on Windows that is enough for it to
        // arrive behind whatever had it.
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_exit = Arc::clone(&child);
    let child_for_supervisor = Arc::clone(&child);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();

            *child.lock().unwrap() = spawn_daemon(&handle);

            let open = MenuItem::with_id(app, "open", "Paneli aç", true, None::<&str>)?;
            let note = MenuItem::with_id(app, "note", "Post-it", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çık", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &note, &quit])?;

            // A way in that is not the mouse.
            //
            // Every surface this process owns is reached by clicking a tray
            // icon, which means none of it can be exercised without a physical
            // cursor -- not by a test, not by a bug report, and not by someone
            // whose tray icon is hidden in the Windows 11 overflow. One
            // environment variable is the cheapest door that does not change
            // what the app does when nobody sets it.
            if std::env::var("VT_DESKTOP_PANEL").is_ok() {
                open_panel(&handle);
            }

            let (tx, rx) = mpsc::channel::<u32>();

            // Left click: open the panel on Windows and macOS, show the menu on
            // Linux.
            //
            // Not a preference. A Linux tray icon is a StatusNotifierItem owned
            // by the desktop's own indicator host, and that host does not send
            // click events back to us -- `TrayIconEvent` simply never fires
            // there. With the menu suppressed as well, the icon had no left
            // click behaviour at all on Linux: the entire product was reachable
            // only by right-clicking, and nothing said so.
            let left_opens_menu = cfg!(target_os = "linux");

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("VibeTracker")
                .menu(&menu)
                .show_menu_on_left_click(left_opens_menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_panel(app),
                    "note" => open_note(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // `button_state` matters: `Click` fires for both the press
                    // and the release, so ignoring it acts twice on one click.
                    // Measured consequence -- the window was created by the
                    // first call and then arrived iconified at -32000,-32000
                    // while the second raced its creation. Acting on release is
                    // also simply what every other button in the OS does.
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            // The poller. A thread rather than an async task because everything
            // it does is one blocking HTTP call every three seconds, and the
            // whole runtime that would make that asynchronous is more machinery
            // than the problem has.
            //
            // It is also the supervisor, and until now nothing was. The daemon
            // was started once at launch and never looked at again, so the
            // moment it exited -- and it exits on purpose, the watchdog would
            // rather die than hang -- the tray reported an empty board until
            // somebody restarted the whole app. "Keeps the daemon alive" is one
            // of the three reasons this process exists; starting it once is not
            // that.
            let child_for_poll = Arc::clone(&child_for_supervisor);
            let supervisor = handle.clone();
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + STARTUP_GRACE;
                let mut prev: Option<u32> = None;
                // Consecutive silent polls, and when we last did something
                // about it. Three polls is about nine seconds -- long enough
                // that an ordinary restart is not raced, short enough that a
                // person does not go and make coffee.
                let mut quiet: u32 = 0;
                let mut last_restart: Option<std::time::Instant> = None;
                loop {
                    std::thread::sleep(POLL);
                    let rt = read_runtime();
                    let answered = rt.as_ref().and_then(overview);
                    let Some(ov) = answered else {
                        // No overview is not the same as no daemon. A daemon
                        // that has just started has not finished its first scan
                        // and answers `health` while it has nothing to report,
                        // and counting that as death restarts a perfectly good
                        // daemon nine seconds after launching it. So liveness
                        // is asked of the endpoint that can answer it, and only
                        // in the path where something already looked wrong.
                        let alive = rt.as_ref().map(|r| health(r).is_some()).unwrap_or(false);
                        if alive {
                            quiet = 0;
                            continue;
                        }
                        quiet += 1;
                        if std::time::Instant::now() > deadline {
                            let _ = tx.send(u32::MAX);
                        }
                        // A restart at most every thirty seconds. A supervisor
                        // that respawns as fast as a broken daemon can exit is
                        // a fork bomb with good intentions.
                        let cool = last_restart
                            .map(|t| t.elapsed() >= Duration::from_secs(30))
                            .unwrap_or(true);
                        if quiet >= 3 && cool {
                            last_restart = Some(std::time::Instant::now());
                            log(&format!("daemon {quiet} tur sessiz, yeniden baslatiliyor"));
                            if let Some(c) = spawn_daemon(&supervisor) {
                                if let Ok(mut slot) = child_for_poll.lock() {
                                    // Whatever was there is gone -- that is why
                                    // we are here -- but it is reaped rather
                                    // than left as a zombie.
                                    if let Some(mut old) = slot.take() {
                                        let _ = old.kill();
                                        let _ = old.wait();
                                    }
                                    *slot = Some(c);
                                }
                            }
                        }
                        continue;
                    };
                    quiet = 0;
                    let n = ov.counts.needs_you;
                    let _ = tx.send(n);

                    // A *transition* into waiting, never a state. Announcing the
                    // state would mean a notification every three seconds for as
                    // long as anything was blocked, which is how a notification
                    // becomes something people turn off. And nothing at all on
                    // the first reading: with nothing to compare against,
                    // everything looks like a transition, so a restart would
                    // otherwise announce the whole board.
                    if let Some(before) = prev {
                        if n > before {
                            let _ = handle
                                .notification()
                                .builder()
                                .title("VibeTracker")
                                .body(if n == 1 {
                                    "Bir ajan seni bekliyor".to_string()
                                } else {
                                    format!("{n} ajan seni bekliyor")
                                })
                                .show();
                        }
                    }
                    prev = Some(n);
                }
            });

            // The badge. Kept on the main thread: tray updates are UI calls.
            let tray_handle = tray.clone();
            app.handle().run_on_main_thread(move || {})?;
            std::thread::spawn(move || {
                while let Ok(n) = rx.recv() {
                    if n == u32::MAX {
                        let _ = tray_handle.set_tooltip(Some("VibeTracker — daemon yanıt vermiyor"));
                        continue;
                    }
                    let _ = tray_handle.set_tooltip(Some(&if n == 0 {
                        "VibeTracker — bekleyen yok".to_string()
                    } else {
                        format!("VibeTracker — {n} bekliyor")
                    }));
                    // macOS is the only platform with room for text beside the
                    // icon, and it is the platform whose users expect it.
                    #[cfg(target_os = "macos")]
                    {
                        let _ = tray_handle.set_title(Some(&if n == 0 {
                            String::new()
                        } else {
                            format!("{n}")
                        }));
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window closes the window. The tray is the app, and an
            // observer that quits when you tidy your desktop is an observer that
            // is not observing. So the X hides it and the tray brings it back,
            // and the window keeps its size and place across the round trip.
            //
            // **Then it is checked, because it was measured failing.** On a
            // shell that had been up for an hour and a half, pressing the X did
            // nothing at all: the close was prevented and the hide silently was
            // not applied, twice in a row, with the process perfectly
            // responsive. `hide` returns `Ok` in that case -- it reports that
            // the message was delivered, not that the window moved -- so
            // trusting the return value is what let the window sit there
            // unclosable.
            //
            // Which is why the fallback is `destroy` rather than another `hide`.
            // A person who pressed the X is owed a window that goes away, and if
            // the cheap way of doing that will not take, the expensive way must:
            // `open_panel` rebuilds a missing window from nothing, so the whole
            // cost of being wrong here is one WebView2 startup the next time
            // they open it. A window that ignores its own close button costs
            // more than that.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if window.is_visible().unwrap_or(false) {
                    log(&format!("gizlenemedi, kapatiliyor: {}", window.label()));
                    let _ = window.destroy();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("tauri kurulamadı")
        .run(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                // Losing the last window is not a request to quit.
                //
                // Tauri asks to exit when no windows are left, which for an
                // ordinary app is right and for a tray app is the opposite of
                // right: the tray *is* the app, and the panel is a thing it
                // opens. Measured here -- with the close path's `destroy`
                // fallback forced, closing the panel took the whole shell down
                // and the daemon with it, so a window that would not hide
                // turned into a tracker that stopped tracking.
                //
                // `code` is what separates the two. `None` means the runtime
                // noticed there was nothing left on screen; `Some` means
                // somebody chose Quit, and that one is honoured.
                if code.is_none() {
                    api.prevent_exit();
                    return;
                }
                // The daemon we started is ours to stop. One we merely found
                // running belongs to whoever started it and is left alone.
                if let Some(mut c) = child_for_exit.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        });
}
