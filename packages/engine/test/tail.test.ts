import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailReader, readTranscriptFacts } from '../src/tail.ts';

/**
 * The reader is the one place where a bug is both silent and total: it decides
 * what every other layer believes about a session. Its hardest property is
 * offset continuity — reading a growing file in arbitrary chunks must yield
 * exactly what one pass over the finished file yields, even when a chunk
 * boundary falls inside a UTF-8 sequence or inside a JSON line.
 */

let dirCounter = 0;
async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `vt-tail-${dirCounter++}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deterministic PRNG so a failing chunk split can be reproduced. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

let clock = Date.parse('2026-08-18T09:00:00.000Z');
function nextTs(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function msg(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: role,
    timestamp: nextTs(),
    gitBranch: 'main',
    message: { content: [{ type: 'text', text }] },
  });
}

function toolUse(id: string, name: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: nextTs(),
    message: { content: [{ type: 'tool_use', id, name }] },
  });
}

function toolResult(id: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: nextTs(),
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  });
}

test('offset continuity: chunked appends equal one full pass', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'session.jsonl');

    // Turkish text on purpose: multi-byte sequences land on chunk boundaries,
    // which is exactly where a naive reader corrupts characters.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(msg(i % 2 === 0 ? 'user' : 'assistant', `İşlem ${i} — ölçüm yapıldı, şğüç`));
      if (i % 17 === 0) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: `başlık ${i}` }));
      if (i % 23 === 0) lines.push(toolUse(`t${i}`, 'Bash'));
      if (i % 23 === 0) lines.push(toolResult(`t${i}`));
    }
    const full = Buffer.from(lines.join('\n') + '\n', 'utf8');

    await writeFile(path, '');
    const reader = new TailReader();
    const rand = lcg(42);
    let written = 0;
    while (written < full.length) {
      // Chunks deliberately ignore line and character boundaries.
      const n = Math.min(full.length - written, 1 + Math.floor(rand() * 400));
      await appendFile(path, full.subarray(written, written + n));
      written += n;
      await reader.read(path, { headBytes: 0 });
    }
    const incremental = await reader.read(path, { headBytes: 0 });
    await reader.close();

    // tailBytes larger than the file forces the one-shot reader to see all of it.
    const oneShot = await readTranscriptFacts(path, {
      tailBytes: full.length + 1024,
      headBytes: 0,
    });

    assert.ok(incremental && oneShot);
    assert.equal(incremental.lastEntryAt, oneShot.lastEntryAt);
    assert.equal(incremental.lastEntryRole, oneShot.lastEntryRole);
    assert.equal(incremental.aiTitle, oneShot.aiTitle);
    assert.equal(incremental.gitBranch, oneShot.gitBranch);
    assert.deepEqual(incremental.openTools, oneShot.openTools);
    assert.equal(incremental.linesParsed, oneShot.linesParsed);
    assert.equal(incremental.parseFailures, 0);
    assert.equal(oneShot.parseFailures, 0);
  });
});

test('an unterminated trailing line is never parsed', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'partial.jsonl');
    await writeFile(path, msg('assistant', 'tamamlandı') + '\n');

    const reader = new TailReader();
    const before = await reader.read(path, { headBytes: 0 });
    assert.equal(before?.linesParsed, 1);
    assert.equal(before?.parseFailures, 0);

    // Half a record, as the agent flushes it.
    const half = msg('user', 'yarım kalan satır');
    await appendFile(path, half.slice(0, Math.floor(half.length / 2)));
    const mid = await reader.read(path, { headBytes: 0 });
    assert.equal(mid?.linesParsed, 1, 'partial line must not be counted');
    assert.equal(mid?.parseFailures, 0, 'partial line must not be a parse failure');

    // Now it completes.
    await appendFile(path, half.slice(Math.floor(half.length / 2)) + '\n');
    const after = await reader.read(path, { headBytes: 0 });
    assert.equal(after?.linesParsed, 2);
    assert.equal(after?.parseFailures, 0);
    assert.equal(after?.lastEntryRole, 'user');
    await reader.close();
  });
});

test('a tool stays open across polls until its result arrives', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'tools.jsonl');
    await writeFile(path, toolUse('abc', 'Bash') + '\n');

    const reader = new TailReader();
    assert.deepEqual((await reader.read(path, { headBytes: 0 }))?.openTools, ['Bash']);

    // Many polls later, with unrelated traffic in between, it is still open.
    for (let i = 0; i < 5; i++) {
      await appendFile(path, msg('assistant', `ara mesaj ${i}`) + '\n');
      assert.deepEqual((await reader.read(path, { headBytes: 0 }))?.openTools, ['Bash']);
    }

    await appendFile(path, toolResult('abc') + '\n');
    assert.deepEqual((await reader.read(path, { headBytes: 0 }))?.openTools, []);
    await reader.close();
  });
});

test('a shrinking file is treated as a rewrite, not as corruption', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'compacted.jsonl');
    const long = Array.from({ length: 50 }, (_, i) => msg('user', `eski ${i}`)).join('\n') + '\n';
    await writeFile(path, long);

    const reader = new TailReader();
    const before = await reader.read(path, { headBytes: 0 });
    assert.equal(before?.linesParsed, 50);

    // Compaction rewrites the transcript to something shorter.
    await writeFile(path, JSON.stringify({ type: 'ai-title', aiTitle: 'sıkıştırılmış' }) + '\n');
    const after = await reader.read(path, { headBytes: 0 });
    assert.equal(after?.linesParsed, 1, 'counters must restart, not accumulate across a rewrite');
    assert.equal(after?.aiTitle, 'sıkıştırılmış');
    await reader.close();
  });
});

test('a huge unseen gap is skipped and reported rather than read whole', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'gap.jsonl');
    await writeFile(path, msg('user', 'başlangıç') + '\n');

    const reader = new TailReader();
    await reader.read(path, { headBytes: 0 });
    assert.equal(reader.stats().gaps, 0);

    // More than the 8 MB catch-up limit arrives while we were not looking.
    const filler = Array.from({ length: 20000 }, (_, i) =>
      msg('assistant', `dolgu ${i} ${'x'.repeat(400)}`),
    ).join('\n');
    await appendFile(path, filler + '\n');
    await appendFile(path, msg('assistant', 'son mesaj') + '\n');

    const after = await reader.read(path, { headBytes: 0 });
    const stats = reader.stats();
    await reader.close();

    assert.equal(stats.gaps, 1, 'the skip must be recorded, not silent');
    assert.ok(stats.bytesRead < 4 * 1024 * 1024, `read ${stats.bytesRead} bytes; expected ≈1 MB`);
    // The newest entry still has to be correct — that is what the skip protects.
    assert.equal(after?.lastEntryRole, 'assistant');
  });
});

test('a missing file yields null instead of throwing', async () => {
  await withTmp(async (dir) => {
    const reader = new TailReader();
    assert.equal(await reader.read(join(dir, 'yok.jsonl')), null);
    assert.equal(reader.stats().tracked, 0, 'a failed open must not leak an entry');
    await reader.close();
  });
});

test('retain closes descriptors for sessions that ended', async () => {
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    await writeFile(a, msg('user', 'a') + '\n');
    await writeFile(b, msg('user', 'b') + '\n');

    const reader = new TailReader();
    await reader.read(a, { headBytes: 0 });
    await reader.read(b, { headBytes: 0 });
    assert.equal(reader.stats().openHandles, 2);

    await reader.retain(new Set([a]));
    assert.equal(reader.stats().openHandles, 1);
    assert.equal(reader.stats().tracked, 1);
    await reader.close();
    assert.equal(reader.stats().openHandles, 0);
  });
});

test('unchanged files cost a stat and nothing else', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'idle.jsonl');
    await writeFile(path, msg('assistant', 'bekliyor') + '\n');

    const reader = new TailReader();
    await reader.read(path, { headBytes: 0 });
    const afterFirst = reader.stats().reads;
    for (let i = 0; i < 10; i++) await reader.read(path, { headBytes: 0 });
    const s = reader.stats();
    await reader.close();

    assert.equal(s.reads, afterFirst, '10 further polls must issue zero reads');
    assert.equal(s.skipped, 10);
    assert.equal(s.opens, 1, 'the descriptor must be opened once, not per poll');
  });
});

/**
 * The two free-text fields.
 *
 * `ai-title` is what the agent named the turn and `last-prompt` is literally
 * what the user typed, and both end up on three surfaces — the terminal, the
 * dashboard, and a window pinned above everything else. Redacting at each of
 * those would mean the fourth one forgets, and the fourth one is where a key
 * ends up on top of a screen share. So it happens here, at the single point
 * where this text enters the process.
 */
test('agent free text is redacted on the way in, not on the way out', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 's.jsonl');
    await writeFile(
      path,
      JSON.stringify({
        type: 'last-prompt',
        // Not a real credential: the shape is what the detector matches.
        lastPrompt: 'deploy with sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyzABCD',
      }) + '\n',
    );
    const facts = await readTranscriptFacts(path, 64 * 1024);
    assert.ok(!/sk-ant-api03-0123/.test(facts?.lastPrompt ?? ''), 'the key survived into the facts');
    // The sentence around it survives, or the field stops being worth showing.
    assert.match(facts?.lastPrompt ?? '', /deploy with/);
  });
});

/**
 * Length is part of the same guard. These strings are drawn into one row of a
 * 400-pixel window and into a database column, and an unbounded one turns a
 * transcript line into a memory amplifier for whoever wrote it.
 */
test('free text arrives already bounded', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 's.jsonl');
    await writeFile(path, JSON.stringify({ type: 'ai-title', aiTitle: 'ş'.repeat(4000) }) + '\n');
    const facts = await readTranscriptFacts(path, 64 * 1024);
    assert.ok((facts?.aiTitle ?? '').length <= 140);
  });
});
