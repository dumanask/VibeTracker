/**
 * The reader is a cache, and twice it quietly stopped being one.
 *
 * Both bugs were invisible: nothing failed, nothing logged, the board looked
 * right. What was lost was the thing the class exists for — a descriptor held
 * open across polls, so a poll costs an `fstat` instead of an `open`, and a
 * tool first seen forty polls ago is still remembered. Under Defender an open
 * measured ~310 ms regardless of file size, so losing the cache is not a
 * micro-optimisation; it is the difference between a scan and a stall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailReader } from '../src/tail.ts';

function line(o: unknown): string {
  return JSON.stringify(o) + '\n';
}

function session(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    line({ type: 'user', message: { role: 'user', content: 'merhaba' }, timestamp: '2026-08-19T00:00:00Z' }),
    'utf8',
  );
  return p;
}

/**
 * `#trim` evicted by `lastUsed` ascending, and a new entry was stamped only
 * *after* the trim ran — so it was born at 0, was always the coldest thing in
 * the map, and was the one deleted. Past the tracking limit the cache
 * therefore served nothing at all.
 */
test('a newly tracked file is not the one the trim throws away', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-trim-'));
  try {
    const reader = new TailReader();
    // Past whatever the limit is: enough files that a trim has to have run.
    const many: string[] = [];
    for (let i = 0; i < 600; i++) many.push(session(dir, `s${i}.jsonl`));
    for (const p of many) await reader.read(p);

    const fresh = session(dir, 'fresh.jsonl');
    await reader.read(fresh);
    const before = reader.stats();
    // Second read of an unchanged file: the whole point is that it costs a
    // stat and no open.
    await reader.read(fresh);
    const after = reader.stats();

    assert.equal(after.opens, before.opens, 'the same file was reopened -- the cache is not working');
    assert.ok(after.skipped > before.skipped, 'a file that did not grow was read anyway');
    await reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `retain` is given the set of paths still worth following, and everything
 * else is dropped. The adapters share this reader, so a set built only from
 * Claude Code's registry dropped every Codex rollout on every scan — and the
 * next scan reopened it and re-read its window. Anything that had scrolled out
 * of that window, an open tool call in particular, was forgotten each time.
 */
test('retain keeps a path that is still being followed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-retain-'));
  try {
    const reader = new TailReader();
    const claude = session(dir, 'claude.jsonl');
    const codex = session(dir, 'codex.jsonl');
    await reader.read(claude);
    await reader.read(codex);
    const opened = reader.stats().opens;

    // The scan's own call, with both paths named.
    await reader.retain(new Set([claude, codex]));
    await reader.read(claude);
    await reader.read(codex);
    assert.equal(reader.stats().opens, opened, 'a retained path was reopened anyway');

    // And a path left out really is dropped — the other half of the promise.
    await reader.retain(new Set([claude]));
    appendFileSync(codex, line({ type: 'user', message: { role: 'user', content: 'x' } }), 'utf8');
    await reader.read(codex);
    assert.ok(reader.stats().opens > opened, 'a released path was not closed');
    await reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
