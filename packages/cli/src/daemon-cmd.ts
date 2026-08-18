import {
  AlreadyRunningError,
  Daemon,
  PortTakenError,
  logFilePath,
  readRuntimeInfo,
  runtimeFilePath,
} from '@vibetracker/daemon';
import { t, tr } from '@vibetracker/core';

export interface DaemonArgs {
  port?: number;
  intervalMs?: number;
  open: boolean;
}

/** Run the daemon in the foreground until interrupted. */
export async function runDaemon(args: DaemonArgs): Promise<number> {
  const daemon = new Daemon({
    port: args.port,
    scanIntervalMs: args.intervalMs,
  });

  try {
    await daemon.start();
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      const info = readRuntimeInfo();
      process.stderr.write(`${err.message}\n`);
      if (info) process.stderr.write(t`Panel: ${dashboardUrl(info.port, info.token)}\n`);
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
  process.stdout.write(t`VibeTracker çalışıyor · ${url}\n`);
  process.stdout.write(t`Durdurmak için Ctrl+C. Çalışma bilgisi: ${runtimeFilePath()}\n`);
  process.stdout.write(t`Günlük: ${logFilePath()}\n`);
  if (args.open) await openBrowser(url);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.stdout.write(tr('\nkapatılıyor…\n'));
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
    process.stderr.write(tr('Daemon çalışmıyor. Önce `vt daemon` çalıştır.\n'));
    return 3;
  }
  const url = dashboardUrl(info.port, info.token);
  process.stdout.write(`${url}\n`);
  await openBrowser(url);
  return 0;
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the URL is already printed; the user can open it themselves */
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
    process.stdout.write(tr('Daemon çalışmıyor.\n'));
    return 3;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/v1/shutdown`, {
      method: 'POST',
      headers: { 'X-VT-Token': info.token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      process.stderr.write(t`Daemon durdurulamadı: HTTP ${res.status}\n`);
      return 70;
    }
  } catch {
    // The runtime file can outlive the process it describes — a hard kill, a
    // power cut. Saying "not running" is more useful than reporting a network
    // error about a daemon that is already gone.
    process.stdout.write(t`Daemon cevap vermiyor (pid ${info.pid}) — muhtemelen zaten kapalı.\n`);
    return 3;
  }

  // A 200 means "I heard you", not "I am gone". Windows holds the database
  // file locked until the process actually exits, and `vt uninstall` deletes
  // that file the instant this returns — which failed with EBUSY until we
  // waited for the pid instead of for the acknowledgement.
  if (!(await waitForExit(info.pid, 8000))) {
    process.stderr.write(t`Daemon cevap verdi ama hâlâ kapanmadı (pid ${info.pid}).\n`);
    return 70;
  }

  process.stdout.write(t`Daemon durduruldu (pid ${info.pid}).\n`);
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
