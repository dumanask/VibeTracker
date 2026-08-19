/**
 * A cpu sample is quantised, so a single one cannot be trusted.
 *
 * Logged from the running daemon for a session that had been silent for six
 * hours, one line per three-second scan: the reading was only ever 0.0%, 2.2%
 * or 4.5%. Windows accounts cpu in ~15.6 ms scheduler ticks against a 700 ms
 * window, so those are one tick and two ticks -- there is nothing in between
 * to measure. An idle process that catches two ticks in one window clears a 3%
 * line honestly, and used to move a session from STALLED to BUSY and back on
 * the next poll.
 *
 * Hysteresis alone cannot help with that, because the reading crosses both
 * sides. What helps is refusing to believe a change until it is seen twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedState } from '@vibetracker/core';
import { ScanContext } from '../src/context.ts';

const SID = 'session-under-test';
const TICK = 3000;

function reading(state: string, cpu: number): DerivedState {
  return {
    state: state as DerivedState['state'],
    confidence: 0.6,
    evidence: [`proc:cpu ${cpu.toFixed(1)}%`],
  };
}

/** Feed a context one reading per scan and report what it decided each time. */
function run(samples: Array<[string, number]>): string[] {
  const ctx = new ScanContext();
  let now = 1_800_000_000_000;
  return samples.map(([state, cpu]) => {
    const out = ctx.settle(SID, reading(state, cpu), now);
    now += TICK;
    return out.state;
  });
}

test('a one-sample spike does not move the state', () => {
  // The measured sequence, verbatim: two ticks once, zero either side.
  const out = run([
    ['STALLED', 0], ['STALLED', 2.2], ['STALLED', 0],
    ['BUSY', 4.5],
    ['STALLED', 0], ['STALLED', 0],
  ]);
  assert.deepEqual(new Set(out), new Set(['STALLED']), out.join(' '));
});

test('a change that is still there on the next scan is adopted', () => {
  const out = run([
    ['STALLED', 0],
    ['BUSY', 40], ['BUSY', 45],
  ]);
  // One poll of latency, and then it is believed.
  assert.deepEqual(out, ['STALLED', 'STALLED', 'BUSY']);
});

test('holding the state holds its evidence with it', () => {
  // Showing BUSY next to "no cpu" would be a surface contradicting itself,
  // which is worse than a surface that is one poll behind.
  const ctx = new ScanContext();
  const now = 1_800_000_000_000;
  ctx.settle(SID, reading('STALLED', 0), now);
  const held = ctx.settle(SID, reading('BUSY', 4.5), now + TICK);
  assert.equal(held.state, 'STALLED');
  assert.deepEqual(held.evidence, ['proc:cpu 0.0%']);
});

test('an alternating signal never settles, which is the correct answer', () => {
  // Three seconds of BUSY between two STALLEDs is not a state, it is a sample.
  const out = run(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? ['BUSY', 4.5] : ['STALLED', 0]) as [string, number]),
  );
  assert.deepEqual(new Set(out), new Set(['STALLED']), out.join(' '));
});

test('a fresh context adopts what it sees, because a snapshot has no history', () => {
  // `vt status` is one reading and is honest about being one reading. Holding
  // a state it has never observed would be inventing one.
  const ctx = new ScanContext();
  assert.equal(ctx.settle(SID, reading('BUSY', 40), 1).state, 'BUSY');
});

test('two sessions do not settle each other', () => {
  const ctx = new ScanContext();
  const now = 1_800_000_000_000;
  ctx.settle('a', reading('STALLED', 0), now);
  ctx.settle('b', reading('BUSY', 40), now);
  assert.equal(ctx.settle('a', reading('BUSY', 4.5), now + TICK).state, 'STALLED');
  assert.equal(ctx.settle('b', reading('BUSY', 40), now + TICK).state, 'BUSY');
});
