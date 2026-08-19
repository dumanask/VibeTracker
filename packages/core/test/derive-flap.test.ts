/**
 * The notification storm, as a test.
 *
 * Measured on the reference machine: two sessions produced 485 BUSY→STALLED
 * and 484 STALLED→BUSY transitions in six hours, alternating on consecutive
 * three-second polls. Neither session did anything during those six hours.
 * Their cpu simply sat at 2.2% against a 3% line, and a long-lived agent's
 * idle cost wanders either side of a number that close.
 *
 * Every crossing into STALLED was broadcast as an alert, and the tray notified
 * on every rise of the waiting count, so the machine announced the same two
 * idle sessions several hundred times a day.
 *
 * The cure is two lines instead of one. What is tested here is the property,
 * not the numbers: a reading that wanders inside the band must not change the
 * answer, and a reading that genuinely crosses must.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, type TranscriptFacts } from '@vibetracker/shared';
import { deriveState } from '../src/derive.ts';
import { CPU_BUSY_PCT, CPU_IDLE_PCT, STALL_THINKING_MS, PASSIVE_MULTIPLIER } from '../src/thresholds.ts';

const NOW = 1_800_000_000_000;

/** A turn in flight and long past its deadline: cpu is the only discriminator. */
function silentSinceUser(): TranscriptFacts {
  const at = NOW - STALL_THINKING_MS * PASSIVE_MULTIPLIER - 60_000;
  return {
    path: 'x.jsonl',
    size: 1,
    mtimeMs: at,
    lastEntryAt: at,
    lastEntryRole: 'user',
    openTools: [],
    unknownTypes: [],
    linesParsed: 1,
    parseFailures: 0,
  };
}

function stateAt(cpuPct: number, prevState: string | null) {
  return deriveState({
    liveness: 'live',
    facts: silentSinceUser(),
    cpuPct,
    descendants: null,
    prevState: prevState as never,
    now: NOW,
  }).state;
}

/** The measured shape: an idle agent's cpu wandering either side of 3%. */
const READINGS = [2.2, 3.1, 2.2, 3.1, 2.9, 3.4, 1.8, 2.2, 3.1, 2.6, 3.2, 2.4];

function crossings(states: string[]): number {
  let n = 0;
  for (let i = 1; i < states.length; i++) if (states[i] !== states[i - 1]) n++;
  return n;
}

test('one line per side: an idle agent settles instead of oscillating', () => {
  let state: string = SessionState.Stalled;
  const run = READINGS.map((cpu) => (state = stateAt(cpu, state)));

  // A settled reading may change once -- the first crossing is real. What it
  // may not do is keep changing, which is what a notification is made of.
  assert.ok(crossings(run) <= 1, `flapped ${crossings(run)} times: ${run.join(' ')}`);

  // The same readings under the rule this replaced, so the test says what the
  // defect was rather than only that it is gone: a single line, consulted per
  // sample, with no memory of which side it was on.
  const naive = READINGS.map((cpu) =>
    cpu >= CPU_BUSY_PCT ? SessionState.Busy : SessionState.Stalled,
  );
  assert.ok(crossings(naive) >= 6, 'the fixture no longer reproduces the defect');
});

test('a session that really starts working is called busy immediately', () => {
  // No delay is traded for the stability above: crossing the upper line once
  // is enough, on the very next poll.
  assert.equal(stateAt(CPU_BUSY_PCT + 0.1, SessionState.Stalled), SessionState.Busy);
});

test('a session that really stops working is called stalled', () => {
  // ...and falling clear through the band still reads as stopped.
  assert.equal(stateAt(CPU_IDLE_PCT - 0.5, SessionState.Busy), SessionState.Stalled);
});

test('with no history the upper line applies, so a first reading never over-claims', () => {
  // `vt status` is a single snapshot and has no previous side to be on. It
  // must not inherit the benefit of the doubt that hysteresis grants.
  assert.equal(stateAt(2.2, null), SessionState.Stalled);
});
