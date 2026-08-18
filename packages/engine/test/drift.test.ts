import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { say } from '@vibetracker/core';
import type { GitFacts } from '@vibetracker/platform';
import { readProjectProgress, type PriorReading } from '../src/progress/scan.ts';

/**
 * Drift detectors D1-D6.
 *
 * Each one exists because a plan is a *claim* and git is *evidence*, and the
 * interesting cases are where they disagree. The tests below are as much
 * about the detectors staying quiet as about them firing: a dashboard that
 * cries wolf on every project teaches you to ignore it, which costs more than
 * having no detector at all.
 */

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 7, 18);

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vt-drift-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

function git(over: Partial<GitFacts> = {}): GitFacts {
  return {
    toplevel: '/x',
    commonDir: '/x/.git',
    isWorktree: false,
    rootSha: 'abc123',
    branch: 'main',
    headSha: 'def456',
    headSubject: 'work',
    headAtMs: NOW - DAY,
    commitCount: 40,
    dirtyCount: 0,
    dirtyIsBuildNoise: false,
    dirtyPaths: [],
    remote: null,
    ...over,
  };
}

/** A plan with a real ladder and a countable task table. */
const PLAN = `# Geliştirme Planı

> **Durum (2026-08-17):** Faz 1 tamamlandı, Faz 2 devam ediyor.

## Faz 1 — Temel ✅
## Faz 2 — Panel
## Faz 3 — Yayın

| İş | Durum |
|---|---|
| Şema | ✅ |
| API | ✅ |
| Panel | ⬜ |
| Test | ⬜ |
| Yayın | ⬜ |
| Belge | ⬜ |
| Göç | ✅ |
| İzleme | ⬜ |
`;

function codes(drift: Array<{ code: string }>): string[] {
  return drift.map((d) => d.code).sort();
}

test('a clean project trips no detector', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, { git: git(), now: NOW });
    assert.deepEqual(codes(r.drift), []);
    // One rung of three, not four items of nine.
    //
    // Both numbers are true and they measure different things: the item count
    // measures one document, the ladder measures the project. A plan that
    // says "Faz 1 done, Faz 2 under way, Faz 3 to come" has decomposed the
    // whole job, and the coarse reading of the right subject beats the
    // precise reading of the wrong one — which is why it arrives rounded and
    // flagged approximate rather than as `33`.
    assert.equal(r.percent, 30);
    assert.equal(r.basis, 'milestones');
    assert.equal(r.approximate, true);
    assert.equal(r.phase?.labelRaw, 'Faz 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4: a finished phase with an unclean tree is reported', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const dirty = Array.from({ length: 30 }, (_, i) => `src/mod${i}.ts`);
    const r = await readProjectProgress(root, {
      git: git({ dirtyPaths: dirty, dirtyCount: dirty.length }),
      now: NOW,
    });
    assert.ok(codes(r.drift).includes('D4_done_but_dirty'));
    const d = r.drift.find((x) => x.code === 'D4_done_but_dirty')!;
    assert.match(say(d.claim), /Faz 1/);
    assert.match(say(d.evidence), /30/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 stays quiet when the mess is build output', async () => {
  // `dirtyPaths` already excludes build noise upstream, so an empty list with
  // a large count is exactly the "target/ is churning" case.
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, {
      git: git({ dirtyPaths: [], dirtyCount: 500, dirtyIsBuildNoise: true }),
      now: NOW,
    });
    assert.ok(!codes(r.drift).includes('D4_done_but_dirty'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D5: a frozen ratio fires only when work actually continued', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  const prior: PriorReading = {
    at: NOW - 30 * DAY,
    doneWeight: 4,
    totalWeight: 9,
    ordinal: 2,
  };
  try {
    const busy = await readProjectProgress(root, {
      git: git(),
      now: NOW,
      prior,
      activitySince: 12,
    });
    assert.ok(codes(busy.drift).includes('D5_frozen_ratio'));
    assert.match(say(busy.drift.find((d) => d.code === 'D5_frozen_ratio')!.evidence), /12/);

    // Same frozen numbers, but nobody worked: that is a dormant project, and
    // reporting it as drift would be noise.
    const idle = await readProjectProgress(root, {
      git: git(),
      now: NOW,
      prior,
      activitySince: 0,
    });
    assert.ok(!codes(idle.drift).includes('D5_frozen_ratio'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D5 does not fire when the numbers moved', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, {
      git: git(),
      now: NOW,
      prior: { at: NOW - 30 * DAY, doneWeight: 1, totalWeight: 9, ordinal: 1 },
      activitySince: 9,
    });
    assert.ok(!codes(r.drift).includes('D5_frozen_ratio'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D5 cannot fire without history, and says nothing rather than guessing', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, { git: git(), now: NOW });
    assert.ok(!codes(r.drift).includes('D5_frozen_ratio'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D6: a branch naming a phase no plan knows about', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, {
      git: git({ branch: 'faz9/deneme' }),
      now: NOW,
    });
    assert.ok(codes(r.drift).includes('D6_branch_phase_unknown'));
    assert.match(say(r.drift.find((d) => d.code === 'D6_branch_phase_unknown')!.evidence), /faz9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D6 stays quiet when the branch names a rung the plan has', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, { git: git({ branch: 'faz2/panel' }), now: NOW });
    assert.ok(!codes(r.drift).includes('D6_branch_phase_unknown'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 still overrules the plan with the branch, and suppresses the number', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, { git: git({ branch: 'faz3/yayin' }), now: NOW });
    assert.ok(codes(r.drift).includes('D1_plan_vs_branch'));
    // Evidence beats claim — and a contradicted plan produces no percentage.
    assert.equal(r.phase?.basis, 'git');
    assert.equal(r.percent, null);
    assert.match(say(r.percentSuppressed!), /çelişiyor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the report carries the weights a caller needs to detect movement later', async () => {
  const root = fixture({ 'plans/plan.md': PLAN });
  try {
    const r = await readProjectProgress(root, { git: git(), now: NOW });
    assert.equal(r.doneWeight, 4);
    assert.equal(r.totalWeight, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The spine: which ladder, if any, is allowed to say where a project is.
 *
 * Every case below is a shape that appeared on the reference machine and was
 * answered wrongly before these rules existed.
 */

test('ladders are never merged across documents', async () => {
  // Two unrelated feature plans, each with its own `Faz` sequence: one
  // finished, one not started. Merged, they read as a single seven-rung
  // ladder standing at zero — which is what a 72-document repository actually
  // reported, and it was not true of either feature or of the project.
  const root = fixture({
    'plans/su.md': ['# Su', '## Faz 1 ✅', '## Faz 2 ✅', '## Faz 3 ✅'].join('\n'),
    'plans/izleme.md': ['# İzleme', '## Faz 1', '## Faz 2', '## Faz 3'].join('\n'),
  });
  try {
    const r = await readProjectProgress(root, { now: NOW });
    assert.equal(r.phase, null);
    assert.equal(r.basis !== 'milestones', true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a ladder with nothing done, or everything done, locates nothing', async () => {
  const empty = fixture({
    'plans/plan.md': ['# P', '## Faz 1', '## Faz 2', '## Faz 3'].join('\n'),
  });
  const full = fixture({
    'plans/plan.md': ['# P', '## Faz 1 ✅', '## Faz 2 ✅', '## Faz 3 ✅'].join('\n'),
  });
  try {
    // A ladder with no marks is a table of contents; one with every mark is a
    // finished piece of work. In both the project's position is elsewhere.
    assert.equal((await readProjectProgress(empty, { now: NOW })).phase, null);
    assert.equal((await readProjectProgress(full, { now: NOW })).phase, null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  }
});

test('a descoped rung is not progress', async () => {
  // `iptal` cancels a phase; it does not achieve one. Counting it as done
  // made a project's i18n plan report the whole repository as one seventh
  // finished, off the strength of a rung nobody ever built.
  const root = fixture({
    'plans/plan.md': ['# P', '## Faz 1', '## Faz 2', '## Faz 3 — iptal'].join('\n'),
  });
  try {
    const r = await readProjectProgress(root, { now: NOW });
    assert.equal(r.phase, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two documents with rival ladders produce no phase, and say why', async () => {
  const root = fixture({
    'plans/a.md': ['# A', '## Faz 1 ✅', '## Faz 2', '## Faz 3'].join('\n'),
    'plans/b.md': ['# B', '## Aşama 1 ✅', '## Aşama 2 ✅', '## Aşama 3'].join('\n'),
  });
  try {
    const r = await readProjectProgress(root, { now: NOW });
    assert.equal(r.phase, null);
    // Refusing is only useful if the refusal is legible.
    assert.match(say(r.phaseSuppressed!), /belirsiz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the percentage is the whole documented backlog, not the newest file', async () => {
  // The rule this replaces was "most recently touched plan wins", so opening
  // a small side checklist moved the project's number. Here the side list is
  // written last and must not take the project over.
  const root = fixture({
    'plans/ana.md': [
      '# Ana plan',
      '- [x] bir',
      '- [x] iki',
      '- [x] üç',
      '- [x] dört',
      '- [x] beş',
      '- [x] altı',
      '- [ ] yedi',
      '- [ ] sekiz',
    ].join('\n'),
    'plans/yan.md': [
      '# Yan liste',
      '- [ ] a',
      '- [ ] b',
      '- [ ] c',
      '- [ ] d',
    ].join('\n'),
  });
  try {
    const r = await readProjectProgress(root, { now: NOW });
    // 6 of 12 across both, not 0 of 4 from whichever was saved last.
    assert.equal(r.percent, 50);
    assert.equal(r.doneWeight, 6);
    assert.equal(r.totalWeight, 12);
    assert.match(say(r.provenance!), /6\/12/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the provenance names the same numerator the percentage came from', async () => {
  // Partial work counts as half. Printing the plain count of finished items
  // beside a percentage computed with that half credit produced "1/12 madde ·
  // %25" on screen: arithmetic that cannot be checked is arithmetic that is
  // not believed.
  const root = fixture({
    'plans/plan.md': [
      '# P',
      '- [x] bir',
      '- [ ] iki',
      '- [ ] üç',
      '- [ ] dört',
      '- [ ] beş',
      '- [ ] altı',
      '- [ ] yedi',
      '- [ ] sekiz',
      '',
      '| İş | Durum |',
      '|---|---|',
      '| dokuz | ◐ |',
      '| on | ⬜ |',
    ].join('\n'),
  });
  try {
    const r = await readProjectProgress(root, { now: NOW });
    const said = say(r.provenance!);
    const m = /([\d.]+)\/([\d.]+)/.exec(said);
    assert.ok(m, `beklenen pay/payda: ${said}`);
    assert.equal(Math.round((Number(m[1]) / Number(m[2])) * 100), r.percent);
    // And the half-credit survives to the screen rather than being rounded.
    assert.match(said, /1\.5\/10/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
