/**
 * Ages are compared against one instant stamped at the top of a scan, but the
 * scan then spends seconds reading. The busiest session on the machine writes
 * during that window and lands in the future relative to the comparison point.
 *
 * This was a real defect: `vt status` showed `?` for the one agent that was
 * actively working, because the age came out negative and `fmtAge` refuses to
 * format a negative. The refusal is right; the input was wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAge, sinceMs, FUTURE_TOLERANCE_MS } from '../src/format.ts';
import { setLang } from '../src/i18n.ts';

test('a session that wrote during the scan reads as now, not as unknown', () => {
  setLang('tr');
  const now = 1_000_000_000;
  // Written 1.4 s after the scan stamped its clock — a normal scan is slower
  // than that, so this is the common case, not the corner case.
  assert.equal(sinceMs(now, now + 1400), 0);
  assert.equal(fmtAge(sinceMs(now, now + 1400)), '0sn');
});

test('a clock that is genuinely wrong keeps its question mark', () => {
  const now = 1_000_000_000;
  const wayAhead = now + FUTURE_TOLERANCE_MS + 60_000;
  assert.ok(sinceMs(now, wayAhead) < 0);
  assert.equal(fmtAge(sinceMs(now, wayAhead)), '?');
});

test('ordinary past timestamps are untouched', () => {
  setLang('tr');
  const now = 1_000_000_000;
  assert.equal(sinceMs(now, now - 90_000), 90_000);
  assert.equal(fmtAge(sinceMs(now, now - 90_000)), '1dk 30sn');
});

test('the tolerance boundary is not itself a hole', () => {
  const now = 1_000_000_000;
  // Exactly at the edge counts as skew, so the rule has no gap where a value
  // is neither folded nor flagged.
  assert.ok(sinceMs(now, now + FUTURE_TOLERANCE_MS) < 0);
});
