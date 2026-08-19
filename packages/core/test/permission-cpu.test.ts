/**
 * What is allowed to claim that someone is being waited on.
 *
 * Caught first on the running machine: a session with an open `Bash` tool and
 * 20.1% cpu reported as WAITING_PERMISSION three times in ten minutes, with
 * the evidence `perm:no new descendants (15 older ones, probably MCP)` -- true
 * as far as the process tree went, and irrelevant, because the work was not a
 * descendant of the pid being watched. Cpu was made a veto, which removed the
 * cases where something was visibly burning.
 *
 * It was not enough, and the next measurement said why: on an IDE-hosted
 * session the registered pid has *no* descendants at all, and the agent's own
 * cpu is 0% while its shell works elsewhere. Seventeen false permission alarms
 * in ninety minutes, in the one state that interrupts a person. So the
 * inference is gone: a tree is read for what it shows and never for what it
 * fails to show, and the only passive gate left is the one whose evidence is
 * the tool's own duration -- a call that finishes in milliseconds and, half a
 * minute later, has not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionState,
  interrupts,
  type TranscriptFacts,
  type DescendantSummaryLike,
} from '@vibetracker/shared';
import { deriveState } from '../src/derive.ts';
import { SPAWN_GRACE_MS, LOCAL_TOOL_PERMISSION_MS, stallDeadline } from '../src/thresholds.ts';

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

test('...and neither is an idle one: a shell call is never a passive permission gate', () => {
  // This assertion used to run the other way, and the belief behind it was
  // wrong. "No descendant started since the call" was read as "the command
  // never started, so it must be waiting to be allowed" -- which holds only if
  // the work runs under the pid the session registered. Measured on a live
  // IDE-hosted session: the registered pid had *zero* descendants while its
  // shell was running perfectly well somewhere else, so every Bash call it
  // made looked like a permission prompt. Seventeen alarms in ninety minutes,
  // none of them real, in the one state that is allowed to interrupt someone.
  const s = state('Bash', SPAWN_GRACE_MS + 60_000, 0);
  assert.equal(s.state, SessionState.Busy);
  assert.ok(!s.evidence.some((e) => e.startsWith('perm:')), s.evidence.join(' | '));
});

test('a shell call still stalls once it outlives its own deadline', () => {
  // Removing the permission claim must not remove the detection underneath it.
  // A `Bash` call may legitimately run for many minutes; past its deadline
  // with nothing written and no cpu, STALLED is the honest word -- alive, no
  // progress, worth a look -- and it interrupts nobody.
  const s = state('Bash', stallDeadline('Bash', true) + 60_000, 0);
  assert.equal(s.state, SessionState.Stalled);
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
  // From a non-busy state it is below the line, so it must not veto anything:
  // the local-tool branch is the one that still reads a gate, and a single
  // tick must not talk it out of one.
  const s = deriveState({
    liveness: 'live',
    facts: withTool('Read', LOCAL_TOOL_PERMISSION_MS + 10_000),
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
  const s = state('Read', LOCAL_TOOL_PERMISSION_MS + 10_000, null);
  assert.equal(s.state, SessionState.WaitingPermission);
});

/**
 * The file's clock is not the conversation's clock.
 *
 * Claude Code appends `ai-title`, `mode`, `last-prompt` and `atis-latch`
 * records with no timestamp of their own, sometimes days after the last turn.
 * Taking the newer of `lastEntryAt` and the file's mtime let one of those
 * speak for the conversation: session 62e054a9, whose last message was two and
 * a half days old, was read as `silent for 5m 7s`, brought back from ORPHANED
 * to BUSY, and announced as an agent waiting for you twenty-four seconds
 * later. Nothing had happened in that project at all.
 */
test('a touched file does not make an old conversation recent', () => {
  const twoDays = 2 * 24 * 60 * 60_000;
  const facts: TranscriptFacts = {
    path: 'x.jsonl',
    size: 1,
    mtimeMs: NOW - 5_000, // an `atis-latch` landed five seconds ago
    lastEntryAt: NOW - twoDays, // ...and the last real turn is two days old
    lastEntryRole: 'assistant',
    openTools: [],
    unknownTypes: [],
    linesParsed: 1,
    parseFailures: 0,
  };
  const s = deriveState({
    liveness: 'live',
    facts,
    cpuPct: 0,
    descendants: strangers,
    prevState: null,
    now: NOW,
  });
  assert.equal(s.state, SessionState.WaitingInput);
  // The age it reports has to be the conversation's, not the file's: "waiting
  // 2 days" is a session to close, "waiting 5 seconds" is one to answer.
  assert.ok(
    s.evidence.some((e) => e.includes('2') && !e.includes('5s')),
    s.evidence.join(' | '),
  );
});

test('...but mtime is still the fallback when no turn could be parsed', () => {
  // An adapter that reports no entries, or a window that held none. Absent is
  // not "the beginning of time": without the fallback every such session would
  // look silent since 1970 and stall instantly.
  const facts: TranscriptFacts = {
    path: 'x.jsonl',
    size: 1,
    mtimeMs: NOW - 3_000,
    lastEntryAt: undefined,
    lastEntryRole: undefined,
    openTools: [],
    unknownTypes: [],
    linesParsed: 0,
    parseFailures: 0,
  };
  const s = deriveState({
    liveness: 'live',
    facts,
    cpuPct: 0,
    descendants: strangers,
    prevState: null,
    now: NOW,
  });
  assert.equal(s.state, SessionState.Busy);
});

/**
 * A question is not a stall.
 *
 * Read off the running board: an open `AskUserQuestion`, zero cpu, and seven
 * and a half minutes later the verdict `STALLED` -- which means "alive, no
 * progress, this looks wrong". Nothing was wrong. The agent had asked a
 * question and was waiting to be read, which is the one thing this whole
 * product exists to put on a screen.
 */
test('a tool that blocks on a person is answered by the call, not by a deadline', () => {
  const s = state('AskUserQuestion', 60_000, 0);
  assert.equal(s.state, SessionState.WaitingInput);
  assert.equal(s.subReason, 'question');
});

test('...and does not wait out a stall deadline first', () => {
  // The old path called this STALLED once the generic thinking deadline had
  // passed. Well past it now, and still a question.
  const s = state('ExitPlanMode', 20 * 60_000, 0);
  assert.equal(s.state, SessionState.WaitingInput);
});

test('it is a question, not a permission gate, so nothing new interrupts', () => {
  // `interrupts()` is unchanged by this: the board learns sooner, the machine
  // stays as quiet as it was.
  assert.equal(interrupts(state('AskUserQuestion', 60_000, 0).state), false);
});

test('a freshly written call is still just work in flight', () => {
  // The twenty-second window covers the gap between the call being written and
  // its result being read; jumping straight to "waiting on you" would flicker.
  assert.equal(state('AskUserQuestion', 5_000, 0).state, SessionState.Busy);
});
