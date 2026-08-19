import { execFile } from 'node:child_process';
import type {
  ProcessProbe,
  ProcessTreeEntry,
  ProcSnapshot,
  ProbePrecision,
} from '@vibetracker/shared';

/**
 * macOS probe. One `ps` call per snapshot covering every process.
 *
 * There is no /proc, and reading a process's start time properly would need
 * `proc_pidinfo` via a native addon — which we deliberately avoid so that the
 * package has zero native dependencies and installs everywhere.
 *
 * Consequence, stated honestly: `ps -o lstart` has **one-second granularity**,
 * so `precision` is `second`. A PID recycled within the same second as the
 * original process's start can evade the reuse guard. This is a documented
 * platform limitation surfaced in the capability matrix, not a silent gap.
 */

const PS_TIMEOUT_MS = 5000;

function parseCpuToNs(t: string): number {
  // Accepted shapes: SS.ss | MM:SS.ss | HH:MM:SS.ss | DD-HH:MM:SS
  let s = t.trim();
  let days = 0;
  const dash = s.indexOf('-');
  if (dash > 0) {
    days = Number(s.slice(0, dash)) || 0;
    s = s.slice(dash + 1);
  }
  const parts = s.split(':').map((p) => Number(p) || 0);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  seconds += days * 86400;
  return Math.round(seconds * 1_000_000_000);
}

/**
 * `pid=,lstart=,time=,rss=` output, one process per line.
 *
 * Exported and pure: this is the entire probe apart from the `ps` call, and it
 * has never run on the platform it is for. A test can at least pin the shape —
 * `lstart` is five whitespace-separated words sitting in the *middle* of the
 * line, so the fields have to be read from both ends, and getting that wrong
 * silently produces a start-time string that never matches anything and marks
 * every session as a recycled pid.
 */
export function parsePsSnapshot(
  stdout: string,
  wanted?: ReadonlySet<number>,
): Map<number, ProcSnapshot> {
  const out = new Map<number, ProcSnapshot>();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const tokens = t.split(/\s+/);
    if (tokens.length < 4) continue;
    const pid = Number(tokens[0]);
    if (!Number.isInteger(pid)) continue;
    if (wanted && !wanted.has(pid)) continue;

    const rss = Number(tokens[tokens.length - 1]) || 0; // KiB
    const cpu = tokens[tokens.length - 2] ?? '0';
    const lstart = tokens.slice(1, tokens.length - 2).join(' ');
    if (!lstart) continue;

    out.set(pid, {
      pid,
      startTime: lstart, // e.g. "Sun Aug 17 22:04:33 2026"; equality only
      startTimeKind: 'lstart',
      cpuNs: parseCpuToNs(cpu),
      rss: rss * 1024,
    });
  }
  return out;
}

/** `pid=,ppid=,lstart=` output. */
export function parsePsTree(stdout: string): Map<number, ProcessTreeEntry> {
  const out = new Map<number, ProcessTreeEntry>();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const tokens = t.split(/\s+/);
    if (tokens.length < 3) continue;
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    if (!Number.isInteger(pid)) continue;
    // Parsed under `LC_ALL=C`, which is why this can be `Date.parse` at all.
    const parsed = Date.parse(tokens.slice(2).join(' '));
    out.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      startMs: Number.isFinite(parsed) ? parsed : null,
    });
  }
  return out;
}

export class DarwinProbe implements ProcessProbe {
  readonly kind = 'darwin-ps';
  readonly precision: ProbePrecision = 'second';
  broken = false;

  async snapshot(pids: number[]): Promise<Map<number, ProcSnapshot>> {
    if (pids.length === 0) return new Map();
    const stdout = await ps(['-axo', 'pid=,lstart=,time=,rss=']);
    return parsePsSnapshot(stdout, new Set(pids));
  }

  async listTree(): Promise<Map<number, ProcessTreeEntry> | null> {
    let stdout: string;
    try {
      stdout = await ps(['-axo', 'pid=,ppid=,lstart=']);
    } catch {
      return null;
    }
    return parsePsTree(stdout);
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

/**
 * `ps`, in a locale we can read.
 *
 * `lstart` prints day and month *names*, and `ps` writes them in the user's
 * locale: `Paz Ağu 17 22:04:33 2026` under `tr_TR`. Two things break on that.
 * `Date.parse` returns NaN, so the process tree loses every start time — the
 * input to descendant grouping. And the string is stored as the reuse guard's
 * comparison key, so a machine whose locale changes between runs compares
 * yesterday's Turkish against today's English and calls every session a
 * recycled pid.
 *
 * `LC_ALL=C` costs nothing and makes the output the same everywhere. The rest
 * of the environment is inherited: overriding it wholesale would drop `PATH`
 * and leave `ps` unfindable.
 */
function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      args,
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}
