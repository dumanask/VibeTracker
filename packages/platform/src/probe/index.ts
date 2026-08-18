import { platform } from 'node:os';
import type {
  Liveness,
  ProcessProbe,
  ProcessTreeEntry,
  ProcSnapshot,
  ProbePrecision,
} from '@vibetracker/shared';
import { WindowsProbe } from './windows.ts';
import { LinuxProbe } from './linux.ts';
import { DarwinProbe } from './darwin.ts';
import { DegradedProbe } from './degraded.ts';

export { WindowsProbe, LinuxProbe, DarwinProbe, DegradedProbe };

/** Pick the best probe for this OS. Never throws — falls back to the floor. */
export function createProcessProbe(): ProcessProbe {
  switch (platform()) {
    case 'win32':
      return new WindowsProbe();
    case 'linux':
      return new LinuxProbe();
    case 'darwin':
      return new DarwinProbe();
    default:
      return new DegradedProbe();
  }
}

export interface LivenessInput {
  pid: number;
  /** The agent's own record of when its process started, if it writes one. */
  procStart?: string;
}

export interface LivenessBatch {
  verdicts: Map<number, Liveness>;
  /** True when the agent records a start time we could compare against. */
  guardAvailable: boolean;
  /**
   * True when every comparable entry disagreed, which almost certainly means
   * the agent's start-time format differs from our probe's rather than that
   * every process was recycled. See `classifyLiveness`.
   */
  formatDriftSuspected: boolean;
  matched: number;
  mismatched: number;
  /**
   * PIDs that exist but would not say when they started.
   *
   * Counted separately from a mismatch because it is a different kind of
   * evidence — see `classifyLiveness`.
   */
  opaque: number;
}

/**
 * Minimum number of comparable, PID-present entries before a universal
 * mismatch is read as format drift rather than as genuine reuse. With one or
 * two entries, "all mismatched" is entirely plausible; with three or more it
 * is not.
 */
const DRIFT_MIN_SAMPLES = 3;

/**
 * Decide liveness for a batch of registry entries.
 *
 * Why this is a *batch* operation rather than per-entry: the start-time value
 * the agent writes has been observed to change format between patch releases
 * of the same agent on the same OS. A per-entry comparison would then mark
 * **every** session as `reused` — reporting zero live agents while thirteen are
 * running, which is far worse than the naive over-count it was meant to fix.
 *
 * The discriminator is the mix. If some entries match and others do not, the
 * two formats agree and the mismatches are real PID reuse (the measured case on
 * the reference machine: 13 matched, 3 mismatched). If *nothing* matches across
 * enough samples, our format assumption is wrong: report `live`, raise
 * `formatDriftSuspected`, and let the capability matrix tell the user the guard
 * is degraded.
 *
 * **A PID that will not say when it started has said enough.** The agent runs
 * as the user, so its own start time is always readable; a process that
 * withholds it is running as someone else and is therefore not our session.
 * Treating that silence as "cannot prove otherwise, call it live" is what put
 * a closed project on the board for six days: the PID had been recycled by a
 * `fontdrvhost.exe`, and the one case where reuse is most likely was the one
 * case the guard waved through. The same mix rule applies — silence only
 * counts as evidence when the probe demonstrably can read *some* start times,
 * so a probe that has lost the ability entirely degrades to `live` instead of
 * declaring every session dead.
 *
 * The start-time string is only ever compared for equality. It is never parsed,
 * never ordered, never displayed as a time.
 */
export function classifyLiveness(
  entries: LivenessInput[],
  snapshots: Map<number, ProcSnapshot>,
  precision: ProbePrecision,
): LivenessBatch {
  let comparable = 0;
  let matched = 0;
  let mismatched = 0;
  let opaque = 0;
  /** Start times the probe managed to read at all, across these PIDs. */
  let readable = 0;

  for (const e of entries) {
    const snap = snapshots.get(e.pid);
    if (!snap) continue;
    if (snap.startTime) readable++;
    if (!e.procStart) continue;
    if (!snap.startTime) {
      opaque++;
      continue;
    }
    comparable++;
    if (e.procStart === snap.startTime) matched++;
    else mismatched++;
  }

  const guardAvailable = precision !== 'none' && comparable + opaque > 0;
  const formatDriftSuspected =
    precision !== 'none' && comparable > 0 && matched === 0 && mismatched >= DRIFT_MIN_SAMPLES;
  const probeCanRead = readable > 0;

  const verdicts = new Map<number, Liveness>();
  for (const e of entries) {
    const snap = snapshots.get(e.pid);
    if (!snap) {
      verdicts.set(e.pid, 'dead');
      continue;
    }
    if (!guardAvailable || formatDriftSuspected || !e.procStart) {
      // Nothing to compare against: the PID exists and we cannot prove it is a
      // different process.
      verdicts.set(e.pid, 'live');
      continue;
    }
    if (!snap.startTime) {
      // Something to compare against, and a process that will not be compared.
      verdicts.set(e.pid, probeCanRead ? 'reused' : 'live');
      continue;
    }
    verdicts.set(e.pid, e.procStart === snap.startTime ? 'live' : 'reused');
  }

  return { verdicts, guardAvailable, formatDriftSuspected, matched, mismatched, opaque };
}

// ── process-tree analysis ─────────────────────────────────────────────────

export interface DescendantSummary {
  /** Every process below `rootPid`, transitively. */
  total: number;
  /**
   * Descendants that started after the reference instant — i.e. that were
   * spawned for the work currently in flight rather than at session startup.
   */
  recent: number;
  /** False when the platform could not supply start times, making `recent` meaningless. */
  startTimesKnown: boolean;
}

/**
 * Summarize the descendants of a session process.
 *
 * Why `recent` matters and a plain child count does not: an agent with MCP
 * servers configured spawns them as long-lived children at session start and
 * keeps them for the session's whole life. Such a session ALWAYS has children,
 * so "has children ⇒ a command is running" would be wrong for every user with
 * MCP configured — which is most of them.
 *
 * The discriminator is age. A child spawned after the tool call began is that
 * call's work; a child that predates it is infrastructure. This needs only
 * parentage and start time, never a command line.
 */
export function summarizeDescendants(
  tree: Map<number, ProcessTreeEntry>,
  rootPid: number,
  sinceMs: number | null,
): DescendantSummary {
  const childrenOf = new Map<number, number[]>();
  for (const node of tree.values()) {
    const list = childrenOf.get(node.ppid);
    if (list) list.push(node.pid);
    else childrenOf.set(node.ppid, [node.pid]);
  }

  let total = 0;
  let recent = 0;
  let startTimesKnown = false;

  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const child of childrenOf.get(pid) ?? []) {
      // Guard against a cycle from a recycled PID appearing as its own ancestor.
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
      total++;
      const node = tree.get(child);
      if (node?.startMs != null) {
        startTimesKnown = true;
        if (sinceMs === null || node.startMs >= sinceMs) recent++;
      }
    }
  }

  return { total, recent, startTimesKnown };
}
