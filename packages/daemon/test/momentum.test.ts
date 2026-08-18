/**
 * The little trace on each row.
 *
 * Its one real claim is about the gaps. Everything else here — bucketing,
 * pruning — is bookkeeping; the reason this file exists is that a sparkline
 * drawn at zero for minutes nobody watched is a lie the eye reads instantly
 * and cannot check, and it would appear the moment the daemon restarts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Momentum, MOMENTUM_BUCKETS } from '../src/momentum.ts';

const MIN = 60_000;
/** A round bucket boundary, so the arithmetic in the tests is readable. */
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MIN);

test('minutes before the first sample are gaps, not zeroes', () => {
  const m = new Momentum();
  m.sample('p', 2, T0);
  const series = m.series('p', T0)!;
  assert.equal(series.length, MOMENTUM_BUCKETS);
  // Everything up to the first observation is unobserved...
  assert.ok(series.slice(0, -1).every((v) => v === -1));
  // ...and the last bucket is the one we actually saw.
  assert.equal(series[series.length - 1], 2);
});

test('a minute inside the observed span with nothing in it really is zero', () => {
  const m = new Momentum();
  m.sample('p', 3, T0);
  m.sample('p', 0, T0 + 2 * MIN);
  const series = m.series('p', T0 + 2 * MIN)!;
  const tail = series.slice(-3);
  // The daemon samples every project on every tick, so a bucket with no entry
  // inside the span is a minute we watched and saw nothing in.
  assert.deepEqual(tail, [3, 0, 0]);
});

/**
 * The scan runs every three seconds. Taking the last sample of a minute would
 * lose a burst that filled half of it and ended before the tick that closed
 * the bucket — which is exactly the shape worth seeing.
 */
test('a minute keeps its peak, not its last reading', () => {
  const m = new Momentum();
  m.sample('p', 1, T0);
  m.sample('p', 5, T0 + 20_000);
  m.sample('p', 1, T0 + 40_000);
  assert.equal(m.series('p', T0)!.slice(-1)[0], 5);
});

test('nothing sampled at all is absent, which is what a one-shot reader reports', () => {
  const m = new Momentum();
  assert.equal(m.series('never-seen', T0), undefined);
});

test('the trace slides forward as time passes rather than growing', () => {
  const m = new Momentum();
  for (let i = 0; i < MOMENTUM_BUCKETS * 3; i++) m.sample('p', i % 4, T0 + i * MIN);
  const now = T0 + MOMENTUM_BUCKETS * 3 * MIN;
  assert.equal(m.series('p', now)!.length, MOMENTUM_BUCKETS);
});

test('a project nobody has reported for hours is forgotten', () => {
  const m = new Momentum();
  m.sample('gone', 1, T0);
  m.sample('here', 1, T0 + 5 * 3600_000);
  m.prune(T0 + 5 * 3600_000);
  assert.equal(m.series('gone', T0 + 5 * 3600_000), undefined);
  assert.ok(m.series('here', T0 + 5 * 3600_000));
});
