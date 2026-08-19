/**
 * A process blocked on a permission prompt burns no cpu.
 *
 * Caught on the running machine: a session with an open `Bash` tool and 20.1%
 * cpu was reported as WAITING_PERMISSION, three times in ten minutes. The
 * evidence read `perm:no new descendants (15 older ones, probably MCP)` -- true
 * as far as the process tree went, and irrelevant, because the work was simply
 * not a descendant of the pid being watched.
 *
 * That heuristic is a guess by construction and cannot be made exact. What can
 * be made exact is its refutation: cpu can never prove a permission gate, and
 * it can always disprove one. WAITING_PERMISSION is a state allowed to
 * interrupt someone, so it is the one that has to be sure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, type TranscriptFacts, type DescendantSummaryLike } from '@vibetracker/shared';
import { deriveState } from '../src/derive.ts';
import { SPAWN_GRACE_MS, LOCAL_TOOL_PERMISSION_MS } from '../src/thresholds.ts';

const NOW = 1_800_000_000_000;

function withTool(tool: string, openForMs: number): TranscriptFacts {
  const at = NOW - openForMs;
  return {
    path: 'x.jsonl',
    size: 1,
    mtimeMs: at,
    lastEntryAt: at,
    lastEntryRole: 'user',
    openTools: [tool],
    unknownTypes: [],
    linesParsed: 1,
    parseFailures: 0,
  };
}

/** The measured shape: plenty of long-lived children, none of them the work. */
const strangers: DescendantSummaryLike = { total: 15, recent: 0, startTimesKnown: true };

function state(tool: string, openForMs: number, cpuPct: number | null) {
  return deriveState({
    liveness: 'live',
    facts: withTool(tool, openForMs),
    cpuPct,
    descendants: strangers,
    prevState: SessionState.Busy,
    now: NOW,
  });
}

test('a running process is not waiting for permission, whatever the tree says', () => {
  // The measured case, verbatim: Bash open past the spawn grace, fifteen
  // descendants none of which are new, and 20.1% of a core being burnt.
  const s = state('Bash', SPAWN_GRACE_MS + 60_000, 20.1);
  assert.equal(s.state, SessionState.Busy);
  assert.ok(!s.evidence.some((e) => e.startsWith('perm:')), s.evidence.join(' | '));
});

test('the same reading with no cpu is still a permission gate', () => {
  // The veto only removes the false ones. An agent that really is blocked has
  // nothing to burn, and this is the detection the whole product exists for.
  const s = state('Bash', SPAWN_GRACE_MS + 60_000, 0);
  assert.equal(s.state, SessionState.WaitingPermission);
});

test('a local tool held open by a running process is not a prompt either', () => {
  // `Read` finishing in milliseconds is the premise of that branch; a process
  // at 40% is doing something, and the branch never asked.
  const s = state('Read', LOCAL_TOOL_PERMISSION_MS + 10_000, 40);
  assert.equal(s.state, SessionState.Busy);
  assert.ok(!s.evidence.some((e) => e.startsWith('perm:')), s.evidence.join(' | '));
});

test('a local tool held open by an idle process still reads as a prompt', () => {
  const s = state('Read', LOCAL_TOOL_PERMISSION_MS + 10_000, 0);
  assert.equal(s.state, SessionState.WaitingPermission);
});

test('one scheduler tick does not count as running, from a state that was not busy', () => {
  // 2.2% is the smallest thing the sampler can express (see the thresholds).
  // From a non-busy state it is below the line, so it must not veto anything.
  const s = deriveState({
    liveness: 'live',
    facts: withTool('Bash', SPAWN_GRACE_MS + 60_000),
    cpuPct: 2.2,
    descendants: strangers,
    prevState: SessionState.WaitingPermission,
    now: NOW,
  });
  assert.equal(s.state, SessionState.WaitingPermission);
});

test('cpu that cannot be sampled at all never vetoes', () => {
  // A platform with no probe must not lose permission detection: absent is not
  // zero, and it is certainly not "busy".
  const s = state('Bash', SPAWN_GRACE_MS + 60_000, null);
  assert.equal(s.state, SessionState.WaitingPermission);
});
