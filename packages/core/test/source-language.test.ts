/**
 * English is the source language, and a test is the only thing that keeps it
 * that way.
 *
 * This project was written in Turkish and translated the other way round. The
 * rewrite that flipped it walked `t`, `tr`, `ph` and `data-tr` spans and
 * replaced each with its own translation -- which is exact, and blind to any
 * string that was never wrapped in one of those. Three separate rounds of
 * hand-searching later, the leftovers were still turning up: the dashboard's
 * counter strip reading "live sessions / records / dead / proje /
 * seni bekliyor", `vt uninstall` printing "silindi" against every line of its
 * manifest, the desktop shell logging its entire life in Turkish, and the npm
 * shim greeting anyone on an old Node with "VibeTracker Node 22.20+
 * gerektiriyor".
 *
 * A `tr()` key cannot hide -- `i18n-coverage` fails on a key the catalog does
 * not have. A bare literal has nothing checking it, so this checks it.
 *
 * Comments are not the target. Half the phase engine's reasoning is quoted
 * Turkish and has to be, because it is explaining what the parser matches.
 * Only what could reach a user is examined: the string literals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');

/**
 * Where Turkish inside a string is the point rather than a leak.
 *
 * Every entry is data the parsers match against, or an input the code has to
 * accept. None of it is ever shown to anyone.
 */
const TURKISH_IS_DATA = [
  // The phase engine is a language-agnostic parser fed language-specific data.
  'core/src/progress/',
  'engine/src/progress/',
  // `hayır` at a yes/no prompt: refusing to understand it because the question
  // was asked in English would be a worse answer than the one it prevents.
  'cli/src/prompt.ts',
  // A `ps` line as `tr_TR` prints it -- the exact thing the parser must survive.
  'platform/src/probe/',
  // The synthetic environment generator. Its whole job is to produce the
  // awkward machine: NFD path twins, a `Masaüstü` that slugs to `Masa-st-`,
  // casing variants. Those strings are the test subject, not the interface --
  // and the one string in there that *is* rendered, a session summary shown by
  // `vt demo`, is in English.
  'fixtures/src/',
];

/**
 * Turkish spelled without its diacritics, which is how the last round hid.
 *
 * `note.ps1` must be pure ASCII (PowerShell 5.1 reads a BOM-less script as the
 * system codepage) and the Rust log lines simply were, so a `[ışğ]` search
 * found neither. Only words that are not also English, and not also plausible
 * identifiers: `var`, `bir` and `tamam` are deliberately absent.
 */
const FOLDED = [
  'bilinmiyor', 'gerektiriyor', 'gerekiyor', 'bulunamadi', 'bulundu', 'calistir',
  'calisiyor', 'baslatil', 'baslatildi', 'kapatili', 'gosteril', 'olusturul',
  'gonderil', 'yeniden', 'sessiz', 'bekleniyor', 'bekliyor', 'silindi', 'korundu',
  'yoktu', 'hatayla', 'dosyada', 'pencere', 'oturum', 'secildi', 'guncelle',
  'kaydedildi', 'ayarlar', 'degil', 'icin', 'yazilmadi', 'okunuyordu',
];

/**
 * ...and the ones that have to be matched whole.
 *
 * `proje` is the word the dashboard actually shipped, and a stem match on it
 * also matches `project`, which is most of this codebase. A guard that fires
 * on every second line is a guard somebody deletes on its first run.
 */
const FOLDED_WHOLE = [
  'proje', 'projeler', 'hata', 'dosya', 'deger', 'kayit', 'durum', 'ayar',
  'secim', 'sayfa', 'satir', 'surum', 'zaman', 'baslik',
];

const LETTERS = /[ıİşŞğĞ]/;
const FOLDED_RE = new RegExp(
  `\\b(?:${FOLDED.join('|')})|\\b(?:${FOLDED_WHOLE.join('|')})\\b`,
  'i',
);

/**
 * Every string literal in a file, comments excluded.
 *
 * A character walk rather than a regex, because the cheap version of this --
 * strip everything after `//` -- eats the rest of any line containing a URL,
 * and a rule that quietly stops looking is worse than no rule.
 */
function stringLiterals(src: string, kind: 'ts' | 'ps1' | 'rs'): string[] {
  const out: string[] = [];
  const hashComments = kind === 'ps1';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === '\\') {
      i += 2;
      continue;
    }
    if (hashComments && c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (!hashComments && c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (!hashComments && c === '/' && next === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (c === '<' && src.startsWith('<!--', i)) {
      i = src.indexOf('-->', i + 4);
      if (i < 0) break;
      i += 3;
      continue;
    }
    // A here-string. `note.ps1` keeps the note's entire C# source inside one,
    // comments and all, so walking into it as if it were text finds an
    // apostrophe in "window's" and loses its place for the rest of the file.
    // Recursed into with C-style rules instead, which is what C# uses.
    if (c === '@' && (next === "'" || next === '"')) {
      const close = next + '@';
      const end = src.indexOf(close, i + 2);
      if (end < 0) break;
      out.push(...stringLiterals(src.slice(i + 2, end), 'rs'));
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        // A template hole is code, not text, and can hold a nested literal.
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          const start = j;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          out.push(...stringLiterals(src.slice(start, j - 1), kind));
          continue;
        }
        body += src[j];
        j++;
      }
      out.push(body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'target' || e.name === 'runtime') continue;
    if (e.name === 'lexicons' || e.name === 'locales' || e.name === '.pack') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    // Only what ships. Tests carry Turkish fixtures on purpose, and a fixture
    // is the same kind of thing as a lexicon: input, not output.
    else if (/\.(ts|html|ps1|rs)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) yield p;
  }
}

test('no shipped string literal is written in Turkish', () => {
  const offenders: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    let entries;
    try {
      entries = [...sourceFiles(src)];
    } catch {
      continue; // A package with no `src` (fixtures data, for instance).
    }
    for (const file of entries) {
      const rel = relative(PACKAGES, file).replace(/\\/g, '/');
      if (TURKISH_IS_DATA.some((allowed) => rel.startsWith(allowed))) continue;
      const kind = file.endsWith('.ps1') ? 'ps1' : file.endsWith('.rs') ? 'rs' : 'ts';
      for (const lit of stringLiterals(readFileSync(file, 'utf8'), kind)) {
        const hit = LETTERS.exec(lit) ?? FOLDED_RE.exec(lit);
        if (hit) offenders.push(`${rel} → ${JSON.stringify(lit.slice(0, 70))}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Turkish in a shipped string. English is the source language; the Turkish ' +
      'belongs in packages/core/locales/tr.json:\n  ' +
      offenders.join('\n  '),
  );
});

test('the detector finds what it is for', () => {
  // The four real leaks, as they were written. A test whose subject cannot
  // fail proves nothing about the day the subject changes.
  const samples = [
    `const label = 'proje';`,
    `return { removed: 'silindi' };`,
    `log("daemon {quiet} tur sessiz, yeniden baslatiliyor");`,
    'throw new Error(`VibeTracker Node 22.20+ gerektiriyor`);',
  ];
  for (const s of samples) {
    const found = stringLiterals(s, 'ts').some((l) => LETTERS.test(l) || FOLDED_RE.test(l));
    assert.ok(found, `not detected: ${s}`);
  }

  // ...and does not fire on the English that replaced them, nor on a comment
  // that quotes Turkish because it is explaining what a parser matches.
  const clean = [
    `const label = tr('projects');`,
    `// A commit subject says "Faz 2 tamamlandı", which is what this matches.`,
    `/* NFD is how macOS hands back a path containing ş. */`,
    `const url = 'http://127.0.0.1:47823/'; const x = 'ok';`,
  ];
  for (const s of clean) {
    const found = stringLiterals(s, 'ts').some((l) => LETTERS.test(l) || FOLDED_RE.test(l));
    assert.ok(!found, `false positive: ${s}`);
  }
});
