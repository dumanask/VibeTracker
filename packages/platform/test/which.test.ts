/**
 * "Is this program on the machine?" — asked before offering it as an answer.
 *
 * `vt init` offers the agent CLI the user already has, and `vt doctor` checks
 * that a configured one is still there. Both are only worth anything if this
 * resolves what a shell would resolve: a bare name through PATH, a path taken
 * literally, and on Windows the extensions that make a `.cmd` shim runnable
 * without being named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hasCommand, whichCommand } from '../src/which.ts';

test('the running node is found by name, and nonsense is not', () => {
  // Whatever is running this test is on PATH by definition on a developer
  // machine, but the guaranteed-true statement is the negative one.
  assert.equal(whichCommand('vt-no-such-command'), null);
  assert.equal(hasCommand('vt-no-such-command'), false);
  assert.equal(whichCommand(''), null);
  assert.equal(whichCommand('   '), null);
});

test('a name is looked up in PATH; a path is taken at its word', () => {
  // Canonicalised, because `whichCommand` canonicalises what it returns and a
  // temp directory is the one place that reliably is not canonical: Windows
  // hands back an 8.3 short name (`C:/Users/RUNNER~1/...`) and macOS hands
  // back `/var/folders/...`, a symlink to `/private/var/folders/...`. Both
  // failed in CI while the code under test was doing exactly its job.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vt-which-')));
  const saved = process.env['PATH'];
  try {
    const exe = process.platform === 'win32' ? 'vt-fake.cmd' : 'vt-fake';
    const full = join(dir, exe);
    writeFileSync(full, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\n');
    if (process.platform !== 'win32') chmodSync(full, 0o755);

    process.env['PATH'] = `${saved ?? ''}${delimiter}${dir}`;

    // On Windows the extension is supplied from PATHEXT, which is the whole
    // reason a bare `claude` works at a prompt but not from `spawn`.
    assert.equal(whichCommand('vt-fake'), full);

    // A path is not searched for anywhere. It is what it says or it is nothing.
    assert.equal(whichCommand(full), full);
    assert.equal(whichCommand(join(dir, 'vt-no-such-file')), null);

    // And a directory is not a program, however runnable its name looks.
    assert.equal(whichCommand(dir), null);

    if (process.platform === 'win32') {
      // npm installs both: an extensionless shell script for Git Bash and a
      // `.cmd` next to it. `cmd.exe` runs the second and cannot run the first,
      // so a bare name must resolve to the `.cmd` — reporting the other would
      // name a file the thing about to spawn it cannot execute.
      const pair = join(dir, 'vt-pair');
      writeFileSync(pair, '#!/bin/sh\n');
      writeFileSync(`${pair}.cmd`, '@echo off\n');
      assert.equal(whichCommand('vt-pair'), `${pair}.cmd`);
      // Named in full, though, it is taken at its word.
      assert.equal(whichCommand(pair), pair);
    }
  } finally {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
