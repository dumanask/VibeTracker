/**
 * `classifyLiveness` in isolation.
 *
 * The integration test in `packages/fixtures` proves the guard works against a
 * generated environment. This one covers the branches that environment cannot
 * produce on demand — a process running as another user, a probe that has lost
 * the ability to read start times at all — because every one of them decides
 * whether a closed project appears on the board as though it were open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness } from '../src/probe/index.ts';
import type { ProcSnapshot } from '@vibetracker/shared';

function snap(pid: number, startTime: string): ProcSnapshot {
  return { pid, startTime, startTimeKind: 'filetime', cpuNs: 0, rss: 0 };
}

function snapshots(...rows: Array<[number, string]>): Map<number, ProcSnapshot> {
  return new Map(rows.map(([pid, st]) => [pid, snap(pid, st)]));
}

test('a matching start time is live and a differing one is reused', () => {
  const b = classifyLiveness(
    [
      { pid: 100, procStart: 'A' },
      { pid: 200, procStart: 'B' },
    ],
    snapshots([100, 'A'], [200, 'ZZZ']),
    'exact',
  );
  assert.equal(b.verdicts.get(100), 'live');
  assert.equal(b.verdicts.get(200), 'reused');
  assert.equal(b.matched, 1);
  assert.equal(b.mismatched, 1);
});

test('a PID with no process at all is dead', () => {
  const b = classifyLiveness([{ pid: 100, procStart: 'A' }], new Map(), 'exact');
  assert.equal(b.verdicts.get(100), 'dead');
});

/**
 * The failure this file was written for.
 *
 * PID 8084 belonged to a Claude Code session in `c:\dev\VRTwin`. Six days
 * later the PID had been recycled by `fontdrvhost.exe`, which runs as another
 * user and does not report its creation time to us. The probe returned an
 * empty `startTime`, the guard read that as "nothing to compare", and a
 * project that had been closed for six days sat on the board saying
 * "1 bekliyor".
 *
 * A start time we cannot read is not missing evidence. The agent runs as the
 * user, so its own process always answers; silence means the PID is somebody
 * else's.
 */
test('a PID that will not say when it started is not ours', () => {
  const b = classifyLiveness(
    [
      { pid: 100, procStart: 'A' },
      { pid: 8084, procStart: 'OLD' },
    ],
    snapshots([100, 'A'], [8084, '']),
    'exact',
  );
  assert.equal(b.verdicts.get(8084), 'reused');
  assert.equal(b.opaque, 1);
  // And it is counted apart from a mismatch: the two are different evidence,
  // and only mismatches can indicate a format change.
  assert.equal(b.mismatched, 0);
  assert.equal(b.formatDriftSuspected, false);
});

/**
 * The same rule read the other way. If the probe cannot read *any* start time,
 * the fault is the probe's, not every process's — and declaring every session
 * dead is far worse than the over-count the guard exists to fix.
 */
test('a probe that can read nothing degrades to live rather than to dead', () => {
  const b = classifyLiveness(
    [
      { pid: 100, procStart: 'A' },
      { pid: 200, procStart: 'B' },
      { pid: 300, procStart: 'C' },
    ],
    snapshots([100, ''], [200, ''], [300, '']),
    'exact',
  );
  for (const pid of [100, 200, 300]) assert.equal(b.verdicts.get(pid), 'live');
  assert.equal(b.opaque, 3);
});

/**
 * The pre-existing bulk rule, kept honest: the agent's start-time format has
 * been seen to change between patch releases, and a per-entry comparison would
 * then report zero live agents while a dozen were running.
 */
test('a universal mismatch is read as format drift, not as universal reuse', () => {
  const b = classifyLiveness(
    [
      { pid: 100, procStart: 'A' },
      { pid: 200, procStart: 'B' },
      { pid: 300, procStart: 'C' },
    ],
    snapshots([100, '1'], [200, '2'], [300, '3']),
    'exact',
  );
  assert.equal(b.formatDriftSuspected, true);
  for (const pid of [100, 200, 300]) assert.equal(b.verdicts.get(pid), 'live');
});

test('two mismatches are too few to blame the format', () => {
  const b = classifyLiveness(
    [
      { pid: 100, procStart: 'A' },
      { pid: 200, procStart: 'B' },
    ],
    snapshots([100, '1'], [200, '2']),
    'exact',
  );
  assert.equal(b.formatDriftSuspected, false);
  assert.equal(b.verdicts.get(100), 'reused');
});

test('an agent that records no start time leaves the guard nothing to do', () => {
  const b = classifyLiveness([{ pid: 100 }], snapshots([100, 'A']), 'exact');
  assert.equal(b.verdicts.get(100), 'live');
  assert.equal(b.guardAvailable, false);
});

test('a probe with no precision never claims reuse', () => {
  const b = classifyLiveness(
    [{ pid: 100, procStart: 'A' }],
    snapshots([100, 'ZZZ']),
    'none',
  );
  assert.equal(b.verdicts.get(100), 'live');
  assert.equal(b.guardAvailable, false);
});
