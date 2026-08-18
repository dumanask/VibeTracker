import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDocument,
  buildLadder,
  classifyRole,
  computePercent,
  extractItems,
  foldText,
  hasStem,
  headingPhases,
  learnLegend,
  phaseTokens,
  readStatusLines,
  defaultSymbols,
  say,
} from '../src/index.ts';

/**
 * Golden-file regressions for the progress engine.
 *
 * Every fixture below is a sanitized reconstruction of a real document from
 * the reference machine — same structure, same vocabulary, no private content.
 * The two marked TUZAK ("trap") cases are the ones a naive counter gets
 * confidently wrong, and they are the reason this engine has a role classifier
 * at all.
 */

// ── folding ───────────────────────────────────────────────────────────────

test('folding does not depend on the machine locale', () => {
  // The dotted/dotless I is the classic trap: under a Turkish locale
  // `'I'.toLowerCase()` and `'İ'.toLowerCase()` disagree with every other
  // locale. Folding must give the same answer everywhere.
  assert.equal(foldText('İPTAL'), 'iptal');
  assert.equal(foldText('IPTAL'), 'iptal');
  assert.equal(foldText('ıptal'), 'iptal');
  assert.equal(foldText('Aşama'), 'asama');
  assert.equal(foldText('GEÇMİŞ'), 'gecmis');
  assert.equal(foldText('Doğrulama'), 'dogrulama');
  assert.equal(foldText('Straße'), 'strasse');
});

test('stem matching survives Turkish suffixes but not word interiors', () => {
  // These four cost a real misclassification each: `envanteri` read as a plan.
  assert.ok(hasStem('saspera grafik envanteri', 'envanter'));
  assert.ok(hasStem('plan arsivi', 'arsiv'));
  assert.ok(hasStem('cbam detayli analizi', 'analiz'));
  assert.ok(hasStem('tenant kapsam denetimi', 'denetim'));
  assert.ok(hasStem('stage planlama', 'plan'));
  // A term buried inside another word is not a match.
  assert.ok(!hasStem('explanation', 'plan'));
  assert.ok(!hasStem('unplanned', 'plan'));
});

// ── TRAP 1: a log of finished work is not a finished project ──────────────

const TUZAK1_CHANGELOG = `# Mevcut Durum ve Devam Notu

## 2026-08-14 yapılanlar
| İş | Durum |
|---|---|
| Şema göçü yazıldı | ✅ |
| API ucu bağlandı | ✅ |
| Testler geçti | ✅ |

## 2026-08-15 yapılanlar
| İş | Durum |
|---|---|
| Önbellek eklendi | ✅ |
| Log kaydı düzeltildi | ✅ |
| Panel yenilendi | ✅ |

## 2026-08-16 yapılanlar
| İş | Durum |
|---|---|
| Dışa aktarma yazıldı | ✅ |
| Yetki kontrolü | ✅ |
| Sürüm çıkıldı | ✅ |
| Belgeler güncellendi | ✅ |
`;

test('TUZAK 1: an all-ticked worklog is not reported as 100%', () => {
  const r = analyzeDocument('05-MEVCUT-DURUM-VE-DEVAM-NOTU.md', TUZAK1_CHANGELOG);
  assert.equal(r.percent.percent, null, 'yüzde bastırılmalıydı');
  assert.notEqual(r.role, 'PLAN');
  // And it says why, in words a person can act on. The reason is a phrase
  // (template + arguments), not a finished sentence, so it survives
  // translation — see `phrase.ts`.
  assert.ok(say(r.percent.suppressed!.detail).length > 10, 'bastırma sebebi açıklanmalı');
  // The role gate fires before the counting gate, so the reason names the
  // classification rather than the tick ratio — which is the more useful of
  // the two answers: it says the document was never a plan.
  assert.match(say(r.percent.suppressed!.detail), /plan değil/);
});

test('an all-ticked document is caught even with a neutral filename', () => {
  // The filename hint is removed so only the structural rule can save us.
  const r = analyzeDocument('notlar.md', TUZAK1_CHANGELOG);
  assert.equal(r.percent.percent, null);
});

// ── TRAP 2: competitor ticks are not progress ─────────────────────────────

const TUZAK2_RESEARCH = `# Pazar ve Rakip Analizi

| Özellik | BridgeMind | MetaGPT | n8n | Dify | Bizde |
|---|---|---|---|---|---|
| Görsel akış | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kod üretimi | ✅ | ✅ | ❌ | ✅ | ✅ |
| Çoklu ajan | ✅ | ✅ | ✅ | ❌ | ✅ |
| Yerel çalıştırma | ✅ | ❌ | ✅ | ✅ | ✅ |
| Eklenti sistemi | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fiyatlandırma | ✅ | ✅ | ✅ | ✅ | ✅ |
| Topluluk | ✅ | ✅ | ✅ | ✅ | ✅ |
| Belgelendirme | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kurumsal destek | ✅ | ❌ | ✅ | ✅ | ❌ |
| Denetim kaydı | ✅ | ✅ | ❌ | ✅ | ✅ |
`;

test('TUZAK 2: ticks in a comparison table never become progress', () => {
  const r = analyzeDocument('pazar-ve-firsatlar.md', TUZAK2_RESEARCH);
  assert.equal(r.percent.percent, null, 'rakip tablosu ilerleme sayılmamalı');
  assert.equal(r.role, 'RESEARCH');
});

test('the extractor ignores comparison ticks even inside a real plan', () => {
  // The stronger guarantee: a genuine plan that also contains a competitor
  // matrix must count only its own status column.
  const mixed = `# Geliştirme Planı

> **Durum (2026-08-17):** Faz 1 tamamlandı, Faz 2 devam ediyor.

## Rakip karşılaştırması
| Özellik | Rakip A | Rakip B |
|---|---|---|
| Akış | ✅ | ✅ |
| Rapor | ✅ | ✅ |
| SSO | ✅ | ✅ |

## Görevler
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
  const r = analyzeDocument('gelistirme-plani.md', mixed);
  const table = r.items.filter((i) => i.extractor === 'table');
  assert.equal(table.length, 8, `durum sütunundan 8 madde beklendi, ${table.length} geldi`);
  assert.equal(r.percent.counts.done, 3, 'yalnızca durum sütunundaki ✅ sayılmalı');
  assert.equal(r.percent.percent, 38);
});

// ── phase ladders ─────────────────────────────────────────────────────────

test('an inflected phase reference does not declare a phase', () => {
  // Measured: 15 of 248 heading phase tokens in the corpus are inflected.
  // Each one would otherwise invent a phantom phase at the *start* of the
  // ladder, which is the worst place for a phantom to be.
  assert.equal(phaseTokens("## 4.1 Aşama 1'in sınırları").length, 0);
  assert.equal(phaseTokens("## 12.11 Faz 0'a eklenen doğrulama adımları").length, 0);
  assert.equal(phaseTokens("### Aşama 2'de silinecek").length, 0);
  // The same words without a suffix do declare one.
  assert.equal(phaseTokens('## Aşama 1 — dosya listesi').length, 1);
  assert.equal(phaseTokens('## Faz 0 — Doğrulama (0,5 gün)')[0]?.ordinal, 0);
});

test('one heading can declare two phases', () => {
  const found = headingPhases('## Faz 4 + Faz 5 ✅ **UYGULANDI (2026-07-28)**', defaultSymbols());
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((f) => f.ordinal),
    [4, 5],
  );
  assert.ok(found.every((f) => f.status === 'done'));
});

test('a status line yields the ladder, the date and the remaining work', () => {
  const lines = readStatusLines(
    '> **Durum (2026-08-17):** Faz 0 ve Faz 1 tamamlandı. Kalan: panel entegrasyonu.',
  );
  assert.equal(lines.length, 1);
  const s = lines[0]!;
  assert.equal(new Date(s.declaredAt!).toISOString().slice(0, 10), '2026-08-17');
  assert.deepEqual(
    s.phases.map((p) => p.ordinal),
    [0, 1],
  );
  assert.ok(s.phases.every((p) => p.status === 'done'));
  assert.match(s.remaining!, /panel entegrasyonu/);
});

test('a phase range names every phase in it', () => {
  const s = readStatusLines('> **Durum:** Faz 1–5 tamamlandı.')[0]!;
  assert.deepEqual(
    s.phases.map((p) => p.ordinal),
    [1, 2, 3, 4, 5],
  );
});

test('the ladder is done only through a contiguous prefix', () => {
  // Phase 5 finished while phase 3 is open does not mean the project is at 5.
  const ladders = buildLadder([
    { labelRaw: 'Faz 1', unit: 'faz', ordinal: 1, status: 'done', line: 1 },
    { labelRaw: 'Faz 2', unit: 'faz', ordinal: 2, status: 'done', line: 2 },
    { labelRaw: 'Faz 3', unit: 'faz', ordinal: 3, status: 'todo', line: 3 },
    { labelRaw: 'Faz 5', unit: 'faz', ordinal: 5, status: 'done', line: 4 },
  ]);
  assert.equal(ladders[0]!.doneThrough, 2);
  assert.equal(ladders[0]!.total, 5);
});

test('the same phase named a dozen times is one rung', () => {
  const doc = `## 4.6 Aşama 1 — dosya listesi
## 4.7 Aşama 1 — bitti ölçütleri
## 4.8 Aşama 1 — uygulama durumu ✅
## Aşama 2 — sonraki
`;
  const ladders = buildLadder(headingPhases(doc, defaultSymbols()));
  assert.equal(ladders[0]!.entries.length, 2);
  assert.equal(ladders[0]!.entries[0]!.status, 'done', 'en ileri durum kazanmalı');
});

// ── legends ───────────────────────────────────────────────────────────────

test('a document that defines its own legend is read by its own rules', () => {
  const doc = `# Plan

## İşaretler
- 🔵 = tamamlandı
- 🟠 = devam ediyor

| İş | Durum |
|---|---|
| A | 🔵 |
| B | 🔵 |
| C | 🟠 |
| D | 🟠 |
| E | 🟠 |
| F | 🟠 |
| G | 🟠 |
| H | 🟠 |
`;
  const symbols = learnLegend(doc);
  assert.equal(symbols.get('🔵'), 'done');
  assert.equal(symbols.get('🟠'), 'partial');
  const items = extractItems(doc, symbols).items.filter((i) => i.extractor === 'table');
  assert.equal(items.length, 8);
});

test('a warning triangle is never a status', () => {
  // 588 of these in the corpus, essentially all of them prose warnings.
  assert.equal(defaultSymbols().get('⚠️'), undefined);
  assert.equal(defaultSymbols().get('⚠'), undefined);
});

// ── percentage gates ──────────────────────────────────────────────────────

test('too few items produces no number at all', () => {
  const r = computePercent({
    items: [
      { text: 'a', status: 'done', weight: 1, line: 1, extractor: 'checkbox' },
      { text: 'b', status: 'todo', weight: 1, line: 2, extractor: 'checkbox' },
    ],
    countable: true,
    roleLabel: 'PLAN',
  });
  assert.equal(r.percent, null);
  assert.equal(r.suppressed!.code, 'too_few_items');
});

test('dropped work leaves both sides of the fraction', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    text: `i${i}`,
    status: (i < 6 ? 'done' : i < 9 ? 'todo' : 'dropped') as const,
    weight: 1,
    line: i,
    extractor: 'checkbox' as const,
  }));
  const r = computePercent({ items, countable: true, roleLabel: 'PLAN' });
  // 6 done of 9 live items, not 6 of 12: descoped work must not cap the
  // project below 100% forever.
  assert.equal(r.totalWeight, 9);
  assert.equal(r.percent, 67);
});

test('effort weights change the denominator, not the rules', () => {
  const doc = `# Plan

| İş | Efor | Durum |
|---|---|---|
| Küçük | S | ✅ |
| Orta | M | ✅ |
| Büyük | L | ⬜ |
| Büyük iki | L | ⬜ |
`;
  const items = extractItems(doc, defaultSymbols()).items;
  assert.deepEqual(
    items.map((i) => i.weight),
    [1, 3, 8, 8],
  );
});

// ── role classification ───────────────────────────────────────────────────

test('a document that declares its own role is believed', () => {
  const asPlan = classifyRole({
    fileName: 'notlar.md',
    text: '> **Durum:** AKTİF plan (Faz 0 indi) · **Tarih:** 2026-08-16',
  });
  assert.equal(asPlan.role, 'PLAN');

  const asReport = classifyRole({
    fileName: 'notlar.md',
    text: '**Durum:** RAPOR — kod düzeltmesi yapılmadı',
  });
  assert.equal(asReport.role, 'CHANGELOG');
  assert.equal(asReport.countable, false);
});

test('a specific name outvotes the generic word "plan"', () => {
  // 98 of 182 files in the corpus have "plan" in the name; it is the default
  // and means almost nothing. "arşiv" is a deliberate description.
  const r = classifyRole({ fileName: 'plan-arsivi.md', text: '# Plan Arşivi\n' });
  assert.equal(r.role, 'CHANGELOG');
  assert.equal(r.countable, false);
});

test('an unrecognizable document is ambiguous, not optimistically a plan', () => {
  const r = classifyRole({ fileName: 'xyzzy.md', text: '# xyzzy\n\nbir şeyler\n' });
  assert.equal(r.role, 'AMBIGUOUS');
  assert.equal(r.countable, false);
});
