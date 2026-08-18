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
use std::process::{Child, Command};
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

fn read_runtime() -> Option<Runtime> {
    let path = data_dir()?.join("daemon.json");
    let body = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&body).ok()
}

/// The staged Node runtime that ships inside the bundle.
fn runtime_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let base = app.path().resource_dir().ok()?.join("runtime");
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
            return None;
        }
    }
    let (node, entry) = runtime_paths(app)?;
    let mut cmd = Command::new(node);
    cmd.arg("--no-warnings=ExperimentalWarning")
        .arg(entry)
        .arg("daemon");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: without it every launch flashes a console.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().ok()
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

/// Open (or focus) the dashboard window.
///
/// The page is the daemon's, fetched over loopback with the token in the query
/// — which the page strips from its own address bar on load, so it does not sit
/// in a title or a history entry.
fn open_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(rt) = read_runtime() else { return };
    let url = format!("http://127.0.0.1:{}/?t={}", rt.port, rt.token);
    let Ok(parsed) = url.parse() else { return };
    let _ = WebviewWindowBuilder::new(app, "panel", WebviewUrl::External(parsed))
        .title("VibeTracker")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 320.0)
        .build();
}

fn main() {
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_exit = Arc::clone(&child);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();

            *child.lock().unwrap() = spawn_daemon(&handle);

            let open = MenuItem::with_id(app, "open", "Paneli aç", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çık", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let (tx, rx) = mpsc::channel::<u32>();

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("VibeTracker")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            open_panel(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            // The poller. A thread rather than an async task because everything
            // it does is one blocking HTTP call every three seconds, and the
            // whole runtime that would make that asynchronous is more machinery
            // than the problem has.
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + STARTUP_GRACE;
                let mut prev: Option<u32> = None;
                loop {
                    std::thread::sleep(POLL);
                    let Some(rt) = read_runtime() else {
                        if std::time::Instant::now() > deadline {
                            let _ = tx.send(u32::MAX);
                        }
                        continue;
                    };
                    let Some(ov) = overview(&rt) else { continue };
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
            // is not observing.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("tauri kurulamadı")
        .run(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // The daemon we started is ours to stop. One we merely found
                // running belongs to whoever started it and is left alone.
                if let Some(mut c) = child_for_exit.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        });
}
