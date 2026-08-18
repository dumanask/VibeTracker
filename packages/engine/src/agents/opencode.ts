/**
 * opencode — and, unchanged, Kilo.
 *
 * State lives in one SQLite database (`opencode.db`, 361 MB here) rather than in
 * per-session files, and the schema is the richest of any agent read so far:
 *
 * - `project.worktree` gives the **real path** of every directory opencode has
 *   been used in. No slug, no lossy encoding — which makes it the one agent
 *   whose project list needs no recovery work at all.
 * - `session` gives directory, title, agent, model, `time_compacting` and
 *   `time_archived`.
 * - `message.data` carries `role`, `finish` and `time.completed`, so turn
 *   ownership is exact: `finish:'stop'` with a completed time means the turn is
 *   over and the ball is with the human.
 * - `part.data` carries `type:'tool'` with `state.status`, so open tools are
 *   readable and `BUSY(tool:…)` is a fact rather than a guess.
 *
 * Kilo ships the same Drizzle schema — same tables, same columns — so it is the
 * same reader pointed at a different file. Discovered by reading it, not by
 * assuming: `kilo.db` here has `project`, `message`, `part`, `session`, `todo`
 * exactly as opencode does.
 *
 * **Two traps found in the real data.**
 *
 * `session.time_updated` is useless as "last activity": every one of the 66
 * sessions here carries the identical value `1787041061504`, stamped by a
 * migration that touched them all at once. A board built on it would say the
 * whole history was active this second. Activity is therefore taken from
 * `max(message.time_created)`, which is what actually moves.
 *
 * The `permission` column on `session` is *policy* — a JSON array of deny
 * rules like `[{"permission":"task","action":"deny"}]` — not a pending request.
 * Reading it as "waiting for approval" would light up 54 of 66 sessions. There
 * is a separate `permission` table, and it is empty; when it fills, that is the
 * place to look.
 *
 * **No pid anywhere**, so liveness is a declared recency window, exactly as for
 * Codex.
 *
 * Nothing is written. The database is opened `readOnly`, so a lock cannot be
 * taken from a running opencode and a corrupt page can never be our fault. No
 * message body, tool input or tool output is ever selected — the queries name
 * their columns, and the text columns are not among them except for the tool
 * `state.status` field the open-tool check needs.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { redactSnippet } from '@vibetracker/core';
import type { TranscriptFacts } from '@vibetracker/shared';
import {
  emptyFacts,
  type AdapterContext,
  type AgentAdapter,
  type AgentProjectHint,
  type DetectResult,
  type ObservedSession,
} from './types.ts';

/** Sessions considered at all by one poll, newest activity first. */
const SESSION_LIMIT = 60;

/** Tool `state.status` values that mean the call has not finished. */
const OPEN_STATUSES = new Set(['pending', 'running']);

export interface SqliteAgentSpec {
  id: string;
  displayName: string;
  /** Directory holding the database. */
  dir: string;
  dbFile: string;
}

function shareRoot(name: string): string {
  const home = homedir();
  if (platform() === 'win32') return join(home, '.local', 'share', name);
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), name);
}

export function opencodeSpecs(): SqliteAgentSpec[] {
  return [
    {
      id: 'opencode',
      displayName: 'opencode',
      dir: shareRoot('opencode'),
      dbFile: 'opencode.db',
    },
    // Kilo is an opencode fork and has not changed the schema. Listed
    // separately so `vt doctor` can say which one is installed and the board
    // can badge a session with the tool that actually produced it.
    { id: 'kilo', displayName: 'Kilo', dir: shareRoot('kilo'), dbFile: 'kilo.db' },
  ];
}

interface Conn {
  db: DatabaseSync;
  /** Rows in the `message` table this build knows how to read. */
  messages: number;
  sessions: number;
  /**
   * Sessions exist but none of their messages are in `message` — the schema
   * moved and this build can no longer see turn state.
   *
   * Distinguished from "installed but never used", which looks identical if you
   * only count messages: Kilo here has zero of both, and calling that drift
   * would put a scary warning in front of someone who simply has not run it.
   */
  drifted: boolean;
}

const conns = new Map<string, Conn | null>();

/**
 * A cached read-only connection.
 *
 * Kept open across polls: opening a 361 MB database per poll is the expensive
 * part, and in WAL mode a reader takes no lock outside a transaction, so
 * holding it costs the running agent nothing.
 */
function connect(dbPath: string): Conn | null {
  const cached = conns.get(dbPath);
  if (cached !== undefined) return cached;
  let conn: Conn | null = null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const messages =
      (db.prepare('select count(*) c from message').get() as { c?: number } | undefined)?.c ?? 0;
    const sessions =
      (db.prepare('select count(*) c from session').get() as { c?: number } | undefined)?.c ?? 0;
    conn = { db, messages, sessions, drifted: sessions > 0 && messages === 0 };
  } catch {
    conn = null;
  }
  conns.set(dbPath, conn);
  return conn;
}

/** Drop cached handles. Called when a scan context closes. */
export function closeSqliteAgents(): void {
  for (const c of conns.values()) {
    try {
      c?.db.close();
    } catch {
      /* already gone */
    }
  }
  conns.clear();
}

interface Row {
  [k: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Facts for one session, from its newest messages and their parts.
 *
 * Only the last few messages are read. Turn ownership is decided by the newest
 * one, and an open tool belongs to the message that called it — reading further
 * back would cost more and answer nothing the state machine asks.
 */
function factsFor(conn: Conn, dbPath: string, sessionId: string, mtimeMs: number): TranscriptFacts {
  const facts = emptyFacts(`${dbPath}#${sessionId}`, mtimeMs);
  if (conn.drifted) {
    // The schema moved: `message` is empty while sessions exist. Reported as an
    // unknown shape rather than guessed at — the newer `session_message` table
    // is present but empty here, so its `data` layout has never been seen and
    // writing a parser for it would be fiction.
    facts.unknownTypes.push('message:bos');
    return facts;
  }

  let rows: Row[];
  try {
    rows = conn.db
      .prepare(
        `select id, time_created, data from message
          where session_id = ? order by time_created desc limit 4`,
      )
      .all(sessionId) as Row[];
  } catch {
    return facts;
  }

  let newestId: string | undefined;
  for (const r of rows) {
    const data = str(r.data);
    if (!data) continue;
    let d: Row;
    try {
      d = JSON.parse(data) as Row;
    } catch {
      facts.parseFailures++;
      continue;
    }
    facts.linesParsed++;
    const role = str(d.role);
    if (facts.lastEntryRole === undefined && (role === 'user' || role === 'assistant')) {
      facts.lastEntryRole = role;
      facts.lastEntryAt = num(r.time_created);
      newestId = str(r.id);
      const time = d.time as Row | undefined;
      // An assistant message with no completion time is a turn in flight. The
      // state machine reads that as the user's move being processed, which is
      // what it is.
      if (role === 'assistant' && time && num(time.completed) === undefined) {
        facts.lastEntryRole = 'user';
      }
    }
  }

  if (newestId) {
    let parts: Row[];
    try {
      parts = conn.db
        .prepare(
          `select data from part where message_id = ? order by time_created desc limit 60`,
        )
        .all(newestId) as Row[];
    } catch {
      parts = [];
    }
    for (const p of parts) {
      const raw = str(p.data);
      if (!raw) continue;
      let d: Row;
      try {
        d = JSON.parse(raw) as Row;
      } catch {
        facts.parseFailures++;
        continue;
      }
      if (str(d.type) !== 'tool') continue;
      const state = d.state as Row | undefined;
      const status = str(state?.status);
      const callId = str(d.callID) ?? str(d.id);
      if (!callId) continue;
      if (status && OPEN_STATUSES.has(status)) {
        facts.openTools.push(str(d.tool) ?? 'unknown');
      }
    }
  }
  return facts;
}

export function createSqliteAgentAdapter(spec: SqliteAgentSpec): AgentAdapter {
  const dbPath = join(spec.dir, spec.dbFile);

  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities: {
      sessions: true,
      // No pid is recorded anywhere in the schema.
      liveProcess: false,
      turnState: true,
      openTools: true,
      // The `todo` table is here and is machine-verified — the best progress
      // source any agent offers. Not claimed as a capability because nothing
      // consumes it yet: the progress engine's provider registry is where it
      // belongs, and reporting it before then would be a promise, not a fact.
      todos: false,
    },

    async detect(): Promise<DetectResult> {
      if (!existsSync(dbPath)) {
        return { installed: existsSync(spec.dir), hasData: false, lastActivityAt: 0 };
      }
      const conn = connect(dbPath);
      if (!conn) {
        return {
          installed: true,
          hasData: false,
          lastActivityAt: 0,
          dir: spec.dir,
          note: 'unreadable',
        };
      }
      let last = 0;
      try {
        const r = conn.db.prepare('select max(time_created) t from message').get() as {
          t?: number;
        };
        last = num(r?.t) ?? 0;
      } catch {
        /* an unexpected schema is reported below, not thrown */
      }
      return {
        installed: true,
        hasData: conn.sessions > 0,
        lastActivityAt: last,
        dir: spec.dir,
        note: conn.drifted ? 'schema-drift' : conn.sessions === 0 ? 'never-used' : 'no-registry',
      };
    },

    async listSessions(ctx: AdapterContext): Promise<ObservedSession[]> {
      const conn = connect(dbPath);
      if (!conn || conn.messages === 0) return [];
      let recent: Row[];
      try {
        // Activity from the messages, never from `session.time_updated` — see
        // the note at the top of this file.
        recent = conn.db
          .prepare(
            `select session_id, max(time_created) last from message
              group by session_id order by last desc limit ?`,
          )
          .all(SESSION_LIMIT) as Row[];
      } catch {
        return [];
      }

      const out: ObservedSession[] = [];
      for (const r of recent) {
        const sessionId = str(r.session_id);
        const last = num(r.last);
        if (!sessionId || last === undefined) continue;
        if (ctx.now - last > ctx.recencyMs) break; // ordered: nothing newer follows

        let meta: Row | undefined;
        try {
          meta = conn.db
            .prepare(
              `select directory, title, version, agent, time_archived, time_created
                from session where id = ?`,
            )
            .get(sessionId) as Row | undefined;
        } catch {
          continue;
        }
        const cwd = str(meta?.directory);
        if (!cwd) continue;
        if (num(meta?.time_archived) !== undefined) continue;

        const facts = factsFor(conn, dbPath, sessionId, last);
        // The session title is free text the agent wrote, so it is redacted at
        // the point it enters, like every other agent-authored string.
        const title = str(meta?.title);
        if (title) facts.aiTitle = redactSnippet(title, 140);

        out.push({
          agentKind: spec.id,
          sessionId,
          cwd,
          startedAt: num(meta?.time_created),
          name: str(meta?.agent),
          cliVersion: str(meta?.version),
          liveness: 'live',
          livenessBasis: 'recency',
          facts,
        });
      }
      return out;
    },

    async listProjectHints(): Promise<AgentProjectHint[]> {
      const conn = connect(dbPath);
      if (!conn) return [];
      let rows: Row[];
      try {
        // `worktree` is the real absolute path. `time_updated` is only used to
        // order the chooser, where being stamped by a migration is harmless.
        rows = conn.db
          .prepare(`select worktree, time_updated from project where worktree is not null`)
          .all() as Row[];
      } catch {
        return [];
      }
      const out: AgentProjectHint[] = [];
      for (const r of rows) {
        const path = str(r.worktree);
        // opencode records a synthetic `global` project rooted at `/`. It is not
        // a directory anyone works in.
        if (!path || path === '/') continue;
        out.push({ agentKind: spec.id, path, lastSeenAt: num(r.time_updated) ?? 0 });
      }
      return out;
    },
  };
}

/** Newest mtime of the database file, for a cheap "has anything happened". */
export function dbMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
