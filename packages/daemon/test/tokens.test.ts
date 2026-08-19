/**
 * The bug this file exists for: the dashboard token used to be minted fresh on
 * every daemon start.
 *
 * That is only harmless for a surface opened after the daemon comes up and
 * closed before it goes down — a terminal printing a link. Every other surface
 * holds the token for the life of the surface: the post-it takes it as a
 * command-line argument, the desktop shell bakes it into the panel window's
 * URL, a browser tab has it inlined into the page it was served. The daemon
 * restarts on its own — the watchdog exits rather than hang — so after any long
 * session all three were talking to a daemon that no longer recognised them.
 *
 * The visible symptom was the sticky note's picker saying "no projects found",
 * because a 401 and an empty list arrived at the same place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A data directory of our own, so the suite never touches the real one. */
function isolated(fn: (dir: string) => void | Promise<void>): void | Promise<void> {
  const before = process.env.VT_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vt-tokens-'));
  process.env.VT_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (before === undefined) delete process.env.VT_DATA_DIR;
    else process.env.VT_DATA_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the dashboard token survives a restart', async () => {
  const { loadOrCreateApiToken, readApiToken, apiTokenPath } = await import('../src/tokens.ts');
  isolated(() => {
    const first = loadOrCreateApiToken();
    assert.match(first, /^vt_/);
    // A second daemon start, which is the whole point.
    assert.equal(loadOrCreateApiToken(), first);
    assert.equal(readApiToken(), first);
    assert.ok(existsSync(apiTokenPath()));
    assert.equal(readFileSync(apiTokenPath(), 'utf8').trim(), first);
  });
});

test('the two tokens are not the same token', async () => {
  const { loadOrCreateApiToken, loadOrCreateHookToken } = await import('../src/tokens.ts');
  isolated(() => {
    // Different files, different lifetimes in the user's world: rotating the
    // hook token means editing `settings.json` again, rotating the dashboard
    // one means reopening a window. Sharing one string would tie the two
    // together for no reason and widen what a leak of either costs.
    assert.notEqual(loadOrCreateApiToken(), loadOrCreateHookToken());
  });
});

test('a corrupt token file is replaced, not trusted', async () => {
  const { loadOrCreateApiToken, apiTokenPath } = await import('../src/tokens.ts');
  const { writeFileSync } = await import('node:fs');
  isolated(() => {
    writeFileSync(apiTokenPath(), 'not-a-token\n');
    const fresh = loadOrCreateApiToken();
    assert.match(fresh, /^vt_/);
    // And it is now persistent again, rather than regenerating every call.
    assert.equal(loadOrCreateApiToken(), fresh);
  });
});
