/**
 * Directories the user named by hand.
 *
 * Every other project on the board exists because a session ran in it. These
 * exist because someone typed a path, which makes them the only answer for a
 * repository you want tracked before you have pointed an agent at it — and the
 * only entry in the config that the scan cannot rediscover if it is dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredRoots, loadConfigText } from '../src/config.ts';
import { setTomlValues } from '../src/tomledit.ts';

function parse(text: string) {
  return loadConfigText(text);
}

test('a path under a project id becomes a root the scan can visit', () => {
  const { config, issues } = parse(`
[projects."git:abc"]
path = "c:/dev/Foo"
`);
  assert.deepEqual(
    issues.filter((i) => i.severity === 'error'),
    [],
  );
  assert.deepEqual(configuredRoots(config), [{ projectId: 'git:abc', path: 'c:/dev/Foo' }]);
});

test('a project with no path contributes no root', () => {
  const { config } = parse(`
[projects."git:abc"]
display_name = "Foo"
`);
  assert.deepEqual(configuredRoots(config), []);
});

/**
 * Archiving is the user saying they are done with a project. Paying a git
 * probe every scan to keep it on the board would be the opposite of that.
 */
test('an archived project is not visited', () => {
  const { config } = parse(`
[projects."git:abc"]
path = "c:/dev/Foo"
archived = true
`);
  assert.deepEqual(configuredRoots(config), []);
});

test('path is a known key, so a config that uses it raises no unknown-key warning', () => {
  const { issues } = parse(`
[projects."git:abc"]
path = "c:/dev/Foo"
`);
  assert.equal(
    issues.some((i) => /path/.test(i.key ?? '') && /bilinmeyen/i.test(i.message ?? '')),
    false,
  );
});

/**
 * The writer has to reach a quoted, dotted section name. `vt projects add
 * <yol>` writes `[projects."git:abc"]`, and a writer that treated the dot as a
 * nesting separator would create `[projects.git]` and lose the path.
 */
test('the config writer can address a quoted project section', () => {
  const out = setTomlValues('', 'projects."git:abc"', { path: 'c:/dev/Foo' });
  const { config } = parse(out);
  assert.deepEqual(configuredRoots(config), [{ projectId: 'git:abc', path: 'c:/dev/Foo' }]);
});

test('adding a second project leaves the first one alone', () => {
  let text = setTomlValues('', 'projects."git:abc"', { path: 'c:/dev/Foo' });
  text = setTomlValues(text, 'projects."git:def"', { path: 'c:/dev/Bar' });
  const { config } = parse(text);
  assert.deepEqual(
    configuredRoots(config).sort((a, b) => a.projectId.localeCompare(b.projectId)),
    [
      { projectId: 'git:abc', path: 'c:/dev/Foo' },
      { projectId: 'git:def', path: 'c:/dev/Bar' },
    ],
  );
});
