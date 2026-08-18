/**
 * The strip along the top of every surface.
 *
 * It would have been easy, and wrong, to make this an average of the progress
 * bars below it. A plan that grows makes that number fall while work is being
 * done, which is the exact failure this project spent a milestone removing
 * from the per-project percentages. So the bar answers a different question —
 * of the agent sessions alive right now, what share is engaged — and these
 * tests pin the edges of that question rather than the arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBoard } from '../src/summary.ts';
import type { AgentSummary } from '@vibetracker/shared';

function s(p: Partial<AgentSummary>): AgentSummary {
  return { kind: 'none', waiting: 0, running: 0, live: 0, total: 0, urgency: 0, ...p };
}

test('the two halves are kept apart, not summed into one number', () => {
  const load = summarizeBoard([
    s({ live: 2, waiting: 1, running: 1 }),
    s({ live: 2, waiting: 0, running: 1 }),
  ]);
  // "Everything is running" and "everything is blocked" are the same load and
  // opposite situations; a single figure cannot tell them apart and the bar
  // has to.
  assert.deepEqual(load, { live: 4, waiting: 1, running: 2, percent: 75 });
});

test('nothing alive is a dash, not a zero', () => {
  const load = summarizeBoard([s({ live: 0, total: 3 })]);
  // A zero-length bar claims an idleness we measured. Null says we did not.
  assert.equal(load.percent, null);
});

test('an empty board is the same statement as an idle one', () => {
  assert.equal(summarizeBoard([]).percent, null);
});

/**
 * `waiting` and `running` come from different predicates over the same
 * sessions. Nothing currently satisfies both, but a bar drawn past its own
 * end would read as a rendering bug rather than as the arithmetic it is.
 */
test('the engaged share can never exceed what is alive', () => {
  const load = summarizeBoard([s({ live: 1, waiting: 1, running: 1 })]);
  assert.equal(load.percent, 100);
});

test('a fully idle fleet is measured, and reads zero', () => {
  const load = summarizeBoard([s({ live: 3 })]);
  assert.equal(load.percent, 0);
});
