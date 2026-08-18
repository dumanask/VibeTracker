import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveState } from '@vibetracker/core';
import { TailReader } from '../src/tail.ts';
import { applyCodexLines, createCodexAdapter } from '../src/agents/codex.ts';
import { createSqliteAgentAdapter, closeSqliteAgents } from '../src/agents/opencode.ts';
import { pathFromFileUri } from '../src/agents/ide.ts';
import { noteText } from '../src/agents/notes.ts';
import { emptyFacts, type TailTargetLike } from './agents-help.ts';

/**
 * What these tests are for.
 *
 * The adapters were written against real files on one machine — 231 Codex
 * rollouts, a 361 MB opencode database, 117 editor workspaces. That is how the
 * shapes were learned, and it is not something a test suite can carry around.
 * So the fixtures here are the *shapes*, reproduced from what was observed, and
 * the assertions are about the decisions made from them: whose turn it is,
 * whether a tool is open, how strongly liveness may be claimed.
 *
 * The one thing every case checks in common is that the answer comes out of
 * `deriveState`. If an adapter ever starts deciding its own states, six agents
 * stop being comparable and the fleet-load strip starts adding up numbers that
 * do not mean the same thing.
 */

function target(): TailTargetLike {
  return { facts: emptyFacts('x.jsonl', 0), openTools: new Map() };
}

const ISO = (ms: number): string => new Date(ms).toISOString();

test('codex: task_complete hands the turn back, task_started keeps it', () => {
  const t0 = Date.UTC(2026, 7, 18, 12, 0, 0);

  const inflight = target();
  applyCodexLines(inflight, [
    JSON.stringify({ timestamp: ISO(t0), type: 'event_msg', payload: { type: 'user_message', message: 'test' } }),
    JSON.stringify({ timestamp: ISO(t0 + 1000), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  ]);
  assert.equal(inflight.facts.lastEntryRole, 'user');

  const done = target();
  applyCodexLines(done, [
    JSON.stringify({ timestamp: ISO(t0), type: 'event_msg', payload: { type: 'user_message', message: 'test' } }),
    JSON.stringify({ timestamp: ISO(t0 + 1000), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: ISO(t0 + 2000), type: 'event_msg', payload: { type: 'agent_message', message: 'bitti' } }),
    JSON.stringify({ timestamp: ISO(t0 + 3000), type: 'event_msg', payload: { type: 'task_complete' } }),
  ]);
  assert.equal(done.facts.lastEntryRole, 'assistant');

  // An aborted turn is the same operational fact as a finished one: nothing
  // will happen until the human does something.
  const aborted = target();
  applyCodexLines(aborted, [
    JSON.stringify({ timestamp: ISO(t0), type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: ISO(t0 + 1000), type: 'event_msg', payload: { type: 'turn_aborted' } }),
  ]);
  assert.equal(aborted.facts.lastEntryRole, 'assistant');
});

test('codex: a call with no output stays open, both families of it', () => {
  for (const [call, output] of [
    ['function_call', 'function_call_output'],
    ['custom_tool_call', 'custom_tool_call_output'],
  ] as const) {
    const open = target();
    applyCodexLines(open, [
      JSON.stringify({ type: 'response_item', payload: { type: call, call_id: 'c1', name: 'shell' } }),
    ]);
    assert.deepEqual([...open.openTools.values()], ['shell'], call);

    const closed = target();
    applyCodexLines(closed, [
      JSON.stringify({ type: 'response_item', payload: { type: call, call_id: 'c1', name: 'shell' } }),
      JSON.stringify({ type: 'response_item', payload: { type: output, call_id: 'c1' } }),
    ]);
    assert.deepEqual([...closed.openTools.values()], [], output);
  }
});

test('codex: an *_end event closes a call whose output was never written', () => {
  // Missing either half of this would leave a tool open forever, and the
  // session permanently BUSY(tool:…) — the failure mode is silent and lasts
  // until the file is re-read from scratch.
  const t = target();
  applyCodexLines(t, [
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c7', name: 'shell' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'c7' } }),
  ]);
  assert.deepEqual([...t.openTools.values()], []);
});

test('codex: an unrecognised record is counted, never thrown on', () => {
  const t = target();
  applyCodexLines(t, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'a_thing_from_next_year' } }),
    '{ not json at all',
    '',
  ]);
  assert.deepEqual(t.facts.unknownTypes, ['event_msg/a_thing_from_next_year']);
  assert.equal(t.facts.parseFailures, 1);
  assert.equal(t.facts.linesParsed, 1);
});

test('codex: free text is redacted where it enters, not where it is drawn', () => {
  const t = target();
  applyCodexLines(t, [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'anahtar sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ile dene' },
    }),
  ]);
  assert.ok(t.facts.lastPrompt);
  assert.ok(!t.facts.lastPrompt!.includes('sk-ant-api03'), t.facts.lastPrompt);
  assert.match(t.facts.lastPrompt!, /«redacted:/);
});

test('codex: session_meta is found even when the first line is enormous', async () => {
  // Measured on 231 real rollouts: median first line 464 bytes, longest 22 KB,
  // 47 of them past 8 KB — the system prompt is on it. This one is bigger than
  // the read window on purpose, so the field-scan fallback is what answers.
  const home = mkdtempSync(join(tmpdir(), 'vt-codex-'));
  try {
    const now = Date.now();
    const d = new Date(now);
    const dir = join(
      home,
      'sessions',
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    );
    mkdirSync(dir, { recursive: true });
    const meta = {
      timestamp: ISO(now),
      type: 'session_meta',
      payload: {
        session_id: 'abc-123',
        cwd: 'C:\\dev\\Foo',
        cli_version: '0.146.1',
        base_instructions: { text: 'x'.repeat(200_000) },
      },
    };
    writeFileSync(
      join(dir, 'rollout-big.jsonl'),
      JSON.stringify(meta) +
        '\n' +
        JSON.stringify({ timestamp: ISO(now), type: 'event_msg', payload: { type: 'task_complete' } }) +
        '\n',
      'utf8',
    );

    const reader = new TailReader();
    try {
      const adapter = createCodexAdapter(() => reader);
      process.env.CODEX_HOME = home;
      const found = await adapter.listSessions({ now: now + 1000, recencyMs: 90_000 });
      assert.equal(found.length, 1);
      assert.equal(found[0]!.sessionId, 'abc-123');
      assert.equal(found[0]!.cwd, 'C:\\dev\\Foo');
      assert.equal(found[0]!.cliVersion, '0.146.1');
      // No pid exists anywhere in a rollout, so this is the only honest answer.
      assert.equal(found[0]!.livenessBasis, 'recency');
      assert.equal(found[0]!.pid, undefined);
    } finally {
      delete process.env.CODEX_HOME;
      await reader.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex: a rollout outside the recency window is not live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vt-codex-'));
  try {
    const now = Date.now();
    const old = now - 10 * 60 * 1000;
    const d = new Date(old);
    const dir = join(
      home,
      'sessions',
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-old.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: ISO(old),
        type: 'session_meta',
        payload: { session_id: 'old-1', cwd: 'C:\\dev\\Foo' },
      }) + '\n',
      'utf8',
    );
    utimesSync(file, old / 1000, old / 1000);

    const reader = new TailReader();
    try {
      process.env.CODEX_HOME = home;
      const adapter = createCodexAdapter(() => reader);
      const found = await adapter.listSessions({ now, recencyMs: 90_000 });
      // Still enumerated — it is inside the 30-minute warm slice — but not
      // claimed as live, which is the distinction the whole basis exists for.
      assert.equal(found.length, 1);
      assert.equal(found[0]!.liveness, 'dead');
    } finally {
      delete process.env.CODEX_HOME;
      await reader.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── opencode / kilo ───────────────────────────────────────────────────────

/**
 * The subset of opencode's schema the reader touches, with the trap that made
 * it necessary: every session's `time_updated` is identical, because a
 * migration stamped all 66 of them at the same instant on the real machine. A
 * reader that trusted it would report the entire history as active now.
 */
function opencodeFixture(dir: string, now: number): void {
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`
    create table project (id text primary key, worktree text not null, vcs text,
                          name text, time_updated integer not null);
    create table session (id text primary key, project_id text not null, directory text not null,
                          title text not null, version text not null, agent text,
                          time_archived integer, time_created integer not null,
                          time_updated integer not null);
    create table message (id text primary key, session_id text not null,
                          time_created integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null,
                       time_created integer not null, data text not null);
    create table todo (session_id text not null, content text not null, status text not null,
                       position integer not null, time_updated integer not null,
                       primary key (session_id, position));
  `);
  const MIGRATED = now; // the same value for every row, as observed
  db.prepare('insert into project values (?,?,?,?,?)').run(
    'p1', 'C:/dev/Foo', 'git', null, MIGRATED);
  db.prepare('insert into project values (?,?,?,?,?)').run(
    'global', '/', null, null, MIGRATED);

  const mk = (id: string, dirPath: string, createdAgo: number): void => {
    db.prepare('insert into session values (?,?,?,?,?,?,?,?,?)').run(
      id, 'p1', dirPath, `title of ${id}`, 'local', 'build', null,
      now - createdAgo, MIGRATED);
  };
  mk('s-done', 'C:/dev/Foo', 600_000);
  mk('s-open', 'C:/dev/Foo', 600_000);
  mk('s-old', 'C:/dev/Foo', 600_000);

  const msg = (id: string, session: string, ago: number, data: unknown): void => {
    db.prepare('insert into message values (?,?,?,?)').run(
      id, session, now - ago, JSON.stringify(data));
  };
  // Finished: an assistant message with a completion time.
  msg('m1', 's-done', 30_000, {
    role: 'assistant', finish: 'stop',
    time: { created: now - 35_000, completed: now - 30_000 },
  });
  // In flight: an assistant message with no completion time.
  msg('m2', 's-open', 30_000, { role: 'assistant', finish: 'tool-calls', time: { created: now - 31_000 } });
  msg('m3', 's-old', 3 * 3600_000, { role: 'assistant', finish: 'stop', time: { completed: now - 3 * 3600_000 } });

  db.prepare('insert into part values (?,?,?,?,?)').run(
    'pt1', 'm2', 's-open', now - 30_000,
    JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running' } }));
  db.prepare('insert into part values (?,?,?,?,?)').run(
    'pt2', 'm1', 's-done', now - 30_000,
    JSON.stringify({ type: 'tool', tool: 'edit', callID: 'c2', state: { status: 'completed' } }));
  db.close();
}

test('opencode: activity comes from the messages, not from session.time_updated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-oc-'));
  try {
    const now = Date.now();
    opencodeFixture(dir, now);
    const adapter = createSqliteAgentAdapter({
      id: 'opencode', displayName: 'opencode', dir, dbFile: 'opencode.db',
    });
    const found = await adapter.listSessions({ now, recencyMs: 90_000 });
    const ids = found.map((s) => s.sessionId).sort();
    // `s-old` last spoke three hours ago. Its `time_updated` says *now*, like
    // every other row, so a reader that used it would have returned it here.
    assert.deepEqual(ids, ['s-done', 's-open']);
  } finally {
    closeSqliteAgents();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: a completed turn waits, an unfinished one is busy with its tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-oc-'));
  try {
    const now = Date.now();
    opencodeFixture(dir, now);
    const adapter = createSqliteAgentAdapter({
      id: 'opencode', displayName: 'opencode', dir, dbFile: 'opencode.db',
    });
    const byId = new Map(
      (await adapter.listSessions({ now, recencyMs: 90_000 })).map((s) => [s.sessionId, s]),
    );

    const done = byId.get('s-done')!;
    assert.equal(done.facts.lastEntryRole, 'assistant');
    assert.deepEqual(done.facts.openTools, []);
    assert.equal(
      deriveState({ liveness: 'live', facts: done.facts, cpuPct: null, descendants: null, now }).state,
      'WAITING_INPUT',
    );

    const open = byId.get('s-open')!;
    // An assistant message with no completion time is the user's move being
    // worked on, which is what the state machine reads 'user' as.
    assert.equal(open.facts.lastEntryRole, 'user');
    assert.deepEqual(open.facts.openTools, ['bash']);
    const state = deriveState({
      liveness: 'live', facts: open.facts, cpuPct: null, descendants: null, now,
    });
    assert.equal(state.state, 'BUSY');
    assert.equal(state.subReason, 'tool:bash');
  } finally {
    closeSqliteAgents();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: the synthetic global project is not a directory anyone works in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-oc-'));
  try {
    const now = Date.now();
    opencodeFixture(dir, now);
    const adapter = createSqliteAgentAdapter({
      id: 'opencode', displayName: 'opencode', dir, dbFile: 'opencode.db',
    });
    const hints = await adapter.listProjectHints();
    assert.deepEqual(hints.map((h) => h.path), ['C:/dev/Foo']);
  } finally {
    closeSqliteAgents();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: installed-but-unused is not reported as schema drift', async () => {
  // Kilo on the reference machine: same schema, two projects, zero sessions and
  // zero messages. Counting messages alone cannot tell that from "the schema
  // moved", and putting a drift warning in front of someone who simply has not
  // run the tool yet is worse than saying nothing.
  const dir = mkdtempSync(join(tmpdir(), 'vt-oc-'));
  try {
    opencodeFixture(dir, Date.now());
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec('delete from message; delete from part;');
    db.close();

    const unused = mkdtempSync(join(tmpdir(), 'vt-kilo-'));
    opencodeFixture(unused, Date.now());
    const db2 = new DatabaseSync(join(unused, 'opencode.db'));
    db2.exec('delete from message; delete from part; delete from session;');
    db2.close();

    const drifted = await createSqliteAgentAdapter({
      id: 'a', displayName: 'a', dir, dbFile: 'opencode.db',
    }).detect();
    assert.equal(drifted.note, 'schema-drift');

    const fresh = await createSqliteAgentAdapter({
      id: 'b', displayName: 'b', dir: unused, dbFile: 'opencode.db',
    }).detect();
    assert.equal(fresh.note, 'never-used');
    // The connections are cached across calls on purpose — opening a 361 MB
    // database per poll is the expensive part — so a temp file cannot be removed
    // until they are dropped.
    closeSqliteAgents();
    rmSync(unused, { recursive: true, force: true });
  } finally {
    closeSqliteAgents();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── editors ───────────────────────────────────────────────────────────────

test('a workspace folder URI becomes a usable path', () => {
  // Every one of the 117 `workspace.json` files on the reference machine looks
  // like this: percent-encoded, with a slash in front of the drive letter that
  // no Windows API accepts.
  assert.equal(
    pathFromFileUri('file:///c%3A/Users/askim/OneDrive/Masa%C3%BCst%C3%BC/SASPERA/Saspera'),
    'c:/Users/askim/OneDrive/Masaüstü/SASPERA/Saspera',
  );
  assert.equal(pathFromFileUri('file:///home/ali/dev/foo'), '/home/ali/dev/foo');
  assert.equal(pathFromFileUri('untitled:Untitled-1'), null);
  assert.equal(pathFromFileUri('file://'), null);
  // Case is left exactly as the editor wrote it. Folding is `pathKey`'s job and
  // doing it twice in two places is how the two stop agreeing.
  assert.equal(pathFromFileUri('file:///C%3A/DEV/Foo'), 'C:/DEV/Foo');
});

test('every adapter note has wording, so none can reach a screen as a code', () => {
  for (const note of [
    'no-registry', 'folders-only', 'never-used', 'schema-drift', 'log-only', 'unreadable',
  ] as const) {
    const text = noteText(note);
    assert.ok(text.length > 0, note);
    assert.notEqual(text, note);
  }
});
