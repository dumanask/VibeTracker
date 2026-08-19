/**
 * What happens to a follow when the project's id changes under it.
 *
 * Project identity comes from a ladder — git root commit, then package name,
 * then path — so a directory that gains a git history stops answering to the
 * id that was true when its box was ticked. Observed on this repository the
 * day it got one: the followed project fell off the board without a word, and
 * the chooser grew a second row with the same name, the two distinguishable
 * only by a hash.
 *
 * The rule pinned here is that the *directory* is the evidence. Two ids at one
 * path, the newer sighting winning — and only when nothing is left of the old
 * one anywhere else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { StatusReport } from '@vibetracker/shared';

/** A report naming one project at the given directories. */
function at(projectId: string, displayName: string, paths: string[], when: number): StatusReport {
  return {
    generatedAt: when,
    platform: 'test',
    probeKind: 'degraded',
    probePrecision: 'none',
    claudeDir: '/x',
    counts: {
      registryEntries: 0, live: 0, dead: 0, reused: 0,
      projects: 1, untracked: 0, needsYou: 0, ideWindows: 0,
    },
    projects: [
      {
        projectId,
        identityKind: projectId.startsWith('git:') ? 'git_root' : 'package',
        displayName,
        workspaces: paths.map((p) => ({
          normPath: p,
          realPath: p,
          rawPathSample: p,
          isWorktree: false,
          storageKind: 'local',
        })),
        sessions: [],
        flags: [],
        tracked: true,
        summary: { kind: 'none', waiting: 0, running: 0, live: 0, total: 0, urgency: 0 },
      },
    ],
    ideWindows: [],
    capabilities: {},
    degraded: [],
    warnings: [],
  } as unknown as StatusReport;
}

function store(): { s: Store; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vt-move-'));
  const s = new Store({ path: join(dir, 'db.sqlite') });
  return {
    s,
    done: () => {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('git init renames a project, and the move is readable from the directory', () => {
  const { s, done } = store();
  try {
    s.apply(at('pkg:abc', 'VibeTracker', ['c:/dev/vt'], 1_000));
    s.apply(at('git:def', 'VibeTracker', ['c:/dev/vt'], 2_000));
    const moves = s.identityMoves();
    assert.equal(moves.get('pkg:abc'), 'git:def');
    assert.equal(moves.size, 1, 'only the superseded id moves');
  } finally {
    done();
  }
});

test('the ghost leaves the chooser, so one project is one row', () => {
  const { s, done } = store();
  try {
    s.apply(at('pkg:abc', 'VibeTracker', ['c:/dev/vt'], 1_000));
    s.apply(at('git:def', 'VibeTracker', ['c:/dev/vt'], 2_000));
    const names = s.candidates().map((c) => c.projectId);
    assert.deepEqual(names, ['git:def']);
  } finally {
    done();
  }
});

/**
 * The dangerous false positive. A project living in two directories, one of
 * which is taken over by something else, is not a renamed project — retiring
 * it would unfollow a project that is still there.
 */
test('a project still alive elsewhere is not treated as renamed', () => {
  const { s, done } = store();
  try {
    s.apply(at('pkg:abc', 'Two homes', ['c:/dev/vt', 'd:/kopya/vt'], 1_000));
    s.apply(at('git:def', 'Someone else', ['c:/dev/vt'], 2_000));
    assert.equal(s.identityMoves().size, 0);
    assert.equal(s.candidates().length, 2);
  } finally {
    done();
  }
});

test('a chain of renames resolves to the id in use now', () => {
  const { s, done } = store();
  try {
    s.apply(at('path:one', 'P', ['c:/dev/p'], 1_000));
    s.apply(at('pkg:two', 'P', ['c:/dev/p'], 2_000));
    s.apply(at('git:three', 'P', ['c:/dev/p'], 3_000));
    const moves = s.identityMoves();
    assert.equal(moves.get('path:one'), 'git:three', 'the chain was not followed');
    assert.equal(moves.get('pkg:two'), 'git:three');
  } finally {
    done();
  }
});

/**
 * Two directories swapping owners would otherwise walk the chain forever. The
 * situation is absurd; a daemon that hangs on it is not.
 */
test('ids that swap directories do not send the resolver in a circle', () => {
  const { s, done } = store();
  try {
    s.apply(at('git:a', 'A', ['c:/one'], 1_000));
    s.apply(at('git:b', 'B', ['c:/two'], 1_000));
    s.apply(at('git:b', 'B', ['c:/one'], 2_000));
    s.apply(at('git:a', 'A', ['c:/two'], 2_000));
    const moves = s.identityMoves();
    // Neither is a ghost: both still hold a directory. What matters is that
    // asking took a finite amount of time.
    assert.equal(moves.size, 0);
  } finally {
    done();
  }
});

test('an untouched database reports no moves and pays for no work', () => {
  const { s, done } = store();
  try {
    s.apply(at('git:a', 'A', ['c:/one'], 1_000));
    assert.equal(s.identityMoves().size, 0);
  } finally {
    done();
  }
});
