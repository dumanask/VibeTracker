import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, missingKeys, resolveLang, setLang, t, tr, SOURCE_LANG } from '../src/i18n.ts';
import { fmtAge } from '../src/format.ts';

test('the key is the source text with interpolations numbered', () => {
  assert.equal(keyOf(['{0} kayıt']), '{0} kayıt');
  assert.equal(keyOf(['', ' kayıt bulundu']), '{0} kayıt bulundu');
  assert.equal(keyOf(['', ' / ', ' madde']), '{0} / {1} madde');
});

test('in the source language nothing is looked up', () => {
  setLang(SOURCE_LANG, { 'x{0}y': 'SHOULD NOT BE USED' });
  const n = 3;
  assert.equal(t`x${n}y`, 'x3y');
});

test('a translation is filled with the same values', () => {
  setLang('en', { '{0} kayıt bulundu': '{0} records found' });
  const n = 55;
  assert.equal(t`${n} kayıt bulundu`, '55 records found');
});

test('a missing translation falls back to a real sentence, never to a key id', () => {
  // This is the whole reason the source text is the key. With opaque ids an
  // untranslated line renders as `status.count.records` and becomes noise.
  setLang('en', {});
  const n = 7;
  assert.equal(t`${n} oturum seni bekliyor`, '7 oturum seni bekliyor');
  assert.deepEqual(missingKeys(), ['{0} oturum seni bekliyor']);
});

test('missing keys are reported once, in encounter order', () => {
  setLang('en', {});
  tr('bir');
  tr('iki');
  tr('bir');
  assert.deepEqual(missingKeys(), ['bir', 'iki']);
});

test('a placeholder with no value is left visible rather than printed as undefined', () => {
  setLang('en', { 'a{0}b': 'a{0}b{1}' });
  assert.equal(t`a${1}b`, 'a1b{1}');
});

test('language resolution prefers the explicit flag, then env, then config', () => {
  const saved = process.env.VT_LANG;
  try {
    process.env.VT_LANG = 'en';
    assert.equal(resolveLang('tr', 'en'), 'tr');
    assert.equal(resolveLang(undefined, 'tr'), 'en');
    delete process.env.VT_LANG;
    assert.equal(resolveLang(undefined, 'en'), 'en');
    // An unknown language is not an error — it simply is not a candidate.
    assert.equal(resolveLang('de', 'tr'), 'tr');
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
  assert.equal(fmtAge(9 * 3600_000 + 36 * 60_000), '9sa 36dk');
  setLang('en', {});
  assert.equal(fmtAge(9 * 3600_000 + 36 * 60_000), '9h 36m');
  setLang(SOURCE_LANG, {});
});
