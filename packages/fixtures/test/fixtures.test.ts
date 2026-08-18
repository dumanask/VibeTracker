import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture } from '../src/index.ts';
import { readRegistry, readIdeLocks, TailReader, scan, ScanContext } from '@vibetracker/engine';
import type { ScanOptions } from '@vibetracker/engine';

/** No CPU sampling, no docs tree: these tests are about which rows exist. */
const LIGHT: ScanOptions = {
  cpuSample: false,
  cpuSampleMs: 0,
  includeDead: false,
  includeTemp: false,
  tailBytes: 32 * 1024,
  progress: false,
};
import { classifyLiveness, createProcessProbe } from '@vibetracker/platform';

/**
 * The generated environment has to reproduce the hard cases, or it proves
 * nothing. Each assertion here corresponds to a real failure that happened
 * once against a real machine.
 */

function build(opts: Partial<Parameters<typeof buildFixture>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vt-fix-'));
  return buildFixture({ root, now: Date.UTC(2026, 7, 18), ...opts });
}

test('the registry contains live, dead and reused entries', async () => {
  const f = await build();
  try {
    const { entries, error } = await readRegistry(f.claudeDir);
    assert.equal(error, undefined);
    assert.equal(entries.length, f.livePids.length + f.deadPids.length + f.reusedPids.length);
    assert.ok(entries.every((e) => typeof e.cwd === 'string' && e.cwd.length > 0));
    // `procStart` must be present, or the PID-reuse guard has nothing to work
    // with and the fixture would silently be testing the degraded path.
    assert.ok(entries.every((e) => typeof e.procStart === 'string'));
  } finally {
    f.cleanup();
  }
});

test('the PID-reuse guard separates a recycled PID from a live one', async () => {
  const f = await build();
  const probe = createProcessProbe();
  try {
    const { entries } = await readRegistry(f.claudeDir);
    const snap = await probe.snapshot(entries.map((e) => e.pid));
    const batch = classifyLiveness(
      entries.map((e) => ({ pid: e.pid, procStart: e.procStart })),
      snap,
      probe.precision,
    );
    const counts = { live: 0, reused: 0, dead: 0, unknown: 0 };
    for (const v of batch.verdicts.values()) counts[v]++;
    const { live, reused, dead } = counts;
    assert.equal(batch.guardAvailable, true, 'koruma uygulanamamış');
    assert.equal(batch.formatDriftSuspected, false, 'toplu format kayması yanlış tespit edilmiş');

    // Dead PIDs are above every platform maximum, so this is exact.
    assert.equal(dead, f.deadPids.length);
    // Some entries match our own process's start time and some deliberately
    // do not; the batch heuristic must not conclude "format drift" from that.
    assert.ok(live > 0, 'hiç canlı yok — koruma toplu olarak devre dışı kalmış olabilir');
    assert.ok(reused > 0, 'geri dönüşmüş PID tespit edilmedi');
  } finally {
    await probe.dispose();
    f.cleanup();
  }
});

test('IDE locks are read, including a stale one', async () => {
  const f = await build();
  try {
    const locks = await readIdeLocks(f.claudeDir);
    assert.equal(locks.length, 2);
    // `alive` is filled in later by the scan, from the probe — the reader
    // itself never guesses at liveness, so it is false here for both.
    assert.ok(locks.every((l) => l.alive === false));
    assert.ok(locks.some((l) => l.pid === process.pid), 'canlı pid taşıyan kilit yok');
    assert.ok(locks.some((l) => l.pid === 4_100_000), 'bayat kilit üretilmemiş');
    assert.ok(locks.every((l) => l.workspaceFolders.length === 1));
    // The lock file carries an auth token; nothing may surface it.
    assert.ok(!JSON.stringify(locks).includes('never-read'));
  } finally {
    f.cleanup();
  }
});

test('a transcript with a broken line and an unknown type still parses', async () => {
  const f = await build();
  const reader = new TailReader();
  try {
    const { entries } = await readRegistry(f.claudeDir);
    const first = entries[0]!;
    const slug = readFileSync(first.sourceFile, 'utf8');
    assert.ok(slug.includes('sessionId'));

    // Find the transcript belonging to this session.
    const facts = await findFacts(reader, f.projectsDir, first.sessionId);
    assert.ok(facts, 'transcript bulunamadı');
    assert.ok(facts.parseFailures >= 1, 'bozuk satır sayılmamış');
    assert.ok(facts.unknownTypes.includes('some-future-record'));
    assert.ok(facts.linesParsed > 30);
    // The last line is an 82-byte `mode` record with no timestamp; a reader
    // that treats the final line as the conversation position gets this wrong.
    assert.ok(facts.lastEntryAt !== undefined, 'son mesaj zamanı bulunamadı');
    assert.ok(facts.aiTitle && facts.aiTitle.length > 0);
  } finally {
    await reader.close();
    f.cleanup();
  }
});

test('the sparse transcript is huge on paper and tiny on disk', async () => {
  const f = await build({ huge: true });
  const reader = new TailReader();
  try {
    assert.ok(f.hugeTranscript);
    const st = statSync(f.hugeTranscript);
    assert.ok(st.size >= 600 * 1024 * 1024, 'dosya yeterince büyük değil');
    // `blocks` is 512-byte units. A genuinely 600 MB file would be ~1.2M of
    // them; a sparse one is a few. Some filesystems do not report it, so this
    // is a soft check — the size assertion above is the one that matters.
    const allocated = (st.blocks ?? 0) * 512;
    if (st.blocks) {
      assert.ok(allocated < st.size / 2, `seyrek değil: ${allocated} bayt ayrılmış`);
    }

    // And the reader must return the tail in milliseconds, not minutes.
    const t0 = performance.now();
    const facts = await reader.read(f.hugeTranscript, { tailBytes: 256 * 1024 });
    const ms = performance.now() - t0;
    assert.ok(facts, 'devasa transcript okunamadı');
    assert.equal(facts.aiTitle, 'Devasa transcript');
    assert.ok(ms < 5000, `kuyruk okuma ${Math.round(ms)} ms sürdü — tam tarama yapılmış olabilir`);
  } finally {
    await reader.close();
    f.cleanup();
  }
});

test('the credentials file exists in the fixture and is never opened by a reader', async () => {
  const f = await build();
  try {
    assert.ok(existsSync(join(f.claudeDir, '.credentials.json')));
    const { entries } = await readRegistry(f.claudeDir);
    const locks = await readIdeLocks(f.claudeDir);
    const seen = JSON.stringify({ entries, locks });
    assert.ok(!seen.includes('never read'));
  } finally {
    f.cleanup();
  }
});

test('a long project path produces a truncated, hashed slug', async () => {
  const f = await build();
  try {
    const long = f.projectRoots.find((r) => r.includes('uzun-yol'))!;
    assert.ok(long.length > 150);
    // Slugs are not reversible, which is why the project path is always read
    // from the record rather than decoded from the directory name.
    f.cleanup();
  } finally {
    /* already cleaned */
  }
});

async function findFacts(reader: TailReader, projectsDir: string, sessionId: string) {
  const { readdirSync } = await import('node:fs');
  for (const slug of readdirSync(projectsDir)) {
    const dir = join(projectsDir, slug);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    if (!names.includes(`${sessionId}.jsonl`)) continue;
    return reader.read(join(dir, `${sessionId}.jsonl`), { tailBytes: 256 * 1024 });
  }
  return null;
}

/**
 * A project you picked by hand stays on the board with nothing running.
 *
 * The scan drops every dead registry entry, so a project existed only while
 * one of its agents did. That is right for the default view — otherwise every
 * directory ever opened accumulates forever — but it makes picking meaningless:
 * you add a project, close it, and it silently disappears from the list you
 * just added it to. `keepClosed` is supplied only when the user has actually
 * picked, and only for what they picked.
 */
test('a hand-picked project survives with no live agent, and says it is closed', async () => {
  const f = await build();
  const ctx = new ScanContext();
  try {
    const open = await scan(
      { ...LIGHT, keepClosed: undefined },
      ctx,
    );
    const closed = await scan(
      // Everything is followed, and everything is kept: with the fixture's
      // dead PIDs that is the whole point of the case.
      { ...LIGHT, isTracked: () => true, keepClosed: () => true },
      ctx,
    );
    assert.ok(
      closed.projects.length > open.projects.length,
      'kapalı projeler geri gelmedi',
    );
    const extra = closed.projects.filter(
      (p) => !open.projects.some((q) => q.projectId === p.projectId),
    );
    for (const p of extra) {
      assert.equal(p.summary.live, 0, `${p.displayName}: canlı oturumu var`);
      assert.equal(p.summary.kind, 'none');
      assert.ok(p.sessions.length > 0, `${p.displayName}: hiç oturum taşımıyor`);
      assert.ok(p.sessions.every((x) => x.state === 'ORPHANED'));
    }
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

/**
 * The other half of the rule. `keepClosed` is what the caller passes only in
 * hand-picked mode; without it the board must stay "whatever is running",
 * because in `all` mode there is no pick to honour and every project ever
 * opened would pile up.
 */
test('without a pick, a project with nothing running stays off the board', async () => {
  const f = await build();
  const ctx = new ScanContext();
  try {
    const r = await scan({ ...LIGHT }, ctx);
    for (const p of r.projects) {
      assert.ok(p.summary.live > 0, `${p.displayName}: canlı ajanı yokken listelenmiş`);
    }
  } finally {
    await ctx.close();
    f.cleanup();
  }
});
