/**
 * One line per project: what its agents are doing, and how far it has got.
 *
 * The detailed card answers "what exactly is happening"; this answers the
 * question you actually have twenty times a day — *is anything waiting for
 * me?* — for a dozen projects at a glance. It exists in core rather than in
 * each renderer because the terminal, the dashboard and the pinned window must
 * not be able to disagree about it: two surfaces showing different counts for
 * the same project is worse than either being wrong on its own.
 *
 * The order is fixed and is a priority, not a preference. Waiting outranks
 * running because waiting is the state that costs the user time.
 */
import {
  interrupts,
  needsYou,
  type AgentSummary,
  type AgentSummaryKind,
  type BoardLoad,
  type ProjectView,
  type SessionStateName,
} from '@vibetracker/shared';
import { urgencyOf } from './project.ts';

export type { AgentSummary, AgentSummaryKind, BoardLoad };

const DEAD: ReadonlySet<SessionStateName> = new Set<SessionStateName>([
  'ORPHANED',
  'ENDED',
  'UNKNOWN',
]);

export function summarizeAgents(p: Pick<ProjectView, 'sessions'>): AgentSummary {
  const waiting = p.sessions.filter((s) => needsYou(s.state));
  const blocked = waiting.filter((s) => interrupts(s.state));
  const running = p.sessions.filter((s) => s.state === 'BUSY');
  const live = p.sessions.filter((s) => !DEAD.has(s.state));

  // Among the waiting, the most urgent first, then the one waiting longest:
  // a permission prompt outranks a finished turn, and an old block outranks
  // a fresh one.
  const lead = [...waiting].sort(
    (a, b) =>
      urgencyOf(b.state) - urgencyOf(a.state) ||
      (a.stateSince ?? a.lastActivityAt ?? 0) - (b.stateSince ?? b.lastActivityAt ?? 0),
  )[0];

  const kind: AgentSummaryKind =
    waiting.length > 0 ? 'waiting' : running.length > 0 ? 'running' : live.length > 0 ? 'idle' : 'none';

  return {
    kind,
    waiting: waiting.length,
    blocked: blocked.length,
    running: running.length,
    live: live.length,
    total: p.sessions.length,
    urgency: lead ? urgencyOf(lead.state) : 0,
    leadSessionId: lead?.sessionId,
    leadSince: lead?.stateSince ?? lead?.lastActivityAt,
    leadTitle: lead?.title ?? lead?.lastPrompt,
  };
}

/**
 * Sort key for the compact list.
 *
 * Deliberately simpler than `attentionScore`, which weighs momentum, risk and
 * drift for the detailed board. Here the only promise is that anything wanting
 * the user is above anything that does not, because a list you scan in one
 * second cannot afford a subtle ordering nobody can predict.
 */
export function compactRank(p: ProjectView): number {
  const s = p.summary ?? summarizeAgents(p);
  if (s.kind === 'waiting') return 1000 + s.urgency * 10 + Math.min(s.waiting, 9);
  if (s.kind === 'running') return 500 + Math.min(s.running, 9);
  if (s.kind === 'idle') return 100;
  return 0;
}

/**
 * The whole board in one bar: how much of your agent fleet is engaged.
 *
 * Deliberately *not* an overall completion percentage. Averaging progress
 * across projects is the most misleading number a tracker can print — a plan
 * that grows makes it fall while work is being done — so the strip along the
 * top answers a question that actually has an answer: of the agent sessions
 * that are alive right now, what share is either working or blocked on you.
 *
 * Split into its two halves rather than summed, because "everything is
 * running" and "everything is blocked" are the same load and opposite
 * situations. Null when nothing is alive: a full-width empty channel is a
 * statement, a zero-length bar is a claim of idleness we have not measured.
 */
export function summarizeBoard(summaries: AgentSummary[]): BoardLoad {
  let live = 0;
  let waiting = 0;
  let running = 0;
  for (const s of summaries) {
    live += s.live;
    waiting += s.waiting;
    running += s.running;
  }
  // Clamped because the two counts come from different predicates: a session
  // could in principle satisfy both, and a bar past its own end reads as a
  // rendering bug rather than as the arithmetic it is.
  const engaged = Math.min(waiting + running, live);
  return { live, waiting, running, percent: live > 0 ? (engaged / live) * 100 : null };
}
