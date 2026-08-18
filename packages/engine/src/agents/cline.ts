/**
 * Cline.
 *
 * The only non-Claude agent here that records a **pid**, which makes it the
 * only one whose liveness can be as strong as Claude Code's. `sessions.db`
 * (`~/.cline/data/db/sessions.db`) declares:
 *
 *   session_id, source, pid, started_at, ended_at, exit_code, status,
 *   interactive, provider, model, cwd, workspace_root, parent_session_id,
 *   parent_agent_id
 *
 * — everything needed for a real row on the board, including a parent link for
 * subagents.
 *
 * **Honest caveat, and it matters.** That table is empty on this machine: the
 * CLI is installed and has been started once, but never ran an interactive
 * session. So the schema was read, the reader was written against it and
 * against a synthetic fixture — but it has never been exercised on live rows.
 * The capability matrix says `sessions` is available; if the columns turn out to
 * be populated differently in practice, that is the part to distrust first.
 *
 * What *is* verified here is the fallback: `data/logs/cline.log` holds one
 * structured JSON object per line with `pid`, `cwd`, `time` and `msg`, and the
 * single real line on this machine reads
 * `{"time":"2026-08-13T14:01:34.098Z","pid":29228,"cwd":"C:\\dev\\AgentWorld",
 * "msg":"CLI run started"}`.
 *
 * The log is used only for what it can support. It records a start and never a
 * finish, so "there was a line five days ago" is not a session — the pid is put
 * to the process probe, and a run whose process is gone is reported gone. That
 * is the same rule Claude Code's registry gets, and it is why a pid is worth
 * more than a timestamp.
 *
 * Turn ownership and open tools are not available from either source, so both
 * are declared false rather than guessed at. A Cline row therefore says whether
 * a run is alive and where — and stops there.
 *
 * `data/workspaces/<hash>/workspaceState.json` looks promising and is not: all
 * thirty of them contain `{"__vscodeMigrationVersion": 1}` and nothing else.
 */
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  emptyFacts,
  type AdapterContext,
  type AgentAdapter,
  type AgentProjectHint,
  type DetectResult,
  type ObservedSession,
} from './types.ts';

/** Log bytes read from the end. One record is ~200 bytes. */
const LOG_TAIL = 64 * 1024;

/** Log records at most this old are offered as sessions for a pid check. */
const LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

export function clineDir(): string {
  return join(homedir(), '.cline', 'data');
}

interface Row {
  [k: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}
function when(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

let dbCache: DatabaseSync | null | undefined;

function db(): DatabaseSync | null {
  if (dbCache !== undefined) return dbCache;
  const path = join(clineDir(), 'db', 'sessions.db');
  try {
    dbCache = new DatabaseSync(path, { readOnly: true });
  } catch {
    dbCache = null;
  }
  return dbCache;
}

export function closeCline(): void {
  try {
    dbCache?.close();
  } catch {
    /* already gone */
  }
  dbCache = undefined;
}

interface LogRun {
  pid: number;
  cwd: string;
  at: number;
}

/**
 * `CLI run started` records from the tail of the log.
 *
 * Only the tail: this is a log, it grows, and the newest runs are the only ones
 * that could still be alive. Lines that will not parse are skipped rather than
 * thrown on — a log being appended to while we read it ends mid-line by design.
 */
async function readLog(): Promise<{ runs: LogRun[]; mtimeMs: number }> {
  const path = join(clineDir(), 'logs', 'cline.log');
  let fh;
  try {
    const st = await stat(path);
    fh = await open(path, 'r');
    const from = Math.max(0, st.size - LOG_TAIL);
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    // Drop the first line when the window started mid-file, and the last
    // always: neither is guaranteed to be whole.
    const usable = lines.slice(from > 0 ? 1 : 0, -1);
    const byPid = new Map<number, LogRun>();
    for (const line of usable) {
      const t = line.trim();
      if (!t || !t.includes('"pid"')) continue;
      try {
        const o = JSON.parse(t) as Row;
        const pid = int(o.pid);
        const cwd = str(o.cwd);
        const at = when(o.time);
        if (pid === undefined || !cwd || at === undefined) continue;
        // A pid appears on every line of that run; the newest wins.
        const prev = byPid.get(pid);
        if (!prev || at > prev.at) byPid.set(pid, { pid, cwd, at });
      } catch {
        /* a line we cannot read is a line we skip */
      }
    }
    return { runs: [...byPid.values()], mtimeMs: st.mtimeMs };
  } catch {
    return { runs: [], mtimeMs: 0 };
  } finally {
    await fh?.close();
  }
}

export function createClineAdapter(): AgentAdapter {
  return {
    id: 'cline',
    displayName: 'Cline',
    capabilities: {
      sessions: true,
      // A pid is recorded, which is what makes this the strongest liveness of
      // any non-Claude adapter here.
      liveProcess: true,
      // Neither the session table nor the log records message roles or tool
      // calls, so a Cline row says where and whether, not what.
      turnState: false,
      openTools: false,
      todos: false,
    },

    async detect(): Promise<DetectResult> {
      const dir = clineDir();
      if (!existsSync(dir)) return { installed: false, hasData: false, lastActivityAt: 0 };
      const handle = db();
      let rows = 0;
      if (handle) {
        try {
          rows =
            (handle.prepare('select count(*) c from sessions').get() as { c?: number })?.c ?? 0;
        } catch {
          rows = 0;
        }
      }
      const log = await readLog();
      const lastActivityAt = Math.max(log.mtimeMs, ...log.runs.map((r) => r.at), 0);
      return {
        installed: true,
        hasData: rows > 0 || log.runs.length > 0,
        lastActivityAt,
        dir,
        note: rows > 0 ? undefined : log.runs.length > 0 ? 'log-only' : 'never-used',
      };
    },

    async listSessions(ctx: AdapterContext): Promise<ObservedSession[]> {
      const out: ObservedSession[] = [];
      const handle = db();
      if (handle) {
        try {
          const rows = handle
            .prepare(
              `select session_id, pid, started_at, ended_at, status, cwd, workspace_root,
                      provider, model, interactive
                 from sessions where ended_at is null order by started_at desc limit 40`,
            )
            .all() as Row[];
          for (const r of rows) {
            const sessionId = str(r.session_id);
            const cwd = str(r.cwd) ?? str(r.workspace_root);
            const pid = int(r.pid);
            if (!sessionId || !cwd || pid === undefined) continue;
            const startedAt = when(r.started_at);
            out.push({
              agentKind: 'cline',
              sessionId,
              cwd,
              pid,
              startedAt,
              name: str(r.status),
              cliVersion: str(r.provider),
              // Resolved by the caller against the process probe; a pid is a
              // question, not an answer.
              liveness: 'unknown',
              livenessBasis: 'pid',
              facts: emptyFacts(join(clineDir(), 'db', 'sessions.db'), startedAt ?? ctx.now),
            });
          }
        } catch {
          /* the table is not the shape this build knows; the log still is */
        }
      }
      if (out.length > 0) return out;

      // Fallback: the log names a pid and a directory. Everything older than a
      // day is dropped before the probe is troubled — a run from last week
      // whose pid has since been handed to a browser tab is exactly the
      // false positive the PID-reuse work exists to prevent.
      const { runs } = await readLog();
      for (const run of runs) {
        if (ctx.now - run.at > LOG_WINDOW_MS) continue;
        out.push({
          agentKind: 'cline',
          sessionId: `log:${run.pid}:${run.at}`,
          cwd: run.cwd,
          pid: run.pid,
          startedAt: run.at,
          liveness: 'unknown',
          livenessBasis: 'pid',
          facts: emptyFacts(join(clineDir(), 'logs', 'cline.log'), run.at),
        });
      }
      return out;
    },

    async listProjectHints(): Promise<AgentProjectHint[]> {
      const newest = new Map<string, number>();
      const bump = (path: string, at: number): void => {
        if ((newest.get(path) ?? 0) < at) newest.set(path, at);
      };
      const handle = db();
      if (handle) {
        try {
          for (const r of handle
            .prepare('select cwd, workspace_root, started_at from sessions')
            .all() as Row[]) {
            const at = when(r.started_at) ?? 0;
            const cwd = str(r.cwd) ?? str(r.workspace_root);
            if (cwd) bump(cwd, at);
          }
        } catch {
          /* fall through to the log */
        }
      }
      for (const run of (await readLog()).runs) bump(run.cwd, run.at);
      return [...newest].map(([path, lastSeenAt]) => ({
        agentKind: 'cline',
        path,
        lastSeenAt,
      }));
    },
  };
}
