/**
 * A small window that stays on top of everything else.
 *
 * The requirement is a sticky note: a corner of the screen that answers "is
 * anything waiting for me" while you work on something else. Three ways to
 * build that were considered and two rejected.
 *
 * Electron and Tauri both give a real always-on-top window and both cost the
 * thing this product is built around — zero runtime dependencies. Tauri needs
 * a Rust toolchain to build and is already planned as its own milestone;
 * Electron would multiply the install size by fifty for one window.
 *
 * What is left is the browser that is already installed. Chromium's `--app`
 * mode gives a chromeless window with no tabs or address bar, and Win32 will
 * put any window in the topmost band for us. So the dashboard we already have
 * becomes the sticky note, and the only new code is "find a browser" and "call
 * SetWindowPos" — no new dependency, no second UI to keep in sync.
 *
 * Honest limits, stated where the user can see them: pinning is Windows-only
 * for now (macOS and Linux get the window, just not on top), and it needs a
 * Chromium-family browser. Neither failure is fatal — the window still opens.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './dirs.ts';

const PIN_SCRIPT = fileURLToPath(new URL('./pin.ps1', import.meta.url));

export interface BrowserFound {
  path: string;
  /** `edge` | `chrome` | `brave` | `vivaldi` | `chromium` */
  family: string;
}

function candidates(): Array<{ path: string; family: string }> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');

  if (process.platform === 'win32') {
    const win = (base: string, rel: string, family: string) => ({
      path: join(base, rel),
      family,
    });
    return [
      win(pf86, 'Microsoft\\Edge\\Application\\msedge.exe', 'edge'),
      win(pf, 'Microsoft\\Edge\\Application\\msedge.exe', 'edge'),
      win(pf, 'Google\\Chrome\\Application\\chrome.exe', 'chrome'),
      win(pf86, 'Google\\Chrome\\Application\\chrome.exe', 'chrome'),
      win(local, 'Google\\Chrome\\Application\\chrome.exe', 'chrome'),
      win(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'brave'),
      win(pf, 'Vivaldi\\Application\\vivaldi.exe', 'vivaldi'),
      win(local, 'Vivaldi\\Application\\vivaldi.exe', 'vivaldi'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      {
        path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        family: 'chrome',
      },
      {
        path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        family: 'edge',
      },
      {
        path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        family: 'brave',
      },
    ];
  }
  return [
    { path: '/usr/bin/google-chrome', family: 'chrome' },
    { path: '/usr/bin/chromium', family: 'chromium' },
    { path: '/usr/bin/chromium-browser', family: 'chromium' },
    { path: '/usr/bin/microsoft-edge', family: 'edge' },
    { path: '/usr/bin/brave-browser', family: 'brave' },
  ];
}

export function findBrowser(): BrowserFound | null {
  for (const c of candidates()) {
    if (c.path && existsSync(c.path)) return c;
  }
  return null;
}

/** Where the pinned window keeps its own browser profile. */
export function miniProfileDir(): string {
  return join(dataDir(), 'mini-profile');
}

export interface MiniWindowOptions {
  url: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface MiniWindow {
  pid: number;
  browser: BrowserFound;
}

/**
 * Open the dashboard as a standalone window.
 *
 * The separate `--user-data-dir` is not tidiness, it is what makes this work:
 * launched into an existing browser session the process hands off and exits
 * immediately, taking the pid we need to pin with it, and the window geometry
 * flags are ignored in favour of whatever that profile last remembered. Its own
 * profile also means the window's position survives restarts for free, and
 * that we never touch the user's browsing data.
 */
export function openMiniWindow(opts: MiniWindowOptions): MiniWindow | null {
  const browser = findBrowser();
  if (!browser) return null;

  const args = [
    `--app=${opts.url}`,
    `--user-data-dir=${miniProfileDir()}`,
    `--window-size=${opts.width},${opts.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    // No background work, no crash reporting, no phoning home: this window
    // shows a page served from loopback and should do nothing else.
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--disable-sync',
    // Not only privacy: the crash handler is a separate process that outlives
    // the browser and keeps a file open inside our data directory, which is
    // enough to make `vt uninstall` fail to remove it.
    '--disable-crash-reporter',
    '--no-crashpad',
  ];
  if (opts.x !== undefined && opts.y !== undefined) {
    args.push(`--window-position=${opts.x},${opts.y}`);
  }

  const child = spawn(browser.path, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  if (child.pid === undefined) return null;
  return { pid: child.pid, browser };
}

/**
 * The window we opened last time, so a second `vt mini` reuses it.
 *
 * Chromium hands a launch off to whichever process already owns the profile
 * and then exits, so the second run has no pid of its own to pin. Remembering
 * the first one is what makes repeat runs mean "bring it back" instead of
 * "silently do nothing".
 */
export interface MiniState {
  pid: number;
  startedAt: number;
}

export function miniStatePath(): string {
  return join(dataDir(), 'mini.json');
}

export function readMiniState(): MiniState | null {
  try {
    const parsed = JSON.parse(readFileSync(miniStatePath(), 'utf8')) as Partial<MiniState>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export function writeMiniState(state: MiniState): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(miniStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Losing this only costs the reuse shortcut, never the window.
  }
}

export function clearMiniState(): void {
  try {
    unlinkSync(miniStatePath());
  } catch {
    /* already gone */
  }
}

export type PinResult =
  | { ok: true; title?: string }
  | { ok: false; reason: 'unsupported' | 'no-window' | 'process-gone' | 'failed' };

/**
 * Put a window in the always-on-top band.
 *
 * Windows only. Elsewhere this reports `unsupported` rather than pretending:
 * the window is still open and useful, and claiming to have pinned it when it
 * will sink behind the next thing you click would be worse than saying so.
 */
export async function pinWindow(
  pid: number,
  opts: { unpin?: boolean; checkOnly?: boolean; timeoutMs?: number } = {},
): Promise<PinResult> {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PIN_SCRIPT,
    '-ProcessId',
    String(pid),
    '-TimeoutMs',
    String(opts.timeoutMs ?? 15000),
  ];
  if (opts.unpin) args.push('-Unpin');
  if (opts.checkOnly) args.push('-CheckOnly');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => resolve({ ok: false, reason: 'failed' }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim()) as { ok?: boolean; reason?: string; title?: string };
        if (parsed.ok === true) return resolve({ ok: true, title: parsed.title });
        const reason = parsed.reason;
        if (reason === 'no-window' || reason === 'process-gone') {
          return resolve({ ok: false, reason });
        }
      } catch {
        /* fall through to the generic failure */
      }
      resolve({ ok: false, reason: 'failed' });
    });
  });
}

/**
 * Close the window we opened.
 *
 * Used by `vt uninstall`: the pinned window holds an open browser profile
 * inside our data directory, and Windows will not let that directory be
 * removed while it is in use — the same lock that made stopping the daemon a
 * prerequisite rather than a courtesy.
 *
 * Killing a browser process is normally rude. This one is ours: we launched
 * it, into a profile we created, showing a page we serve, containing nothing
 * the user has typed. There is no session to lose.
 */
/** A synchronous pause. This is one-shot command code, not the event loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function closeMiniWindow(pid: number): boolean {
  let killed = false;
  try {
    process.kill(pid, 0); // Does it exist at all?
    killed = true;
  } catch {
    clearMiniState();
    return false;
  }

  if (process.platform === 'win32') {
    // A browser is a process *tree*: renderers, GPU, network service. Killing
    // only the parent leaves children holding files open in the profile, so
    // the directory stays locked and the uninstall it was closed for fails.
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killed = r.status === 0;
    // `taskkill` returns when it has asked, not when the kernel has finished.
    // Callers close this window in order to delete the directory it has open,
    // so returning early hands them a directory that is still locked.
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) sleepSync(50);
  } else {
    try {
      process.kill(pid);
    } catch {
      killed = false;
    }
  }

  clearMiniState();
  return killed;
}
