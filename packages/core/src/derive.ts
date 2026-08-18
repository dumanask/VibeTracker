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
 */
export function deriveState(input: DeriveInput): DerivedState {
  const { liveness, facts, cpuPct, descendants, now } = input;
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
    evidence.push('tail:transcript-yok');
    return { state: SessionState.Starting, confidence: 0.6, evidence };
  }

  const lastActivity = Math.max(facts.lastEntryAt ?? 0, facts.mtimeMs);
  const ageMs = sinceMs(now, lastActivity);
  const busyCpu = cpuPct !== null && cpuPct >= CPU_BUSY_PCT;
  const openTool = facts.openTools[0];

  if (openTool) {
    evidence.push(t`tail:açık araç ${openTool}`);
    const toolClass = classifyTool(openTool);
    const deadline = stallDeadline(openTool, true);

    if (ageMs < RECENT_WRITE_MS) {
      return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.8, evidence };
    }

    // A tool that finishes in milliseconds does not stay open for half a
    // minute. When one does, the agent is not slow — it is sitting on a
    // permission prompt. No process tree is needed to know this.
    if (toolClass === 'local-instant' && ageMs > LOCAL_TOOL_PERMISSION_MS) {
      evidence.push(t`izin:yerel araç ${fmtAge(ageMs)} açık, milisaniyede bitmeliydi`);
      return {
        state: SessionState.WaitingPermission,
        subReason: `tool:${openTool}`,
        confidence: 0.75,
        evidence,
      };
    }

    if (toolClass === 'spawns-children' && descendants) {
      if (!descendants.startTimesKnown) {
        evidence.push(t`süreç:${descendants.total} alt süreç (başlangıç zamanı yok)`);
        if (descendants.total > 0) {
          return {
            state: SessionState.Busy,
            subReason: `tool:${openTool}`,
            confidence: 0.6,
            evidence,
          };
        }
      } else if (descendants.recent > 0) {
        evidence.push(t`süreç:${descendants.recent} yeni alt süreç çalışıyor`);
        if (ageMs > deadline) {
          evidence.push(t`stall:${fmtAge(ageMs)} ilerleme yok (sınır ${fmtAge(deadline)})`);
          return {
            state: SessionState.Stalled,
            subReason: `tool:${openTool}`,
            confidence: 0.7,
            evidence,
          };
        }
        return { state: SessionState.Busy, subReason: `tool:${openTool}`, confidence: 0.9, evidence };
      } else if (ageMs > SPAWN_GRACE_MS) {
        evidence.push(
          descendants.total > 0
            ? t`izin:yeni alt süreç yok (${descendants.total} eski alt süreç, muhtemelen MCP)`
            : tr('izin:hiç alt süreç yok, komut başlatılmamış'),
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
      evidence.push(t`stall:${fmtAge(ageMs)} ilerleme yok (sınır ${fmtAge(deadline)})`);
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
    evidence.push(t`tail:${fmtAge(ageMs)} önce yazdı`);
    return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.75, evidence };
  }

  if (facts.lastEntryRole === 'assistant') {
    evidence.push(t`tail:son=asistan, ${fmtAge(ageMs)} sessiz`);
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
    evidence.push(tr('tail:sessiz ama cpu yakıyor'));
    return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.7, evidence };
  }

  if (ageMs > stallDeadline(undefined, true)) {
    evidence.push(t`stall:son=kullanıcı, ${fmtAge(ageMs)} sessiz, cpu yok`);
    return { state: SessionState.Stalled, subReason: 'thinking', confidence: 0.6, evidence };
  }

  evidence.push(t`tail:son=${facts.lastEntryRole ?? 'bilinmiyor'}, ${fmtAge(ageMs)} sessiz`);
  return { state: SessionState.Busy, subReason: 'thinking', confidence: 0.5, evidence };
}
