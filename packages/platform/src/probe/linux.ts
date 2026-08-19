import { readFile, readdir } from 'node:fs/promises';
import type {
  ProcessProbe,
  ProcessTreeEntry,
  ProcSnapshot,
  ProbePrecision,
} from '@vibetracker/shared';

/**
 * Linux probe. The cheapest of the three: pure file reads from /proc, no child
 * process at any point.
 *
 * `/proc/<pid>/stat` layout (1-based fields):
 *   1 pid, 2 comm, 3 state, ... 14 utime, 15 stime, ... 22 starttime, ... 24 rss
 *
 * `comm` is the executable name in parentheses and may itself contain spaces
 * and parentheses, so the split point is the LAST ')' in the line — splitting
 * on whitespace from the left is a classic bug here.
 */

// USER_HZ. Effectively always 100 on Linux. We only ever use CPU *deltas* and
// compare against a percentage threshold, so a wrong constant would scale all
// values equally rather than change any verdict.
const USER_HZ = 100;
const NS_PER_TICK = 1_000_000_000 / USER_HZ;
const PAGE_SIZE = 4096;

/**
 * Split one `/proc/<pid>/stat` line into its fields, after `comm`.
 *
 * Exported and pure so the field arithmetic can be tested from any machine.
 * The parsing here is the whole probe — everything else is `readFile` — and
 * an off-by-one in it would report every process as having zero CPU, which
 * reads on the board as "nothing is running" rather than as a broken reader.
 */
export function statFields(raw: string): string[] | null {
  // `comm` is the executable name in parentheses and may itself contain spaces
  // and parentheses — `(my app (2))` is a legal process name — so the split
  // point is the LAST ')' in the line. Splitting on whitespace from the left
  // is the classic bug here, and it is silent: the fields shift by however
  // many spaces happen to be in the name.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).trim();
  if (!rest) return null;
  return rest.split(/\s+/);
}

/** One process, from the text of its `stat` file. */
export function parseStat(pid: number, raw: string): ProcSnapshot | null {
  const rest = statFields(raw);
  if (!rest) return null;
  // rest[0] is field 3, so field N is rest[N - 3].
  const at = (field: number): number => Number(rest[field - 3] ?? 0);

  const starttime = rest[22 - 3];
  if (starttime === undefined) return null;

  return {
    pid,
    startTime: starttime, // jiffies since boot; compared for equality only
    startTimeKind: 'jiffies',
    cpuNs: Math.round((at(14) + at(15)) * NS_PER_TICK),
    rss: at(24) * PAGE_SIZE,
  };
}

/** Parent and start time, from the same line. */
export function parseStatTree(
  pid: number,
  raw: string,
  bootMs: number | null,
): ProcessTreeEntry | null {
  const rest = statFields(raw);
  if (!rest) return null;
  const ppid = Number(rest[4 - 3] ?? 0);
  const startTicks = Number(rest[22 - 3] ?? 0);
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    startMs:
      bootMs !== null && Number.isFinite(startTicks)
        ? bootMs + (startTicks / USER_HZ) * 1000
        : null,
  };
}

export class LinuxProbe implements ProcessProbe {
  readonly kind = 'linux-proc';
  readonly precision: ProbePrecision = 'exact';
  broken = false;

  async snapshot(pids: number[]): Promise<Map<number, ProcSnapshot>> {
    const out = new Map<number, ProcSnapshot>();
    await Promise.all(
      pids.map(async (pid) => {
        let raw: string;
        try {
          raw = await readFile(`/proc/${pid}/stat`, 'utf8');
        } catch {
          return; // Process gone, or we lack permission. Absence means "not live".
        }
        const parsed = parseStat(pid, raw);
        if (parsed) out.set(pid, parsed);
      }),
    );
    return out;
  }

  async listTree(): Promise<Map<number, ProcessTreeEntry> | null> {
    const bootMs = await readBootTimeMs();
    let names: string[];
    try {
      names = await readdir('/proc');
    } catch {
      return null;
    }
    const out = new Map<number, ProcessTreeEntry>();
    await Promise.all(
      names.map(async (name) => {
        const pid = Number(name);
        if (!Number.isInteger(pid) || pid <= 0) return;
        let raw: string;
        try {
          raw = await readFile(`/proc/${pid}/stat`, 'utf8');
        } catch {
          return; // exited between readdir and read — normal, not an error
        }
        const entry = parseStatTree(pid, raw, bootMs);
        if (entry) out.set(pid, entry);
      }),
    );
    return out;
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

/** Boot time in ms since epoch, from `/proc/stat`'s `btime` line. */
async function readBootTimeMs(): Promise<number | null> {
  try {
    const stat = await readFile('/proc/stat', 'utf8');
    const m = stat.match(/^btime\s+(\d+)/m);
    return m?.[1] ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}
