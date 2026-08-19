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
  CPU_TRUST_MULTIPLE,
  LOCAL_TOOL_PERMISSION_MS,
  RECENT_WRITE_MS,
  stallDeadline,
} from './thresholds.ts';
import { fmtAge, sinceMs } from './format.ts';
import { t, tr } from './i18n.ts';

/**
 * When this session last actually said something.
 *
 * The conversation's clock, not the file's. Claude Code appends bookkeeping
 * records -- `ai-title`, `mode`, `last-prompt`, `atis-latch` -- long after the
 * last turn, and none of them carries a timestamp of its own, so the file's
 * mtime moves while the conversation does not. Taking the newer of the two let
 * a touched file speak for a finished conversation: measured, session 62e054a9
 * last spoke on 17 August at 11:58 and had an `atis-latch` appended two and a
 * half days later, whereupon the board read it as `silent for 5m 7s`, brought
 * it back from ORPHANED to BUSY, and twenty-four seconds later announced it as
 * an agent waiting for you. Nothing had happened in that project at all.
 *
 * mtime is the fallback for a transcript no turn could be parsed out of -- an
 * adapter that reports no entries, a window that held none -- never a floor
 * under one that could.
 *
 * One function because there were three copies of the expression, in the
 * derivation and twice in the scan, and the wire field kept the file's clock
 * for a while after the derivation had stopped believing it.
 */
export function lastActivityOf(facts: TranscriptFacts): number {
  return facts.lastEntryAt ?? facts.mtimeMs;
}

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
 * 2. The process tree can confirm that work is in flight and can never deny
 *    it. A child spawned after the call began is that call's work, and saying
 *    so is worth doing. The mirror image -- no such child, therefore nothing
 *    is running, therefore something is blocked -- assumes the work is a
 *    descendant of the pid the session registered, and on an IDE-hosted
 *    session it simply is not: measured here, a live working session's
 *    registered pid had zero descendants while its shell ran elsewhere. So
 *    the tree is read for what it shows and never for what it fails to show.
 *
 * 3. WAITING_PERMISSION may be claimed only where the tool's own duration is
 *    the evidence -- a call that finishes in milliseconds and has not, after
 *    half a minute -- and never from the absence of a process. It is the one
 *    state that interrupts a person, so it is the one that has to be sure, and
 *    an absence proves nothing about a tree we may not even be looking at.
 *    Measured before this rule: seventeen false permission alarms in ninety
 *    minutes, all of them `Bash`, from a session doing nothing but running
 *    approved commands. A real gate on a shell command is reported by the hook
 *    that is told about it, which is exact.
 *
 *    CPU still refutes: a process blocked on a prompt burns nothing, so a
 *    reading above the line is consulted before any branch that would claim a
 *    gate. Measured: a session running a test suite at 20% cpu was called
 *    WAITING_PERMISSION three times in ten minutes.
 *
 * 4. And cpu expires. Past a wide multiple of a branch's own deadline the
 *    transcript is the only witness left, because anything still running would
 *    have written by now. `working` below is the single expression of that: a
 *    reading above the line, taken while a reading could still mean something.
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

  const lastActivity = lastActivityOf(facts);
  const ageMs = sinceMs(now, lastActivity);
  // Which line to measure against depends on which side we were on: it takes
  // CPU_BUSY_PCT to be called busy, and a fall below CPU_IDLE_PCT to stop
  // being called busy. See the thresholds for what a single line did.
  const cpuFloor = prevState === SessionState.Busy ? CPU_IDLE_PCT : CPU_BUSY_PCT;
  const busyCpu = cpuPct !== null && cpuPct >= cpuFloor;
  /**
   * Whether cpu is entitled to an opinion, given how long this has been quiet.
   *
   * The deadline differs by branch -- a `Bash` call may legitimately be silent
   * for twenty minutes, a thinking turn may not -- so it is asked per branch
   * rather than decided once.
   */
  const working = (deadline: number): boolean => busyCpu && ageMs <= deadline * CPU_TRUST_MULTIPLE;
  const openTool = facts.openTools[0];

  if (openTool) {
    evidence.push(t`tail:open tool ${openTool}`);
    const toolClass = classifyTool(openTool);
    const deadline = stallDeadline(openTool, true);

    if (ageMs < RECENT_WRITE_MS) {
      return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.8, evidence };
    }

    // A question, asked and unanswered. There is no deadline to wait out here
    // and nothing to measure: the tool blocks on a person, so the call is the
    // answer. Without this the branch fell through to the generic path and
    // announced STALLED seven and a half minutes later -- "alive, no progress,
    // this looks wrong" -- about an agent that was doing exactly the right
    // thing and waiting for you to read it.
    if (toolClass === 'blocks-on-human') {
      evidence.push(t`ask:${openTool} has been waiting on you for ${fmtAge(ageMs)}`);
      return {
        state: SessionState.WaitingInput,
        subReason: 'question',
        confidence: 0.9,
        evidence,
      };
    }

    // A tool that finishes in milliseconds does not stay open for half a
    // minute. When one does, the agent is not slow — it is sitting on a
    // permission prompt. No process tree is needed to know this, only the
    // certainty that a blocked process is not also a running one.
    if (!working(deadline) && toolClass === 'local-instant' && ageMs > LOCAL_TOOL_PERMISSION_MS) {
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
      } else {
        // No new descendant is not evidence of a permission prompt.
        //
        // The inference here used to be: a shell tool that spawns nothing is a
        // shell tool whose command never started, and a command that never
        // started is one waiting to be allowed. It assumed the work runs as a
        // child of the pid the session registered. Measured on this machine:
        // the registered pid of a live, working session has *zero*
        // descendants -- an IDE-hosted session runs its shell somewhere else
        // entirely -- so every Bash call it made looked like a permission
        // gate. Seventeen of them in ninety minutes, in one session, none of
        // them real. And WAITING_PERMISSION is the one state that interrupts
        // someone, so this was the most expensive place in the product to be
        // wrong.
        //
        // A tree that shows nothing now says nothing. The command is treated
        // as running until its own deadline says otherwise, which is the same
        // answer the tail would give without a probe at all. Real permission
        // gates are reported by the hook that knows -- `perm.request` -- which
        // is exact, and the capability matrix already tells a user without
        // hooks installed that this is what they are missing.
        evidence.push(
          descendants.total > 0
            ? t`proc:${descendants.total} descendants, none started since the call`
            : tr('proc:no descendants — the work is not under this pid'),
        );
      }
    }

    if (working(deadline)) {
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
  const thinkDeadline = stallDeadline(undefined, true);
  if (working(thinkDeadline)) {
    evidence.push(tr('tail:silent but burning cpu'));
    return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.7, evidence };
  }

  if (ageMs > thinkDeadline) {
    // Said plainly when there *was* cpu and it was disregarded, because
    // "no cpu" next to a reading of 4.5% is the kind of small lie that costs a
    // user an afternoon of not believing the rest of the screen.
    evidence.push(
      busyCpu
        ? t`stall:last=user, silent for ${fmtAge(ageMs)} — past what cpu can vouch for`
        : t`stall:last=user, silent for ${fmtAge(ageMs)}, no cpu`,
    );
    return { state: SessionState.Stalled, subReason: 'thinking', confidence: 0.6, evidence };
  }

  evidence.push(t`tail:last=${facts.lastEntryRole ?? 'unknown'}, silent for ${fmtAge(ageMs)}`);
  return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.5, evidence };
}
