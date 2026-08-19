import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, missingKeys, resolveLang, setLang, t, tr, SOURCE_LANG } from '../src/i18n.ts';
import { fmtAge } from '../src/format.ts';

test('the key is the source text with interpolations numbered', () => {
  assert.equal(keyOf(['{0} records']), '{0} records');
  assert.equal(keyOf(['', ' records found']), '{0} records found');
  assert.equal(keyOf(['', ' / ', ' items']), '{0} / {1} items');
});

test('in the source language nothing is looked up', () => {
  setLang(SOURCE_LANG, { 'x{0}y': 'SHOULD NOT BE USED' });
  const n = 3;
  assert.equal(t`x${n}y`, 'x3y');
});

test('a translation is filled with the same values', () => {
  setLang('tr', { '{0} records found': '{0} kayıt bulundu' });
  const n = 55;
  assert.equal(t`${n} records found`, '55 kayıt bulundu');
});

test('a missing translation falls back to a real sentence, never to a key id', () => {
  // This is the whole reason the source text is the key. With opaque ids an
  // untranslated line renders as `status.count.records` and becomes noise.
  setLang('tr', {});
  const n = 7;
  assert.equal(t`${n} sessions waiting on you`, '7 sessions waiting on you');
  assert.deepEqual(missingKeys(), ['{0} sessions waiting on you']);
});

test('missing keys are reported once, in encounter order', () => {
  setLang('tr', {});
  tr('one');
  tr('two');
  tr('one');
  assert.deepEqual(missingKeys(), ['one', 'two']);
});

test('a placeholder with no value is left visible rather than printed as undefined', () => {
  setLang('tr', { 'a{0}b': 'a{0}b{1}' });
  assert.equal(t`a${1}b`, 'a1b{1}');
});

test('language resolution prefers the explicit flag, then env, then config', () => {
  const saved = process.env.VT_LANG;
  try {
    process.env.VT_LANG = 'tr';
    assert.equal(resolveLang('en', 'tr'), 'en');
    assert.equal(resolveLang(undefined, 'en'), 'tr');
    delete process.env.VT_LANG;
    assert.equal(resolveLang(undefined, 'tr'), 'tr');
    // An unknown language is not an error — it simply is not a candidate.
    assert.equal(resolveLang('de', 'en'), 'en');
  } finally {
    if (saved === undefined) delete process.env.VT_LANG;
    else process.env.VT_LANG = saved;
  }
});

test('locale tags are accepted, not just bare codes', () => {
  assert.equal(resolveLang('en-GB'), 'en');
  assert.equal(resolveLang('tr-TR'), 'tr');
});

test('age units follow the language, and never collide', () => {
  // `9sa 36dk` once rendered as `9s 36dk`, which reads as nine *seconds* —
  // the exact opposite of nine hours. Both languages need distinct letters.
  setLang(SOURCE_LANG, {});
  assert.equal(fmtAge(9 * 3600_000 + 36 * 60_000), '9h 36m');
  setLang('tr', {});
  assert.equal(fmtAge(9 * 3600_000 + 36 * 60_000), '9sa 36dk');
  setLang(SOURCE_LANG, {});
});
