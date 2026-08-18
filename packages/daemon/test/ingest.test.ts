import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookRing } from '../src/hooks/ring.ts';
import { HookIngest } from '../src/hooks/ingest.ts';
import { SessionState, type SessionView } from '@vibetracker/shared';

/**
 * Payload shapes here are transcribed from the installed Claude Code binary
 * (v2.1.206), not invented — `PermissionRequest` really does omit
 * `tool_use_id`, and the base fields really are the eight in `HookBase`. A test
 * built on a guessed shape would pass while the product failed.
 */

const SID = 'sess-1';
const base = { session_id: SID, cwd: 'c:/dev/x', transcript_path: 'c:/t.jsonl', permission_mode: 'default' };

const ev = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...base, hook_event_name: name, ...extra });

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: SID,
    pid: 1,
    liveness: 'live',
    state: SessionState.Busy,
    evidence: ['proc:live'],
    confidence: 0.5,
    cwd: 'c:/dev/x',
    normPath: 'c:/dev/x',
    openTools: [],
    ...overrides,
  };
}

test('PermissionRequest is an exact WAITING_PERMISSION, not an inference', () => {
  const h = new HookIngest();
  h.apply([ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })], 1000);

  const v = view({ openTools: ['Bash'] });
  assert.equal(h.overlay(v, 1000), true);
  assert.equal(v.state, SessionState.WaitingPermission);
  assert.equal(v.confidence, 0.95);
  assert.equal(v.hooked, true);
  assert.ok(v.evidence.some((e) => e.startsWith('hook:izin istendi')));
});

test('neither tool_input nor error text can carry a secret through', () => {
  const h = new HookIngest();
  const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(4);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';
  h.apply([
    ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: `export KEY=${key}` } }),
    ev('PostToolUseFailure', { tool_name: 'Bash', error: `auth failed: ${key} / ${jwt}` }),
    ev('StopFailure', { error: `token ${jwt} rejected` }),
  ]);
  const dump = JSON.stringify(h.get(SID) ?? {});
  assert.ok(!dump.includes('sk-ant-api03'), `anahtar tutuldu: ${dump}`);
  assert.ok(!dump.includes('eyJhbGciOi'), `JWT tutuldu: ${dump}`);
  assert.ok(dump.includes('«redacted:'), 'redaksiyon izi olmalı — sessizce silinmemeli');

  // And the overlay must not smuggle it out through evidence either.
  const v = view({ state: SessionState.Errored });
  h.overlay(v);
  assert.ok(!JSON.stringify(v).includes('sk-ant-api03'));
});

test('the transcript, not a hook, ends a permission wait', () => {
  const h = new HookIngest();
  h.apply([ev('PermissionRequest', { tool_name: 'Bash' })], 1000);

  // Still open in the transcript: the wait continues.
  const blocked = view({ openTools: ['Bash'] });
  h.overlay(blocked, 2000);
  assert.equal(blocked.state, SessionState.WaitingPermission);

  // Tool closed, and enough time has passed for the transcript to be believed:
  // approval happened, and we fall back to the passive reading rather than
  // inventing a "granted" event we never received.
  const running = view({ openTools: [], state: SessionState.Busy });
  h.overlay(running, 1000 + 11_000);
  assert.equal(running.state, SessionState.Busy);
});

test('a transcript that has not caught up yet cannot cancel a fresh request', () => {
  const h = new HookIngest();
  h.apply([ev('PermissionRequest', { tool_name: 'Bash' })], 1000);

  // Hooks arrive before the JSONL flush, so the very next scan can legitimately
  // show no open tool. Believing it would blink the alert away the instant it
  // appeared — the exact failure this whole feature exists to prevent.
  const tooSoon = view({ openTools: [], state: SessionState.Busy });
  h.overlay(tooSoon, 2000);
  assert.equal(tooSoon.state, SessionState.WaitingPermission, 'erken temizlendi');

  // Once the window passes and the tool still is not open, the wait ends.
  const later = view({ openTools: [], state: SessionState.Busy });
  h.overlay(later, 1000 + 11_000);
  assert.equal(later.state, SessionState.Busy);
});

test('Stop is an exact turn boundary', () => {
  const h = new HookIngest();
  h.apply([ev('UserPromptSubmit'), ev('Stop', { stop_hook_active: false })], 5000);
  const v = view();
  h.overlay(v, 5000);
  assert.equal(v.state, SessionState.WaitingInput);
  assert.equal(v.stateSince, 5000);
});

test('subagent events belong to the subagent, not the session', () => {
  const h = new HookIngest();
  h.apply([
    ev('UserPromptSubmit'),
    ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
    ev('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' }),
    // A Stop tagged with an agent_id is the *subagent* finishing. Reading it as
    // the session's turn ending would show "waiting for you" mid-work.
    ev('Stop', { agent_id: 'a1' }),
  ]);
  const v = view();
  h.overlay(v);
  assert.equal(v.state, SessionState.Busy, 'alt-ajanın Stop\'u oturumu bitirmemeli');
  assert.equal(v.subagents, 2);

  h.apply([ev('SubagentStop', { agent_id: 'a1' })]);
  const v2 = view();
  h.overlay(v2);
  assert.equal(v2.subagents, 1);
});

test('a dead process outranks any hook that ever arrived', () => {
  const h = new HookIngest();
  h.apply([ev('PermissionRequest', { tool_name: 'Bash' })]);
  const v = view({ liveness: 'dead', state: SessionState.Orphaned });
  h.overlay(v);
  assert.equal(v.state, SessionState.Orphaned, 'canlılık ölçülür, rapor edilmez');
  assert.equal(v.hooked, true);
});

test('stale hook state yields to inference instead of lying', () => {
  const h = new HookIngest();
  h.apply([ev('Stop')], 0);
  const v = view({ state: SessionState.Busy });
  h.overlay(v, 31 * 60_000);
  assert.equal(v.state, SessionState.Busy, 'bir saatlik hook durumu gösterilmemeli');
});

test('compaction is a busy state with its own reason', () => {
  const h = new HookIngest();
  h.apply([ev('PreCompact', { trigger: 'auto' })]);
  const v = view();
  h.overlay(v);
  assert.equal(v.state, SessionState.Busy);
  assert.ok(v.evidence.some((e) => e.includes('sıkıştırma')));
});

test('garbage in the stream is counted, never thrown', () => {
  const h = new HookIngest();
  h.apply(['not json at all', '{}', ev('Stop')]);
  assert.equal(h.stats.unparsable, 1);
  assert.equal(h.stats.ignored, 1);
  assert.equal(h.stats.parsed, 2);
});

test('the ring drops the oldest and says so', () => {
  const r = new HookRing(4);
  for (let i = 0; i < 6; i++) r.push(String(i));
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.drain(), ['2', '3', '4', '5']);
  assert.equal(r.pending, 0);
  assert.equal(r.received, 6);
  // Drained twice must not replay.
  assert.deepEqual(r.drain(), []);
});

test('the ring survives interleaved push and drain', () => {
  const r = new HookRing(3);
  r.push('a');
  assert.deepEqual(r.drain(), ['a']);
  r.push('b');
  r.push('c');
  r.push('d');
  r.push('e');
  assert.deepEqual(r.drain(), ['c', 'd', 'e']);
  assert.equal(r.dropped, 1);
});

/**
 * Every free-text field the agent hands us, not only the error text.
 *
 * The rule is that agent output is redacted at the single point where it
 * enters, and for a while `error` and `tool_input` were the only fields
 * obeying it. But `tool_name` is chosen by whoever wrote the MCP server, and
 * `notification_type`, `source` and `reason` are the same kind of string. All
 * four end up in `sub_reason`, on the board and in evidence — so an odd one is
 * text from somewhere else appearing on the dashboard, and later in the
 * `--json` somebody pastes into an issue.
 */
test('a secret in any hook field is redacted before it is kept', () => {
  const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(4);
  const h = new HookIngest();
  h.apply([
    ev('PermissionRequest', { tool_name: key }),
    ev('SessionStart', { source: key }),
    ev('SessionEnd', { reason: key }),
    ev('Notification', { notification_type: key }),
  ]);
  const dump = JSON.stringify(h.get(SID) ?? {});
  assert.ok(!dump.includes('sk-ant-api03'), `hook alanindaki sir tutuldu: ${dump}`);
  assert.ok(dump.includes('«redacted:'), 'redaksiyon hic calismamis');

  const v = view({});
  h.overlay(v);
  assert.ok(!JSON.stringify(v).includes('sk-ant-api03'), 'sir overlay ile disari cikti');
});
