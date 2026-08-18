import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Rules about the bytes of the source itself.
 *
 * This file exists because of a real, expensive bug: a raw NUL had replaced a
 * space inside one of two otherwise identical map keys. On screen the two
 * lines were the same, every lookup missed, and a counter silently stayed at
 * zero. Nothing about it was visible in a diff, a review, or a terminal.
 *
 * Invisible characters in source are not a style question. They are a class of
 * bug that cannot be found by reading, so they are banned by a test instead.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');

function* files(dir: string, exts: string[]): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Generated trees. `target` is Rust build output (which contains, among
    // other things, HTML with escape characters in it), and `runtime` is the
    // staged desktop payload -- a copy of these very sources plus a Node
    // binary. Scanning either means auditing our own output as if someone had
    // written it, and in `runtime`'s case counting every string twice.
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.name === 'target' || e.name === 'runtime' || e.name === '.pack') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p, exts);
    else if (exts.some((x) => e.name.endsWith(x))) yield p;
  }
}

/**
 * Tab and newline are ordinary. Everything else below 0x20, plus DEL, is
 * invisible and has no business in this codebase — where such a character is
 * genuinely needed it is written as an escape (`'\u0000'`).
 */
const FORBIDDEN = (b: number): boolean =>
  (b < 0x09 && b !== 0x00) || b === 0x0b || b === 0x0c || (b > 0x0d && b < 0x20) || b === 0x7f || b === 0x00;

test('no source file contains an invisible control character', () => {
  const offenders: string[] = [];
  for (const file of files(PACKAGES, ['.ts', '.json', '.html', '.mjs', '.ps1'])) {
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      if (FORBIDDEN(buf[i]!)) {
        const line = buf.subarray(0, i).toString('utf8').split('\n').length;
        offenders.push(`${relative(ROOT, file)}:${line} → 0x${buf[i]!.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Görünmez kontrol karakteri bulundu. Kaçış dizisi kullan ('\\u0000'):\n  ${offenders.join('\n  ')}`,
  );
});

test('no source file carries a byte-order mark', () => {
  // A BOM ends up inside the first token — a JSON key, an import specifier —
  // and produces errors that name something the reader can plainly see is
  // correct.
  const offenders: string[] = [];
  for (const file of files(PACKAGES, ['.ts', '.json', '.html', '.mjs', '.ps1'])) {
    const buf = readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `BOM bulundu:\n  ${offenders.join('\n  ')}`);
});

test('locale catalogs are valid JSON objects of strings', () => {
  const dir = join(PACKAGES, 'core', 'locales');
  for (const file of files(dir, ['.json'])) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      assert.equal(typeof v, 'string', `${relative(ROOT, file)}: ${k} metin değil`);
    }
  }
});

/**
 * PowerShell scripts must be pure ASCII.
 *
 * Windows PowerShell 5.1 reads a `.ps1` without a byte-order mark using the
 * system ANSI codepage, so a Turkish "ç" in the source arrives as mojibake on
 * screen — which is exactly what happened the first time the pinned note was
 * run. A BOM would fix the encoding and break the rule above it, so the rule
 * is the other way round: the scripts hold no non-ASCII bytes at all, and
 * every word they display is handed to them at runtime.
 */
test('powershell scripts contain no non-ascii bytes', () => {
  const offenders: string[] = [];
  for (const file of files(PACKAGES, ['.ps1'])) {
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i]! > 0x7f) {
        const line = buf.subarray(0, i).toString('latin1').split('\n').length;
        offenders.push(`${relative(ROOT, file)}:${line} → 0x${buf[i]!.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `non-ascii bytes in a .ps1:\n${offenders.join('\n')}`);
});
