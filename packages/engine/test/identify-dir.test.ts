/**
 * Naming a directory by hand — the "klasör seç" button, and `vt projects add`.
 *
 * The bug this file is here for: identity walks *up* to the repository root
 * and the recorded directory did not walk with it. Picking `MyRepo/src` in the
 * folder dialog produced a project under the repository's own id — correct —
 * whose directory was the subdirectory. Everything that reads a project's
 * files then read the wrong tree: plan documents live at the root, so the
 * phase engine was pointed somewhere that has none and the project showed no
 * phase, for ever, with nothing on screen suggesting why.
 *
 * A real repository rather than a mock, because the thing under test is what
 * `git rev-parse --show-toplevel` says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyDirectory } from '../src/discover.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vt-ident-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# x\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'ilk']);
  return dir;
}

test('picking a subdirectory of a repository records the repository', async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, 'packages', 'engine'), { recursive: true });
    const root = await identifyDirectory(dir);
    const sub = await identifyDirectory(join(dir, 'packages', 'engine'));
    assert.ok(root && sub);

    // Same project, because identity is the root commit and that does not
    // change with which directory you happened to open the dialog in.
    assert.equal(sub.projectId, root.projectId);
    assert.match(sub.projectId, /^git:/);

    // And the *same directory*, which is the half that used to be wrong.
    assert.equal(sub.path, root.path);
    assert.equal(sub.displayName, root.displayName);
    assert.ok(!sub.path.includes('/packages/'), `alt dizin kaydedildi: ${sub.path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without git the directory named is the directory recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-ident-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bir-paket' }));
    const found = await identifyDirectory(dir);
    assert.ok(found);
    // No repository to walk up to, so there is nothing to prefer over what the
    // user pointed at.
    assert.match(found.projectId, /^pkg:/);
    assert.ok(found.path.endsWith(dir.replace(/\\/g, '/').split('/').pop()!.toLowerCase()) ||
      found.path.toLowerCase().endsWith(dir.replace(/\\/g, '/').split('/').pop()!.toLowerCase()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anything that is not a directory is simply not a project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-ident-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    // A file, and a path that is not there at all. Both read as "no such
    // project" rather than as an error with a stack in it: this is reached
    // from a folder dialog, where a typo is an ordinary event.
    assert.equal(await identifyDirectory(file), null);
    assert.equal(await identifyDirectory(join(dir, 'yok', 'burada')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
