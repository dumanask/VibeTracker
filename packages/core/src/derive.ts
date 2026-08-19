import {
  SessionState,
  classifyTool,
  type DescendantSummaryLike,
  type Liveness,
  type SessionStateName,
  type TranscriptFacts,
} from '@vibetracker/shared';
import {
  CPU_BUSY_PCT,
  CPU_IDLE_PCT,
  LOCAL_TOOL_PERMISSION_MS,
  RECENT_WRITE_MS,
  SPAWN_GRACE_MS,
  stallDeadline,
} from './thresholds.ts';
import { fmtAge, sinceMs } from './format.ts';
import { t, tr } from './i18n.ts';

export interface DeriveInput {
  liveness: Liveness;
  facts: TranscriptFacts | null;
  /** One-core-normalized CPU over the sample window, or null if not sampled. */
  cpuPct: number | null;
  /** Descendant summary of the session process, or null when unavailable. */
  descendants: DescendantSummaryLike | null;
  /**
   * What this session was called on the previous pass, or null on the first.
   *
   * Only the cpu test reads it, and only to pick which side of the hysteresis
   * band applies. It is deliberately not a fallback or a prior: nothing here
   * carries a state forward because it is convenient, and a session with no
   * history is derived exactly as it is today.
   */
  prevState: SessionStateName | null;
  now: number;
}

export interface DerivedState {
  state: SessionStateName;
  subReason?: string;
  confidence: number;
  /** Why we believe it. Rendered verbatim; never invented, never generic. */
  evidence: string[];
}

/**
 * Passive state derivation: transcript + process facts only, no hook events.
 *
 * The ordering of the branches is the design. Two rules earn their place:
 *
 * 1. Turn ownership is decided by the transcript, not by CPU. CPU tells you
 *    whether *work* is happening; the transcript tells you whose *turn* it is.
 *    Once the assistant has finished a message and nothing followed, the ball
 *    is with the human however much CPU the process burns on its timers.
 *
 * 2. For a tool whose work happens in a child process, the agent's own CPU is
 *    0% whether the command is running or it is blocked on approval. Only the
 *    process tree separates those two, and only by age: a child spawned after
 *    the call began is the work, an older one is infrastructure (MCP servers
 *    live for the whole session, so "has children" alone means nothing).
 *
 * 3. ...but the converse of that is absolute, and cheap. A process blocked on
 *    a prompt burns nothing. So cpu can never *prove* a permission gate and can
 *    always *refute* one, and it is consulted before every branch that would
 *    claim one. Measured: a session running a test suite at 20% cpu was called
 *    WAITING_PERMISSION three times in ten minutes, because the tree said no
 *    child had started since the call -- true, and irrelevant, because the work
 *    was not a descendant of the pid we were watching.
 */
export function deriveState(input: DeriveInput): DerivedState {
  const { liveness, facts, cpuPct, descendants, prevState, now } = input;
  const evidence: string[] = [];

  if (liveness === 'dead') {
    evidence.push('proc:gone');
    return { state: SessionState.Orphaned, confidence: 0.95, evidence };
  }
  if (liveness === 'reused') {
    evidence.push('proc:pid-reused');
    return { state: SessionState.Orphaned, confidence: 0.95, evidence };
  }
  evidence.push('proc:live');
  if (cpuPct !== null) evidence.push(t`proc:cpu ${cpuPct.toFixed(1)}%`);

  if (!facts) {
    evidence.push('tail:no-transcript');
    return { state: SessionState.Starting, confidence: 0.6, evidence };
  }

  const lastActivity = Math.max(facts.lastEntryAt ?? 0, facts.mtimeMs);
  const ageMs = sinceMs(now, lastActivity);
  // Which line to measure against depends on which side we were on: it takes
  // CPU_BUSY_PCT to be called busy, and a fall below CPU_IDLE_PCT to stop
  // being called busy. See the thresholds for what a single line did.
  const cpuFloor = prevState === SessionState.Busy ? CPU_IDLE_PCT : CPU_BUSY_PCT;
  const busyCpu = cpuPct !== null && cpuPct >= cpuFloor;
  const openTool = facts.openTools[0];

  if (openTool) {
    evidence.push(t`tail:open tool ${openTool}`);
    const toolClass = classifyTool(openTool);
    const deadline = stallDeadline(openTool, true);

    if (ageMs < RECENT_WRITE_MS) {
      return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.8, evidence };
    }

    // A tool that finishes in milliseconds does not stay open for half a
    // minute. When one does, the agent is not slow — it is sitting on a
    // permission prompt. No process tree is needed to know this, only the
    // certainty that a blocked process is not also a running one.
    if (!busyCpu && toolClass === 'local-instant' && ageMs > LOCAL_TOOL_PERMISSION_MS) {
      evidence.push(t`perm:local tool open for ${fmtAge(ageMs)}, should finish in milliseconds`);
      return {
        state: SessionState.WaitingPermission,
        subReason: `tool:${openTool}`,
        confidence: 0.75,
        evidence,
      };
    }

    if (toolClass === 'spawns-children' && descendants) {
      if (!descendants.startTimesKnown) {
        evidence.push(t`proc:${descendants.total} descendants (no start time)`);
        if (descendants.total > 0) {
          return {
            state: SessionState.Busy,
            subReason: `tool:${openTool}`,
            confidence: 0.6,
            evidence,
          };
        }
      } else if (descendants.recent > 0) {
        evidence.push(t`proc:${descendants.recent} new descendants running`);
        if (ageMs > deadline) {
          evidence.push(t`stall:no progress for ${fmtAge(ageMs)} (limit ${fmtAge(deadline)})`);
          return {
            state: SessionState.Stalled,
            subReason: `tool:${openTool}`,
            confidence: 0.7,
            evidence,
          };
        }
        return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.9, evidence };
      } else if (ageMs > SPAWN_GRACE_MS && !busyCpu) {
        evidence.push(
          descendants.total > 0
            ? t`perm:no new descendants (${descendants.total} older ones, probably MCP)`
            : tr('perm:no descendants at all, the command never started'),
        );
        return {
          state: SessionState.WaitingPermission,
          subReason: `tool:${openTool}`,
          confidence: 0.65,
          evidence,
        };
      }
    }

    if (busyCpu) {
      return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.8, evidence };
    }
    if (ageMs > deadline) {
      evidence.push(t`stall:no progress for ${fmtAge(ageMs)} (limit ${fmtAge(deadline)})`);
      return {
        state: SessionState.Stalled,
        subReason: `tool:${openTool}`,
        confidence: 0.7,
        evidence,
      };
    }
    return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.7, evidence };
  }

  if (ageMs < RECENT_WRITE_MS) {
    evidence.push(t`tail:wrote ${fmtAge(ageMs)} ago`);
    return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.75, evidence };
  }

  if (facts.lastEntryRole === 'assistant') {
    evidence.push(t`tail:last=assistant, silent for ${fmtAge(ageMs)}`);
    return {
      state: SessionState.WaitingInput,
      subReason: 'turn_complete',
      confidence: 0.8,
      evidence,
    };
  }

  // A turn is in flight. Here CPU is the real discriminator: a long
  // extended-thinking turn writes nothing for minutes while still burning CPU.
  // Silence plus no CPU is a hang.
  if (busyCpu) {
    evidence.push(tr('tail:silent but burning cpu'));
    return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.7, evidence };
  }

  if (ageMs > stallDeadline(undefined, true)) {
    evidence.push(t`stall:last=user, silent for ${fmtAge(ageMs)}, no cpu`);
    return { state: SessionState.Stalled, subReason: 'thinking', confidence: 0.6, evidence };
  }

  evidence.push(t`tail:last=${facts.lastEntryRole ?? 'unknown'}, silent for ${fmtAge(ageMs)}`);
  return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.5, evidence };
}
