/**
 * The config is TOML so it can carry comments. An editor that loses them
 * defeats the reason the format was chosen, so that is what these check —
 * not just that the value changed, but that everything around it survived.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTomlValues } from '../src/tomledit.ts';
import { parseToml } from '../src/toml.ts';

test('an existing key is replaced where it stands, comments intact', () => {
  const before = [
    '# hangi projeleri izliyorum',
    '[tracking]',
    '# hepsi mi, seçtiklerim mi',
    'mode = "all"',
    'selected = []',
    '',
    '[server]',
    'port = 47823',
  ].join('\n');

  const after = setTomlValues(before, 'tracking', { mode: 'selected', selected: ['git:abc'] });

  assert.ok(after.includes('# hangi projeleri izliyorum'));
  assert.ok(after.includes('# hepsi mi, seçtiklerim mi'));
  assert.ok(after.includes('mode = "selected"'));
  assert.ok(after.includes('selected = ["git:abc"]'));
  // The neighbouring table must not have moved or changed.
  assert.ok(after.includes('[server]\nport = 47823'));
});

test('a missing section is appended rather than silently dropped', () => {
  const before = '[server]\nport = 47823\n';
  const after = setTomlValues(before, 'tracking', { mode: 'selected', selected: ['git:a'] });
  const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
  assert.equal(parsed.tracking.mode, 'selected');
  assert.deepEqual(parsed.tracking.selected, ['git:a']);
  assert.equal(parsed.server.port, 47823);
});

test('a new key lands inside its own section, not in the next one', () => {
  const before = ['[tracking]', 'mode = "all"', '', '[server]', 'port = 1'].join('\n');
  const after = setTomlValues(before, 'tracking', { selected: ['x'] });
  const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
  assert.deepEqual(parsed.tracking.selected, ['x']);
  assert.equal(parsed.tracking.mode, 'all');
  assert.equal(parsed.server.port, 1);
  // Placed before the blank line that separates the tables.
  assert.ok(after.indexOf('selected') < after.indexOf('[server]'));
});

/**
 * The bug this is here to prevent: replacing only the first line of a
 * multi-line array leaves its remaining elements behind as loose syntax, and
 * the file stops parsing entirely — a config edit that bricks the config.
 */
test('a value written across several lines is replaced whole', () => {
  const before = [
    '[tracking]',
    'selected = [',
    '  "git:one",',
    '  "git:two",',
    ']',
    'mode = "selected"',
  ].join('\n');
  const after = setTomlValues(before, 'tracking', { selected: ['git:three'] });
  const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
  assert.deepEqual(parsed.tracking.selected, ['git:three']);
  assert.equal(parsed.tracking.mode, 'selected');
  assert.ok(!after.includes('git:one'));
});

test('a bracket inside a string does not end the value early', () => {
  const before = ['[tracking]', 'selected = ["path:c/dev/x]y", "git:b"]', 'mode = "all"'].join('\n');
  const after = setTomlValues(before, 'tracking', { mode: 'selected' });
  const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
  assert.deepEqual(parsed.tracking.selected, ['path:c/dev/x]y', 'git:b']);
  assert.equal(parsed.tracking.mode, 'selected');
});

test('windows paths survive the round trip', () => {
  const after = setTomlValues('', 'tracking', { selected: ['path:C:\\dev\\a"b'] });
  const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
  assert.deepEqual(parsed.tracking.selected, ['path:C:\\dev\\a"b']);
});

test('a file using CRLF keeps using CRLF', () => {
  const before = '[tracking]\r\nmode = "all"\r\n';
  const after = setTomlValues(before, 'tracking', { mode: 'selected' });
  assert.ok(after.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(after));
});
