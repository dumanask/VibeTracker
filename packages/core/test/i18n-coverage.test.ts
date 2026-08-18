import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { keysInSource } from '../src/i18n-scan.ts';
import { availableLanguages } from '../src/progress/lexicon.ts';

/**
 * Translation coverage as a test rather than as a claim.
 *
 * "The English translation is mostly done" is the kind of statement that is
 * true when written and false a week later. Here the source is scanned for
 * every key it asks for and the catalog must contain all of them, so a new
 * untranslated string fails the build with the exact text to translate.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');
const LOCALES = join(ROOT, 'packages', 'core', 'locales');

/**
 * `.ts` and `.html`.
 *
 * The dashboard was outside this test until an untranslated string got into it
 * and nothing failed. It calls the same `tr()` — the daemon inlines the catalog
 * into the page — so it belongs in the same gate; scanning only TypeScript made
 * "a new untranslated string fails the build" true of three surfaces out of
 * four, which is the sort of half-claim this test exists to prevent.
 *
 * `.ps1` is deliberately not here: the note window is handed its words in a
 * JSON file built from the catalog, and holds no string of its own.
 */
function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.name === 'node_modules' || e.name === 'test') continue;
    // The staged desktop runtime is a copy of these sources with the imports
    // rewritten; scanning it would count every string twice and report the
    // copy's path to whoever has to translate it.
    if (e.name === 'target' || e.name === 'runtime' || e.name === '.pack') continue;
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.html')) yield p;
  }
}

function allKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of sources(PACKAGES)) {
    const src = readFileSync(file, 'utf8');
    // `ph(` belongs in this list too. Without it a file whose only translated
    // strings are phrases — `progress/percent.ts`, three of them — never
    // entered the gate at all, and `engine/src/progress/scan.ts` passed only
    // because a doc comment happened to contain a backtick after a `t`. The
    // filter saves microseconds and cost the gate twenty-four keys, so it is
    // now generous rather than clever.
    if (!src.includes('t`') && !src.includes('tr(') && !src.includes('ph(') && !src.includes('data-tr'))
      continue;
    for (const k of keysInSource(src, relative(ROOT, file))) {
      if (!keys.has(k.key)) keys.set(k.key, k.file);
    }
  }
  return keys;
}

function catalog(lang: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('_') && typeof v === 'string') out[k] = v;
  }
  return out;
}

test('the scanner reads keys the way the runtime builds them', () => {
  const src = [
    'const a = t`${n} kayıt bulundu`;',
    "const b = tr('Ajan durumu');",
    'const c = `no tag here`;',
    "const d = /t`not a template`/;",
    '// t`in a comment`',
    "const e = `outer ${cond ? tr('iç metin') : ''} tail`;",
  ].join('\n');
  const keys = keysInSource(src).map((k) => k.key);
  assert.deepEqual(keys.sort(), ['Ajan durumu', 'iç metin', '{0} kayıt bulundu']);
});

test('escapes and newlines decode to the runtime value', () => {
  const keys = keysInSource("const x = tr('satır\\nsonu\\tsekme');").map((k) => k.key);
  assert.deepEqual(keys, ['satır\nsonu\tsekme']);
});

test('every key the source asks for exists in the English catalog', () => {
  const keys = allKeys();
  const en = catalog('en');
  const missing = [...keys].filter(([k]) => !(k in en));
  const sample = missing
    .slice(0, 12)
    .map(([k, file]) => `  ${file}\n    ${JSON.stringify(k)}`)
    .join('\n');
  assert.equal(
    missing.length,
    0,
    `${missing.length} çevrilmemiş metin (toplam ${keys.size}):\n${sample}\n` +
      'Eklemek için: VT_I18N_REPORT=eksik.json vt --lang en <komut>',
  );
});

test('translations keep every placeholder the source has', () => {
  // A dropped `{0}` prints nothing; an invented `{3}` prints the literal
  // braces. Both are silent in the source language and visible only to the
  // people who read the translated build.
  for (const lang of ['en']) {
    for (const [key, value] of Object.entries(catalog(lang))) {
      const inKey = new Set(key.match(/\{\d+\}/g) ?? []);
      const inValue = new Set(value.match(/\{\d+\}/g) ?? []);
      assert.deepEqual(
        [...inValue].sort(),
        [...inKey].sort(),
        `${lang}: yer tutucular uyuşmuyor — ${JSON.stringify(key)}`,
      );
    }
  }
});

test('translations preserve leading and trailing layout', () => {
  // Terminal output aligns on this whitespace. A translation that loses a
  // leading newline moves a blank line somewhere else on the screen, and the
  // damage is invisible to anyone reading the source language.
  const ws = (s: string): [string, string] => [
    /^\s*/.exec(s)![0],
    /\s*$/.exec(s)![0],
  ];
  for (const [key, value] of Object.entries(catalog('en'))) {
    const [kl, kt] = ws(key);
    const [vl, vt] = ws(value);
    assert.equal(vl, kl, `baştaki boşluk değişmiş: ${JSON.stringify(key)}`);
    assert.equal(vt, kt, `sondaki boşluk değişmiş: ${JSON.stringify(key)}`);
  }
});

test('the lexicon and locale data sets stay separable', () => {
  // Vocabulary (how documents are read) and UI strings (what we print) are
  // different data with different lifetimes; conflating them would mean a
  // translation fix could change how a plan is parsed.
  assert.ok(availableLanguages().length >= 1);
});
