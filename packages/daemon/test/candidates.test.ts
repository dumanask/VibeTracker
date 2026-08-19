/**
 * The project chooser's data source.
 *
 * A chooser that can only offer what is running right now cannot be used to
 * add the project you just closed, which is the commonest reason to open one.
 * These tests pin the two halves of the fix: the store remembers projects it
 * has only ever seen dead, and it never lets that memory make a stale project
 * look freshly used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import type { StatusReport } from '@vibetracker/shared';

/** The smallest report the store will accept, naming one live project. */
function report(projectId: string, displayName: string, at: number): StatusReport {
  return {
    generatedAt: at,
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
        identityKind: 'git_root',
        displayName,
        workspaces: [],
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
  const dir = mkdtempSync(join(tmpdir(), 'vt-cand-'));
  const s = new Store({ path: join(dir, 'db.sqlite') });
  return {
    s,
    done: () => {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a project seen only through a dead session is still offerable', () => {
  const { s, done } = store();
  try {
    s.rememberProjects([
      { projectId: 'git:aaa', identityKind: 'git_root', displayName: 'Kapalı' },
    ]);
    const c = s.candidates();
    assert.equal(c.length, 1);
    assert.equal(c[0]!.displayName, 'Kapalı');
  } finally {
    done();
  }
});

/**
 * The seed pass runs at every daemon start, over every registry entry
 * including ones from months ago. If it stamped `last_seen_at`, restarting the
 * daemon would shuffle a long-dead project to the top of the chooser and hold
 * it there — the list would sort by "when did the daemon last boot".
 */
test('seeding never makes a stale project look recently used', () => {
  const { s, done } = store();
  try {
    s.rememberProjects([
      { projectId: 'git:aaa', identityKind: 'git_root', displayName: 'A' },
    ]);
    assert.equal(s.candidates()[0]!.lastSeenAt, 0);
    s.rememberProjects([
      { projectId: 'git:aaa', identityKind: 'git_root', displayName: 'A (yeni ad)' },
    ]);
    const c = s.candidates();
    assert.equal(c[0]!.lastSeenAt, 0, 'seed stamped a fresh timestamp');
    // A rename does land, because that is what the chooser shows.
    assert.equal(c[0]!.displayName, 'A (yeni ad)');
  } finally {
    done();
  }
});

test('a project the daemon has actually watched sorts above a seeded one', () => {
  const { s, done } = store();
  try {
    s.rememberProjects([
      { projectId: 'git:old', identityKind: 'git_root', displayName: 'Eski' },
      { projectId: 'git:new', identityKind: 'git_root', displayName: 'Yeni' },
    ]);
    // The normal path stamps `last_seen_at`; the seed leaves it at zero.
    s.apply(report('git:new', 'Yeni', 5_000));
    const names = s.candidates().map((c) => c.displayName);
    assert.deepEqual(names, ['Yeni', 'Eski']);
  } finally {
    done();
  }
});

test('the list is bounded, so a machine with hundreds of projects still answers', () => {
  const { s, done } = store();
  try {
    s.rememberProjects(
      Array.from({ length: 200 }, (_, i) => ({
        projectId: `git:${i}`,
        identityKind: 'git_root' as const,
        displayName: `P${i}`,
      })),
    );
    assert.equal(s.candidates(60).length, 60);
  } finally {
    done();
  }
});

/**
 * The file has to be able to shrink.
 *
 * `auto_vacuum` can only be set while the database has no pages, and switching
 * the journal to WAL writes the header — so the pragma block set it *after*
 * WAL and it was silently ignored, on every database ever created. With it at
 * NONE the `PRAGMA incremental_vacuum` in `maintain()` is a no-op: the
 * retention passes were deleting rows into free pages the file never handed
 * back, and a daemon meant to run for months only ever grew.
 */
test('the database is opened in a mode that can return free pages', () => {
  const { s, done } = store();
  try {
    // Read from a second connection rather than adding an accessor the product
    // does not need: WAL allows concurrent readers, and this is the same
    // question SQLite would be asked from a shell.
    const db = new DatabaseSync(s.path, { readOnly: true });
    try {
      const av = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number };
      const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      assert.equal(Number(av.auto_vacuum), 2, 'auto_vacuum is not INCREMENTAL -- the file will never shrink');
      assert.equal(String(jm.journal_mode).toLowerCase(), 'wal');
    } finally {
      db.close();
    }
  } finally {
    done();
  }
});
