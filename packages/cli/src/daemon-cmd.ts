import {
  AlreadyRunningError,
  Daemon,
  PortTakenError,
  logFilePath,
  readRuntimeInfo,
  runtimeFilePath,
} from '@vibetracker/daemon';
import { loadConfig } from '@vibetracker/platform';
import { t, tr } from '@vibetracker/core';

export interface DaemonArgs {
  port?: number;
  intervalMs?: number;
  open: boolean;
}

/**
 * Run the daemon in the foreground until interrupted.
 *
 * This is where `[server]` stops being a description and becomes the daemon's
 * options. It used to be neither: `port`, `bind` and `interval_ms` were parsed
 * and validated and then read by nothing, so `vt config check` printed an
 * address the daemon had never been told about.
 *
 * A flag still beats the file -- `--port` is what you reach for when the file
 * is the thing you are trying to work around -- and the file beats the
 * built-in default.
 */
export async function runDaemon(args: DaemonArgs): Promise<number> {
  const { config } = await loadConfig();
  const daemon = new Daemon({
    port: args.port ?? config.server.port,
    host: config.server.bind,
    scanIntervalMs: args.intervalMs ?? config.server.interval_ms,
  });

  try {
    await daemon.start();
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      const info = readRuntimeInfo();
      process.stderr.write(`${err.message}\n`);
      if (info) process.stderr.write(t`Dashboard: ${dashboardUrl(info.port, info.token)}\n`);
      return 3;
    }
    if (err instanceof PortTakenError) {
      process.stderr.write(`${err.message}\n`);
      return 4;
    }
    throw err;
  }

  const info = readRuntimeInfo();
  const url = info ? dashboardUrl(info.port, info.token) : `http://127.0.0.1:${daemon.port}/`;
  process.stdout.write(t`VibeTracker running · ${url}\n`);
  process.stdout.write(t`Ctrl+C to stop. Runtime info: ${runtimeFilePath()}\n`);
  process.stdout.write(t`Log: ${logFilePath()}\n`);
  if (args.open) await openBrowser(url);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.stdout.write(tr('\nshutting down…\n'));
      void daemon.stop().then(resolve, resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

/**
 * The token is in the URL because the dashboard is opened by a browser that
 * cannot be given a header. It never leaves the machine: the page is
 * loopback-only, sends `Referrer-Policy: no-referrer`, and no CORS headers are
 * emitted, so nothing can read it cross-origin.
 */
export function dashboardUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
}

export async function openDashboard(): Promise<number> {
  const info = readRuntimeInfo();
  if (!info) {
    process.stderr.write(tr('The daemon is not running. Start it with `vt daemon`.\n'));
    return 3;
  }
  const url = dashboardUrl(info.port, info.token);
  process.stdout.write(`${url}\n`);
  await openBrowser(url);
  return 0;
}

/**
 * Hand a URL to whatever opens URLs here.
 *
 * The previous version wrapped one `spawn` in a `try`, which catches nothing:
 * a missing program is reported through an asynchronous `'error'` event, and
 * an `'error'` nobody listens for takes the process down. So on a machine
 * without `xdg-utils` — a minimal server, a bare window manager, a container —
 * `vt open` printed the URL, did its work, and then died with a stack trace.
 * Verified rather than assumed: the same shape crashes on this machine too.
 *
 * Hence a list rather than a single command. Linux has no one answer;
 * `xdg-open` is the convention, `gio open` is what GNOME actually ships,
 * `wslview` is how a WSL shell reaches the Windows browser, and
 * `sensible-browser` is Debian's fallback. The URL is already on stdout before
 * any of this runs, so the worst case is that the user clicks it themselves.
 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');

  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : process.platform === 'darwin'
        ? [['open', [url]]]
        : [
            ['xdg-open', [url]],
            ['gio', ['open', url]],
            ['wslview', [url]],
            ['sensible-browser', [url]],
          ];

  const tryOne = ([cmd, args]: [string, string[]]): Promise<boolean> =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      // Both listeners are required. `'error'` is the one that would otherwise
      // be fatal; `'spawn'` is how we know the program exists without waiting
      // for it to exit, which a browser launcher may never do.
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });

  for (const attempt of attempts) {
    if (await tryOne(attempt)) return;
  }
}

/**
 * `vt daemon stop`.
 *
 * A background process the installing tool cannot stop is not a finished
 * product — the user is left to find it in a task manager. We ask the daemon
 * to stop itself over the authenticated loopback API rather than sending it a
 * signal: on Windows a signal is an abrupt termination, and this daemon holds
 * a SQLite WAL and a set of transcript handles that deserve a clean close.
 */
export async function stopDaemon(): Promise<number> {
  const info = readRuntimeInfo();
  if (!info) {
    process.stdout.write(tr('The daemon is not running.\n'));
    return 3;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/v1/shutdown`, {
      method: 'POST',
      headers: { 'X-VT-Token': info.token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      process.stderr.write(t`Could not stop the daemon: HTTP ${res.status}\n`);
      return 70;
    }
  } catch {
    // The runtime file can outlive the process it describes — a hard kill, a
    // power cut. Saying "not running" is more useful than reporting a network
    // error about a daemon that is already gone.
    process.stdout.write(t`The daemon is not answering (pid ${info.pid}) — it has probably already stopped.\n`);
    return 3;
  }

  // A 200 means "I heard you", not "I am gone". Windows holds the database
  // file locked until the process actually exits, and `vt uninstall` deletes
  // that file the instant this returns — which failed with EBUSY until we
  // waited for the pid instead of for the acknowledgement.
  if (!(await waitForExit(info.pid, 8000))) {
    process.stderr.write(t`The daemon answered but has still not exited (pid ${info.pid}).\n`);
    return 70;
  }

  process.stdout.write(t`Daemon stopped (pid ${info.pid}).\n`);
  return 0;
}

/** Signal 0 delivers nothing; it only asks whether the pid still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}
