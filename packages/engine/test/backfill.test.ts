import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpans, type PhasePoint } from '../src/progress/backfill.ts';

/**
 * Git archaeology.
 *
 * The daemon only knows what happened since it was installed, and a chart
 * whose first months are blank reads as a project that did nothing. Commit
 * subjects already carry phase tokens and dates, so the same parser that reads
 * plan documents can reconstruct the past at zero cost.
 */

const D = (iso: string): number => Date.parse(iso);

function pt(over: Partial<PhasePoint> & { at: number }): PhasePoint {
  return {
    labelRaw: 'Faz 1',
    unit: 'faz',
    ordinal: 1,
    kind: 'unknown',
    completed: false,
    sha: 'abcdef012345',
    backfill: true,
    ...over,
  };
}

test('a rung opens at its first mention and closes at its first completion', () => {
  const spans = toSpans([
    pt({ at: D('2026-03-01') }),
    pt({ at: D('2026-04-01') }),
    pt({ at: D('2026-05-01'), completed: true }),
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.firstAt, D('2026-03-01'));
  assert.equal(spans[0]!.doneAt, D('2026-05-01'));
  assert.equal(spans[0]!.commits, 3);
});

test('a rung nobody ever finished stays open rather than being guessed closed', () => {
  const spans = toSpans([pt({ at: D('2026-03-01') }), pt({ at: D('2026-04-01') })]);
  assert.equal(spans[0]!.doneAt, null);
});

test('work continuing after a completion is counted, not hidden', () => {
  // The common shape of a lie: a phase announced complete, then more commits
  // about it. Both facts are kept so the board can show them together.
  const spans = toSpans([
    pt({ at: D('2026-03-01'), completed: true }),
    pt({ at: D('2026-03-10') }),
    pt({ at: D('2026-03-20') }),
  ]);
  assert.equal(spans[0]!.doneAt, D('2026-03-01'));
  assert.equal(spans[0]!.lastAt, D('2026-03-20'));
  assert.equal(spans[0]!.afterDone, 2);
});

test('rungs of different units never merge', () => {
  // `Faz 1` and `Slice 1` are different ladders that happen to share an
  // ordinal. Collapsing them would invent a history neither one has.
  const spans = toSpans([
    pt({ at: D('2026-03-01'), unit: 'faz', ordinal: 1 }),
    pt({ at: D('2026-03-02'), unit: 'slice', ordinal: 1, labelRaw: 'Slice 1' }),
  ]);
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((s) => s.unit),
    ['faz', 'slice'],
  );
});

test('the more descriptive label and the first known kind win', () => {
  const spans = toSpans([
    pt({ at: D('2026-03-01'), labelRaw: 'Faz 2', ordinal: 2, kind: 'unknown' }),
    pt({ at: D('2026-03-05'), labelRaw: 'Faz 2 — e2e testleri', ordinal: 2, kind: 'test' }),
  ]);
  assert.equal(spans[0]!.labelRaw, 'Faz 2 — e2e testleri');
  assert.equal(spans[0]!.kind, 'test');
});

test('spans come back in chronological order', () => {
  const spans = toSpans([
    pt({ at: D('2026-05-01'), ordinal: 3 }),
    pt({ at: D('2026-01-01'), ordinal: 1 }),
    pt({ at: D('2026-03-01'), ordinal: 2 }),
  ]);
  assert.deepEqual(
    spans.map((s) => s.ordinal),
    [1, 2, 3],
  );
});

test('an empty history produces an empty board, not a crash', () => {
  assert.deepEqual(toSpans([]), []);
});
