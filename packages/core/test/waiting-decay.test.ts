/**
 * A turn that ended two days ago is not waiting for you.
 *
 * Read off the running board: AgentWorld reported `3 waiting`, and one of the
 * three had finished its last turn two days and nine hours earlier. The count
 * is the number the whole product exists to put on a screen -- it is what the
 * tray badge shows, what the pinned note shows and what the first line of the
 * dashboard shows -- and weighing a session from Tuesday the same as one that
 * finished a minute ago is how it stops meaning anything.
 *
 * WAITING_INPUT is how every turn of every agent ends, so on a machine that has
 * been running agents all week the state alone can only grow. What decays is
 * the claim on attention, never the state: the board still says WAITING_INPUT
 * and now says `2d 9h` beside it, which is the sentence that tells you to close
 * the session rather than answer it.
 *
 * A block never decays. An agent stopped at a permission prompt is stopped
 * until you answer it, whether that is one minute or one day, and that set is
 * also the only one allowed to make a sound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectView, SessionView } from '@vibetracker/shared';
import { awaitsAttention, summarizeAgents } from '../src/summary.ts';
import { WAITING_ATTENTION_MS } from '../src/thresholds.ts';

const NOW = 1_800_000_000_000;

function session(over: Partial<SessionView>): SessionView {
  return {
    sessionId: 'aaaaaaaa-bbbb',
    pid: 1,
    state: 'BUSY',
    confidence: 0.9,
    evidence: [],
    openTools: [],
    cwd: 'c:/x',
    normPath: 'c:/x',
    liveness: 'live',
    ...over,
  } as SessionView;
}

test('a turn that has just ended is waiting for you', () => {
  const s = session({ state: 'WAITING_INPUT', lastActivityAt: NOW - 4 * 60_000 });
  assert.equal(awaitsAttention(s, NOW), true);
});

test('a turn that ended two days ago is not', () => {
  // The measured case: 2d 9h, counted beside a four-minute-old one.
  const s = session({ state: 'WAITING_INPUT', lastActivityAt: NOW - (2 * 24 + 9) * 60 * 60_000 });
  assert.equal(awaitsAttention(s, NOW), false);
});

test('the line is where the threshold says, from both sides', () => {
  const at = (age: number) => session({ state: 'WAITING_INPUT', lastActivityAt: NOW - age });
  assert.equal(awaitsAttention(at(WAITING_ATTENTION_MS - 1), NOW), true);
  assert.equal(awaitsAttention(at(WAITING_ATTENTION_MS + 1), NOW), false);
});

test('a block does not decay, however old', () => {
  // A permission prompt from last week is still a permission prompt, and this
  // is the set that is allowed to interrupt someone.
  const s = session({ state: 'WAITING_PERMISSION', lastActivityAt: NOW - 7 * 24 * 60 * 60_000 });
  assert.equal(awaitsAttention(s, NOW), true);
});

test('an unknown age is counted, not dropped', () => {
  // Silence about a wait we cannot date is the one failure that hides
  // something real; the other direction only overcounts.
  const s = session({ state: 'WAITING_INPUT', lastActivityAt: undefined });
  assert.equal(awaitsAttention(s, NOW), true);
});

test('a working session is not waiting for anything', () => {
  assert.equal(awaitsAttention(session({ state: 'BUSY', lastActivityAt: NOW }), NOW), false);
});

test('the project line counts what it says it counts', () => {
  // The board that prompted this, in miniature: three sessions, one of them
  // parked. `live` and `total` are unchanged -- the session did not vanish,
  // it stopped asking for you.
  const p = {
    sessions: [
      session({ sessionId: 'a', state: 'WAITING_INPUT', lastActivityAt: NOW - 4 * 60_000 }),
      session({ sessionId: 'b', state: 'WAITING_INPUT', lastActivityAt: NOW - 3 * 24 * 60 * 60_000 }),
      session({ sessionId: 'c', state: 'BUSY', lastActivityAt: NOW }),
    ],
  } as Pick<ProjectView, 'sessions'>;
  const a = summarizeAgents(p, NOW);
  assert.equal(a.waiting, 1);
  assert.equal(a.running, 1);
  assert.equal(a.live, 3);
  assert.equal(a.total, 3);
  // The one still asking is the one the row leads with.
  assert.equal(a.leadSessionId, 'a');
});
