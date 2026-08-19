// Installs the warning filter. Must be evaluated before node:sqlite is loaded,
// which is why the sqlite import below is dynamic rather than static: a static
// import is resolved during the linking phase, before any module body runs, so
// no amount of import ordering can get in front of it.
import './quiet.ts';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '@vibetracker/platform';
import {
  DB_HARD_CAP_BYTES,
  RETAIN_AGGRESSIVE_MS,
  RETAIN_SESSIONS_MS,
  RETAIN_TRANSITIONS_MS,
} from '@vibetracker/core';
import {
  CANDIDATE_LIMIT,
  type DigestView,
  type ProjectView,
  type SessionView,
  type StatusReport,
} from '@vibetracker/shared';
import { t } from '@vibetracker/core';

/**
 * Persistence.
 *
 * Uses `node:sqlite`, which ships inside Node 22 and needs no native module.
 * That is a deliberate distribution decision, not a convenience: a tool other
 * people install must not require a compiler, and a zero-native-dependency
 * build is what makes single-file packaging and musl/Alpine support possible.
 * `better-sqlite3` remains a drop-in behind this interface if a large install
 * ever needs the extra speed.
 *
 * Two rules the schema encodes:
 *
 * 1. Transcript text is never stored. Sessions keep a path and a size; the text
 *    stays in the agent's own files. The reference machine held 1.73 GB of
 *    transcripts, and duplicating any of it would be both wasteful and a
 *    second copy of the user's secrets to protect.
 * 2. History that we want a trend of is append-only; everything rendered on a
 *    screen is one current row.
 */

// Top-level await: this module's body runs after `./quiet.ts` has installed the
// filter, so loading the builtin here is late enough for it to be suppressed.
const { DatabaseSync } = await import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const SCHEMA_VERSION = 3;

export interface StoreOptions {
  /** Overridden in tests; defaults to the per-OS data directory. */
  path?: string;
}

export interface PriorProgress {
  at: number;
  doneWeight: number | null;
  totalWeight: number | null;
  ordinal: number | null;
}

export interface ProgressRow {
  percent: number | null;
  doneWeight: number | null;
  totalWeight: number | null;
  ordinal: number | null;
  basis: string;
  phaseLabel: string | null;
}

export interface ProgressPoint extends ProgressRow {
  at: number;
}

export class Store {
  readonly path: string;
  #db: DatabaseSync;

  constructor(opts: StoreOptions = {}) {
    this.path = opts.path ?? join(dataDir(), 'vibetracker.db');
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#pragmas();
    this.#migrate();
  }

  #pragmas(): void {
    // `auto_vacuum` first, and the order is the whole point.
    //
    // It can only be set on a database with no pages yet, and switching the
    // journal to WAL writes the header — so setting it *after* WAL silently
    // does nothing, even on a file created a microsecond earlier. Measured:
    // WAL first gives `auto_vacuum = 0`, auto_vacuum first gives 2. With it at
    // 0 the `PRAGMA incremental_vacuum` in `maintain()` is a no-op, which means
    // the retention passes were deleting rows into free pages the file never
    // gave back and the database only ever grew.
    //
    // WAL + NORMAL: durable across process crashes, without an fsync per write.
    this.#db.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  /**
   * Turn on incremental vacuum for a database that predates the fix.
   *
   * Changing `auto_vacuum` on a populated file needs a full `VACUUM` — the
   * pragma alone is ignored. That is expensive, so it runs once, from
   * maintenance rather than from `open`, and only when the file actually says
   * NONE. A database that was already correct pays a single pragma read.
   */
  #adoptAutoVacuum(): boolean {
    const row = this.#db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined;
    if (Number(row?.auto_vacuum ?? 0) !== 0) return false;
    this.#db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.#db.exec('VACUUM');
    return true;
  }

  #migrate(): void {
    const row = this.#db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);

    if (current > SCHEMA_VERSION) {
      // Forward-only. An older binary must refuse rather than corrupt a newer
      // database written by a version it does not understand.
      throw new Error(
        t`The database schema is newer than this build (${current} > ${SCHEMA_VERSION}). ` +
          t`Update VibeTracker, or move ${this.path} aside.`,
      );
    }
    // Every statement below is `IF NOT EXISTS`, so running it against an older
    // database adds what is missing and leaves the rest alone. That is what
    // makes a version bump safe without a migration script per step.
    if (current === SCHEMA_VERSION) return;

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id    TEXT PRIMARY KEY,
        identity_kind TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        archived      INTEGER NOT NULL DEFAULT 0,
        pinned        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        norm_path    TEXT NOT NULL,
        label        TEXT,
        branch       TEXT,
        head_sha     TEXT,
        head_subject TEXT,
        commit_count INTEGER,
        dirty_count  INTEGER,
        is_worktree  INTEGER NOT NULL DEFAULT 0,
        storage_kind TEXT,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, norm_path)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id       TEXT PRIMARY KEY,
        project_id       TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
        agent_kind       TEXT NOT NULL DEFAULT 'claude-code',
        name             TEXT,
        pid              INTEGER,
        cwd              TEXT,
        entrypoint       TEXT,
        cli_version      TEXT,
        title            TEXT,
        started_at       INTEGER,
        first_seen_at    INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        last_activity_at INTEGER,
        transcript_path  TEXT,
        transcript_size  INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_id, last_activity_at DESC);

      -- One current row per session: the hot read path for the dashboard.
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        state      TEXT NOT NULL,
        sub_reason TEXT,
        confidence REAL NOT NULL,
        liveness   TEXT NOT NULL,
        since_ts   INTEGER NOT NULL,
        evidence   TEXT NOT NULL,
        needs_you  INTEGER NOT NULL,
        urgency    INTEGER NOT NULL,
        open_tool  TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_state_needs
        ON session_state(needs_you DESC, urgency DESC, since_ts ASC);

      -- Append-only, written ONLY when the state actually changes. This is what
      -- makes "blocked for 41 minutes" answerable at all.
      CREATE TABLE IF NOT EXISTS state_transitions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        from_state TEXT,
        to_state   TEXT NOT NULL,
        sub_reason TEXT,
        confidence REAL,
        at_ts      INTEGER NOT NULL,
        dwell_ms   INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_trans ON state_transitions(session_id, at_ts DESC);

      /*
       * Append-only history of what the plan documents said.
       *
       * This exists for one detector: D5 asks whether the counted ratio has
       * moved, and no single scan can answer that. Append-only because a
       * reading is an observation with a timestamp — rewriting it would erase
       * the very thing the question is about.
       */
      CREATE TABLE IF NOT EXISTS progress_reading (
        id            INTEGER PRIMARY KEY,
        project_id    TEXT NOT NULL,
        computed_at   INTEGER NOT NULL,
        percent       INTEGER,
        done_weight   INTEGER,
        total_weight  INTEGER,
        ordinal       INTEGER,
        basis         TEXT NOT NULL,
        phase_label   TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_progress ON progress_reading(project_id, computed_at DESC);

      /**
       * The last LLM summary for a project, if the user ever asked for one.
       *
       * One row, replaced. Not a history: a digest is a reading of the state
       * as it is now, and keeping every one of them would mean a retention
       * policy, a budget table and a growth problem for a feature that is off
       * by default.
       *
       * Written by "vt digest", never by the daemon. The daemon does not go to
       * a network and is not going to start; it reads this table the same way
       * it reads anything else on disk, and renders what it finds. Which means
       * the board can say "a model said this, at this time, and here is which
       * model" -- and can say nothing at all when nobody asked one.
       */
      CREATE TABLE IF NOT EXISTS project_digest (
        project_id  TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        json        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_hourly (
        project_id  TEXT NOT NULL,
        hour_ts     INTEGER NOT NULL,
        samples     INTEGER NOT NULL DEFAULT 0,
        busy_ms     INTEGER NOT NULL DEFAULT 0,
        waiting_ms  INTEGER NOT NULL DEFAULT 0,
        blocked_ms  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, hour_ts)
      );
    `);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * The oldest reading still inside the D5 window, and the newest one.
   *
   * D5 compares against the *oldest* reading in the window rather than the
   * previous scan: comparing to three seconds ago would never show movement,
   * and comparing to the first reading ever would fire forever on a project
   * that legitimately paused once.
   */
  priorProgress(projectId: string, windowMs: number, now: number): PriorProgress | null {
    const row = this.#db
      .prepare(
        `SELECT computed_at, done_weight, total_weight, ordinal
           FROM progress_reading
          WHERE project_id = ? AND computed_at >= ?
          ORDER BY computed_at ASC LIMIT 1`,
      )
      .get(projectId, now - windowMs * 2) as
      | { computed_at: number; done_weight: number | null; total_weight: number | null; ordinal: number | null }
      | undefined;
    if (!row) return null;
    return {
      at: row.computed_at,
      doneWeight: row.done_weight,
      totalWeight: row.total_weight,
      ordinal: row.ordinal,
    };
  }

  /** Sessions in this project that were active since `since`. Feeds D5. */
  activitySince(projectId: string, since: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND last_activity_at >= ?')
      .get(projectId, since) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Append a reading, but only when it says something new.
   *
   * A daemon scanning every three seconds would otherwise write a million
   * identical rows a month to answer a question about weeks. One row per
   * actual change keeps the history honest and the file small.
   */
  recordProgress(projectId: string, r: ProgressRow, now: number): boolean {
    const last = this.#db
      .prepare(
        `SELECT percent, done_weight, total_weight, ordinal
           FROM progress_reading WHERE project_id = ?
          ORDER BY computed_at DESC LIMIT 1`,
      )
      .get(projectId) as
      | { percent: number | null; done_weight: number | null; total_weight: number | null; ordinal: number | null }
      | undefined;
    if (
      last &&
      last.percent === r.percent &&
      last.done_weight === r.doneWeight &&
      last.total_weight === r.totalWeight &&
      last.ordinal === r.ordinal
    ) {
      return false;
    }
    this.#db
      .prepare(
        `INSERT INTO progress_reading
           (project_id, computed_at, percent, done_weight, total_weight, ordinal, basis, phase_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, now, r.percent, r.doneWeight, r.totalWeight, r.ordinal, r.basis, r.phaseLabel);
    return true;
  }

  /** The recorded curve for one project, oldest first. */
  progressHistory(projectId: string, limit = 500): ProgressPoint[] {
    return this.#db
      .prepare(
        `SELECT computed_at AS at, percent, done_weight AS doneWeight,
                total_weight AS totalWeight, ordinal, basis, phase_label AS phaseLabel
           FROM progress_reading WHERE project_id = ?
          ORDER BY computed_at ASC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as ProgressPoint[];
  }

  /**
   * Fold one scan into the database, returning the state changes it produced.
   * Only real transitions are recorded, so a session polled a thousand times
   * while sitting in one state writes one row, not a thousand.
   */
  apply(report: StatusReport): StateChange[] {
    const now = report.generatedAt;
    const changes: StateChange[] = [];

    const upsertProject = this.#db.prepare(`
      INSERT INTO projects (project_id, identity_kind, display_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        display_name = excluded.display_name,
        identity_kind = excluded.identity_kind,
        last_seen_at = excluded.last_seen_at
    `);
    const upsertWorkspace = this.#db.prepare(`
      INSERT INTO workspaces (project_id, norm_path, label, branch, head_sha, head_subject,
                              commit_count, dirty_count, is_worktree, storage_kind, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, norm_path) DO UPDATE SET
        label = excluded.label, branch = excluded.branch, head_sha = excluded.head_sha,
        head_subject = excluded.head_subject, commit_count = excluded.commit_count,
        dirty_count = excluded.dirty_count, is_worktree = excluded.is_worktree,
        storage_kind = excluded.storage_kind, last_seen_at = excluded.last_seen_at
    `);
    const upsertSession = this.#db.prepare(`
      INSERT INTO sessions (session_id, project_id, name, pid, cwd, entrypoint, cli_version,
                            title, started_at, first_seen_at, last_seen_at, last_activity_at,
                            transcript_path, transcript_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id, name = excluded.name, pid = excluded.pid,
        cwd = excluded.cwd, entrypoint = excluded.entrypoint, cli_version = excluded.cli_version,
        title = COALESCE(excluded.title, sessions.title),
        last_seen_at = excluded.last_seen_at, last_activity_at = excluded.last_activity_at,
        transcript_path = excluded.transcript_path, transcript_size = excluded.transcript_size
    `);
    const readState = this.#db.prepare(
      'SELECT state, sub_reason, since_ts FROM session_state WHERE session_id = ?',
    );
    const writeState = this.#db.prepare(`
      INSERT INTO session_state (session_id, state, sub_reason, confidence, liveness, since_ts,
                                 evidence, needs_you, urgency, open_tool, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = excluded.state, sub_reason = excluded.sub_reason,
        confidence = excluded.confidence, liveness = excluded.liveness,
        since_ts = excluded.since_ts, evidence = excluded.evidence,
        needs_you = excluded.needs_you, urgency = excluded.urgency,
        open_tool = excluded.open_tool, updated_at = excluded.updated_at
    `);
    const writeTransition = this.#db.prepare(`
      INSERT INTO state_transitions (session_id, from_state, to_state, sub_reason, confidence, at_ts, dwell_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.#db.exec('BEGIN');
    try {
      for (const p of report.projects) {
        upsertProject.run(p.projectId, p.identityKind, p.displayName, now, now);
        for (const w of p.workspaces) {
          upsertWorkspace.run(
            p.projectId,
            w.normPath,
            w.label ?? null,
            w.branch ?? null,
            w.headSha ?? null,
            w.headSubject ?? null,
            w.commitCount ?? null,
            w.dirtyCount ?? null,
            w.isWorktree ? 1 : 0,
            w.storageKind,
            now,
          );
        }
        for (const s of p.sessions) {
          upsertSession.run(
            s.sessionId,
            p.projectId,
            s.name ?? null,
            s.pid,
            s.cwd,
            s.entrypoint ?? null,
            s.cliVersion ?? null,
            s.title ?? null,
            s.startedAt ?? null,
            now,
            now,
            s.lastActivityAt ?? null,
            s.transcriptPath ?? null,
            s.transcriptSize ?? null,
          );

          const prev = readState.get(s.sessionId) as
            | { state: string; sub_reason: string | null; since_ts: number }
            | undefined;
          const subReason = s.openTools[0] ? `tool:${s.openTools[0]}` : null;

          // Dwell is anchored to the STATE, not the sub-reason. An agent that
          // has been BUSY for ten minutes is still ten minutes in, even though
          // it has run six different tools in that time — resetting on every
          // tool swap made long-running work look like it had just started.
          const changed = !prev || prev.state !== s.state;

          // First sighting: the session almost certainly entered this state
          // before the daemon existed, and its last transcript write is the
          // best evidence of when. Anchoring to "now" would report a session
          // that had been waiting ten hours as having waited five seconds.
          const seeded = !prev && s.lastActivityAt && s.lastActivityAt < now
            ? s.lastActivityAt
            : now;
          const sinceTs = changed ? seeded : prev!.since_ts;

          if (changed) {
            writeTransition.run(
              s.sessionId,
              prev?.state ?? null,
              s.state,
              subReason,
              s.confidence,
              sinceTs,
              prev ? now - prev.since_ts : null,
            );
            changes.push({
              sessionId: s.sessionId,
              projectId: p.projectId,
              from: prev?.state ?? null,
              to: s.state,
              subReason,
              dwellMs: prev ? now - prev.since_ts : null,
            });
          }

          writeState.run(
            s.sessionId,
            s.state,
            subReason,
            s.confidence,
            s.liveness,
            sinceTs,
            JSON.stringify(s.evidence),
            needsYouFlag(s),
            urgencyFlag(s),
            s.openTools[0] ?? null,
            now,
          );
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return changes;
  }

  /** When each session entered its current state, for dwell timers. */
  sinceMap(): Map<string, number> {
    const rows = this.#db.prepare('SELECT session_id, since_ts FROM session_state').all() as Array<{
      session_id: string;
      since_ts: number;
    }>;
    return new Map(rows.map((r) => [r.session_id, r.since_ts]));
  }

  /**
   * Note that these projects exist, without recording anything about them.
   *
   * Used once at startup to seed the picker from the whole registry, dead
   * entries included. Nothing but identity is written: a project seen only
   * through a session that ended months ago has no state worth keeping, and
   * `last_seen_at` is left alone for rows that already exist so a seed pass
   * cannot make a stale project look freshly used.
   */
  rememberProjects(projects: Array<Pick<ProjectView, 'projectId' | 'identityKind' | 'displayName'>>): void {
    const stmt = this.#db.prepare(`
      INSERT INTO projects (project_id, identity_kind, display_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET display_name = excluded.display_name
    `);
    // Seeded rows are stamped at the epoch of the oldest possible session
    // rather than "now": they sort last in the picker, which is exactly right
    // for a project nobody has opened since the daemon has been watching.
    const seen = 0;
    this.#db.exec('BEGIN');
    try {
      for (const p of projects) {
        stmt.run(p.projectId, p.identityKind, p.displayName, Date.now(), seen);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Every project the daemon has ever seen, newest first.
   *
   * The board shows what is running; this answers a different question —
   * *what could I choose to follow?* — and it has to include projects with
   * nothing running, because a project you closed yesterday is exactly the one
   * you want to add. Reading it from the database rather than from a scan
   * keeps the answer instant and costs no git probe: the rows were written
   * when those projects were live.
   */
  candidates(limit = CANDIDATE_LIMIT): Array<{
    projectId: string;
    displayName: string;
    lastSeenAt: number;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT project_id, display_name, last_seen_at
           FROM projects
          WHERE archived = 0
          ORDER BY last_seen_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{
      project_id: string;
      display_name: string;
      last_seen_at: number;
    }>;
    // A superseded identity is a ghost: same directory, same name, an id that
    // will never be seen again. Listing it puts two identical rows in the
    // chooser distinguishable only by a hash, and ticking the wrong one follows
    // nothing.
    const moved = this.identityMoves();
    return rows
      .filter((r) => !moved.has(r.project_id))
      .map((r) => ({
        projectId: r.project_id,
        displayName: r.display_name,
        lastSeenAt: r.last_seen_at,
      }));
  }

  /**
   * Record the summary a model produced, replacing whatever was there.
   *
   * Called from `vt digest`, which is a different process from the daemon. WAL
   * plus the busy timeout is what makes that safe; nothing here is on a hot
   * path, and one row a few times a day is not a contention problem.
   */
  saveDigest(row: {
    projectId: string;
    createdAt: number;
    provider: string;
    model: string;
    output: unknown;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO project_digest (project_id, created_at, provider, model, json)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
              created_at = excluded.created_at,
              provider   = excluded.provider,
              model      = excluded.model,
              json       = excluded.json`,
      )
      .run(row.projectId, row.createdAt, row.provider, row.model, JSON.stringify(row.output));
  }

  /** Every stored summary, by project id. Absent means nobody ever asked. */
  digests(): Map<string, DigestView> {
    const rows = this.#db
      .prepare('SELECT project_id, created_at, provider, model, json FROM project_digest')
      .all() as Array<{
      project_id: string;
      created_at: number;
      provider: string;
      model: string;
      json: string;
    }>;
    const out = new Map<string, DigestView>();
    for (const r of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(r.json) as Record<string, unknown>;
      } catch {
        // A row we cannot read is dropped rather than shown half-parsed. It
        // was written by a schema that validated it once; if it no longer
        // does, the honest answer is that there is no summary.
        continue;
      }
      out.set(r.project_id, {
        ...(parsed as unknown as Omit<DigestView, 'provider' | 'model' | 'atMs'>),
        provider: r.provider,
        model: r.model,
        atMs: r.created_at,
      });
    }
    return out;
  }

  /**
   * Identities that have been replaced, old id to new.
   *
   * A project's id comes from a ladder — git root commit, then package name,
   * then path — so `git init` in a followed directory silently renames it from
   * `pkg:…` to `git:…`. Nothing is wrong with either id; they are answers to
   * the same question asked before and after the ground moved. But the config
   * still names the old one, so the project drops off the board and the chooser
   * grows a second row with the same display name. Measured here, on this
   * repository, the day it got a git history.
   *
   * The evidence is a directory: one `norm_path` recorded under two project
   * ids, the newer sighting winning. An id counts as superseded only when
   * *every* path it was ever seen at has moved on — a project still live
   * somewhere else is not a ghost, it is a project with two workspaces, and
   * one of them happening to be reused by something else must not retire it.
   *
   * Read at the point of use rather than written into the config: this is a
   * reading of what the disk says now, and a disk that says something else
   * tomorrow should be free to say so. The user's file is theirs.
   */
  identityMoves(): Map<string, string> {
    const rows = this.#db
      .prepare(
        `SELECT project_id, norm_path, last_seen_at
           FROM workspaces
          WHERE norm_path IN (
                SELECT norm_path FROM workspaces
                 GROUP BY norm_path HAVING COUNT(DISTINCT project_id) > 1)`,
      )
      .all() as Array<{ project_id: string; norm_path: string; last_seen_at: number }>;

    // Per path: who holds it now, and who used to.
    const holder = new Map<string, { id: string; at: number }>();
    for (const r of rows) {
      const cur = holder.get(r.norm_path);
      if (!cur || r.last_seen_at > cur.at) holder.set(r.norm_path, { id: r.project_id, at: r.last_seen_at });
    }

    // Per id: every path it was ever seen at, and whether it still holds any.
    const paths = new Map<string, string[]>();
    for (const r of rows) {
      const list = paths.get(r.project_id);
      if (list) list.push(r.norm_path);
      else paths.set(r.project_id, [r.norm_path]);
    }
    // Paths outside the contested set count too: an id living at one of them is
    // current, whatever happened to the directory it shares.
    const elsewhere = this.#db
      .prepare(
        `SELECT DISTINCT project_id FROM workspaces
          WHERE norm_path NOT IN (
                SELECT norm_path FROM workspaces
                 GROUP BY norm_path HAVING COUNT(DISTINCT project_id) > 1)`,
      )
      .all() as Array<{ project_id: string }>;
    const alive = new Set(elsewhere.map((r) => r.project_id));

    const direct = new Map<string, string>();
    for (const [id, own] of paths) {
      if (alive.has(id)) continue;
      let successor: { id: string; at: number } | null = null;
      let superseded = true;
      for (const path of own) {
        const now = holder.get(path);
        if (!now || now.id === id) {
          superseded = false;
          break;
        }
        if (!successor || now.at > successor.at) successor = now;
      }
      if (superseded && successor) direct.set(id, successor.id);
    }

    // Follow chains — pkg: became git: became path: — but never a cycle, which
    // two directories swapping owners could otherwise produce.
    const out = new Map<string, string>();
    for (const start of direct.keys()) {
      const seen = new Set<string>([start]);
      let at = direct.get(start) as string;
      while (direct.has(at) && !seen.has(at)) {
        seen.add(at);
        at = direct.get(at) as string;
      }
      if (at !== start) out.set(start, at);
    }
    return out;
  }

  stats(): { sizeBytes: number; sessions: number; transitions: number; projects: number } {
    const q = (sql: string): number =>
      Number((this.#db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    const pageCount = q('SELECT page_count AS n FROM pragma_page_count()');
    const pageSize = q('SELECT page_size AS n FROM pragma_page_size()');
    return {
      sizeBytes: pageCount * pageSize,
      sessions: q('SELECT COUNT(*) AS n FROM sessions'),
      transitions: q('SELECT COUNT(*) AS n FROM state_transitions'),
      projects: q('SELECT COUNT(*) AS n FROM projects'),
    };
  }

  /** Drop transitions older than the retention window. */
  prune(olderThanMs: number, now = Date.now()): number {
    const cutoff = now - olderThanMs;
    const before = this.stats().transitions;
    this.#db.prepare('DELETE FROM state_transitions WHERE at_ts < ?').run(cutoff);
    return before - this.stats().transitions;
  }

  /**
   * Enforce the retention policy.
   *
   * Two windows, not one. The normal window is generous because trend data is
   * the point of keeping history at all. The aggressive window exists for a
   * different failure: a database that has grown past the hard cap is already
   * costing someone disk on a machine we do not own, and at that point a
   * shorter history is unambiguously the lesser harm. The cap is checked before
   * the schedule so it cannot be outvoted by "not time yet".
   */
  maintain(now = Date.now()): MaintenanceResult {
    const t0 = Date.now();
    const sizeBefore = this.stats().sizeBytes;
    const hardCap = sizeBefore > DB_HARD_CAP_BYTES;
    const window = hardCap ? RETAIN_AGGRESSIVE_MS : RETAIN_TRANSITIONS_MS;

    let transitions = 0;
    let sessions = 0;
    this.#db.exec('BEGIN');
    try {
      transitions = this.prune(window, now);
      const before = this.stats().sessions;
      // ON DELETE CASCADE takes session_state with it.
      this.#db
        .prepare('DELETE FROM sessions WHERE last_seen_at < ?')
        .run(now - (hardCap ? RETAIN_AGGRESSIVE_MS : RETAIN_SESSIONS_MS));
      sessions = before - this.stats().sessions;
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    // Outside the transaction: neither of these can run inside one.
    // Databases created before the pragma order was fixed are stuck at NONE,
    // where this call does nothing at all. Converting is a one-off full
    // vacuum; after it, the incremental pass below is what keeps the file from
    // growing forever.
    this.#adoptAutoVacuum();
    this.#db.exec('PRAGMA incremental_vacuum');
    // A daemon that only ever appends never triggers an automatic checkpoint of
    // the right size, so the WAL drifts far larger than the database itself
    // (observed: 3.9 MB of WAL behind a 64 KB database). Harmless, but it makes
    // the on-disk footprint we report a lie.
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    return {
      transitionsDropped: transitions,
      sessionsDropped: sessions,
      hardCapTriggered: hardCap,
      sizeBytes: this.stats().sizeBytes,
      ms: Date.now() - t0,
    };
  }

  close(): void {
    this.#db.close();
  }
}

export interface MaintenanceResult {
  transitionsDropped: number;
  sessionsDropped: number;
  hardCapTriggered: boolean;
  sizeBytes: number;
  ms: number;
}

export interface StateChange {
  sessionId: string;
  projectId: string;
  from: string | null;
  to: string;
  subReason: string | null;
  dwellMs: number | null;
}

function needsYouFlag(s: SessionView): number {
  return s.state === 'WAITING_PERMISSION' ||
    s.state === 'WAITING_INPUT' ||
    s.state === 'STALLED' ||
    s.state === 'ERRORED'
    ? 1
    : 0;
}

function urgencyFlag(s: SessionView): number {
  if (s.state === 'WAITING_PERMISSION') return 3;
  if (s.state === 'STALLED' || s.state === 'ERRORED') return 2;
  if (s.state === 'WAITING_INPUT') return 1;
  return 0;
}

export type { ProjectView };
