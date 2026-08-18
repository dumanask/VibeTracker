import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWithPositions,
  applySplices,
  appendInto,
  removeElement,
  removeMember,
  detectIndent,
  child,
  render,
  JsonParseError,
} from '../src/jsonedit.ts';

/**
 * These tests exist because the file being edited is not ours. Every case here
 * is a way a real `settings.json` could be written, and the requirement is the
 * same for all of them: the bytes we did not mean to change come back
 * byte-identical.
 */

test('comments and blank lines survive an edit', () => {
  const src = `{
  // kişisel ayarlar — buna dokunulmamalı
  "theme": "dark",

  /* blok yorum */
  "effortLevel": "max"
}`;
  const root = parseWithPositions(src);
  const out = applySplices(src, [appendInto(src, root, '"hooks": {}')]);

  assert.ok(out.includes('// kişisel ayarlar — buna dokunulmamalı'));
  assert.ok(out.includes('/* blok yorum */'));
  assert.ok(out.includes('\n\n'), 'boş satır korunmalı');
  assert.match(out, /"effortLevel": "max",\n\s+"hooks": \{\}/);
});

test('the file\'s own indentation is adopted, not ours', () => {
  const four = `{\n    "a": 1\n}`;
  const tab = `{\n\t"a": 1\n}`;
  assert.equal(detectIndent(four), '    ');
  assert.equal(detectIndent(tab), '\t');

  const out = applySplices(four, [appendInto(four, parseWithPositions(four), '"b": 2')]);
  assert.equal(out, `{\n    "a": 1,\n    "b": 2\n}`);
});

test('an empty object gains a body without losing its brackets', () => {
  const src = '{}';
  const out = applySplices(src, [appendInto(src, parseWithPositions(src), '"hooks": {}')]);
  assert.equal(out, '{\n  "hooks": {}\n}');
});

test('unicode and escapes round-trip through key lookup', () => {
  const src = `{
  "yol": "C:\\\\Users\\\\İbrahim\\\\.claude",
  "tırnak": "o \\"dedi\\" ki"
}`;
  const root = parseWithPositions(src);
  assert.equal(child(root, 'yol')?.value, 'C:\\Users\\İbrahim\\.claude');
  assert.equal(child(root, 'tırnak')?.value, 'o "dedi" ki');

  // And an edit leaves those bytes exactly as written.
  const out = applySplices(src, [appendInto(src, root, '"x": 1')]);
  assert.ok(out.includes('C:\\\\Users\\\\İbrahim\\\\.claude'));
});

test('a trailing comma is tolerated rather than fatal', () => {
  const src = `{\n  "a": 1,\n}`;
  const root = parseWithPositions(src);
  assert.equal(root.members?.length, 1);
});

test('malformed JSON reports an offset instead of guessing', () => {
  try {
    parseWithPositions('{ "a": }');
    assert.fail('hata bekleniyordu');
  } catch (e) {
    assert.ok(e instanceof JsonParseError);
    assert.ok((e as JsonParseError).offset > 0);
  }
});

test('removing the middle of an array leaves the neighbours intact', () => {
  const src = `{\n  "l": [\n    1,\n    2,\n    3\n  ]\n}`;
  const arr = child(parseWithPositions(src), 'l')!;
  const out = applySplices(src, [removeElement(src, arr, 1)!]);
  assert.deepEqual(JSON.parse(out).l, [1, 3]);
});

test('removing the last element does not leave a dangling comma', () => {
  const src = `{\n  "l": [\n    1,\n    2\n  ]\n}`;
  const arr = child(parseWithPositions(src), 'l')!;
  const out = applySplices(src, [removeElement(src, arr, 1)!]);
  assert.deepEqual(JSON.parse(out).l, [1]);
  assert.ok(!/,\s*\]/.test(out), `sarkan virgül: ${JSON.stringify(out)}`);
});

test('removing the only element empties the array without breaking it', () => {
  const src = `{\n  "l": [\n    1\n  ]\n}`;
  const arr = child(parseWithPositions(src), 'l')!;
  const out = applySplices(src, [removeElement(src, arr, 0)!]);
  assert.deepEqual(JSON.parse(out).l, []);
});

test('removing a member keeps the surrounding object valid', () => {
  for (const [name, src] of [
    ['ilk', `{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}`],
    ['son', `{\n  "a": 1,\n  "b": 2\n}`],
    ['tek', `{\n  "a": 1\n}`],
  ] as const) {
    const root = parseWithPositions(src);
    const key = name === 'son' ? 'b' : 'a';
    const out = applySplices(src, [removeMember(src, root, key)!]);
    const parsed = JSON.parse(out) as Record<string, number>;
    assert.equal(parsed[key], undefined, `${name}: ${key} kalmamalı`);
    assert.doesNotThrow(() => parseWithPositions(out), `${name} sonrası geçerli kalmalı`);
  }
});

test('rendering matches the surrounding style', () => {
  assert.equal(render({ a: 1 }, '  ', 0), '{\n  "a": 1\n}');
  assert.equal(render([], '  ', 0), '[]');
  assert.equal(render({}, '  ', 0), '{}');
  assert.equal(render({ a: [1] }, '\t', 0), '{\n\t"a": [\n\t\t1\n\t]\n}');
});

test('nested containers keep their own indentation level', () => {
  const src = `{\n  "hooks": {\n    "Stop": []\n  }\n}`;
  const root = parseWithPositions(src);
  const hooks = child(root, 'hooks')!;
  const out = applySplices(src, [appendInto(src, hooks, '"Notification": []')]);
  assert.doesNotThrow(() => parseWithPositions(out));
  assert.match(out, /\n {4}"Notification": \[\]/, `girinti bozuldu:\n${out}`);
});
