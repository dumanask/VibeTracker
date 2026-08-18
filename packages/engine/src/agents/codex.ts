/**
 * Codex.
 *
 * One JSONL rollout per session under `~/.codex/sessions/<YYYY>/<MM>/<DD>/`,
 * first line a `session_meta` naming the working directory and the CLI version.
 * Measured here: 231 rollouts, the largest **778 MB** — so the file is tailed
 * with the same offset discipline Claude Code's transcripts get, never read.
 *
 * **There is no pid.** Not in `session_meta`, not anywhere in the file — 400
 * lines of the newest rollout were searched for one. Codex also keeps no live
 * registry. So the strongest liveness this adapter can offer is "wrote
 * something moments ago", and it says so: `livenessBasis: 'recency'`, which the
 * caller turns into reduced confidence and a visible reason.
 *
 * The tempting fix — find a `codex` process and read its command line for the
 * session — is refused. Command lines carry API keys; the process probe
 * deliberately never selects `CommandLine`, and buying liveness with a
 * credential in memory would be a bad trade in a tool whose entire claim is
 * that it does not hold your secrets.
 *
 * What *is* readable is turn ownership, precisely: `task_started` opens a turn
 * and `task_complete` closes it, and unfinished `function_call` /
 * `custom_tool_call` records give open tools by `call_id`. Those go into the
 * same `TranscriptFacts` the Claude Code reader produces, so `deriveState`
 * decides the state — one state machine, six agents.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dialectFor, knownEntryTypes, redactSnippet } from '@vibetracker/core';
import type { TranscriptFacts } from '@vibetracker/shared';
import type { TailReader, LineApplier } from '../tail.ts';
import {
  emptyFacts,
  type AdapterContext,
  type AgentAdapter,
  type AgentProjectHint,
  type DetectResult,
  type ObservedSession,
} from './types.ts';

const KNOWN = knownEntryTypes(dialectFor('codex'));

/**
 * Head bytes read while looking for `session_meta`.
 *
 * It is line 1, but line 1 is not small: it carries the whole system prompt.
 * Measured across 231 rollouts — median 464 bytes, p90 18 KB, longest 22 KB,
 * and 47 of them past 8 KB. 64 KB leaves room for that to grow; when it grows
 * past even this, `fieldFromHead` still recovers the three fields, because they
 * sit in the first few hundred bytes and the system prompt comes after.
 */
const META_BYTES = 64 * 1024;

/**
 * How far back in the date tree a poll looks.
 *
 * The tree is `year/month/day`, so "recent" is cheap to bound without a walk:
 * newest two years, newest two months inside each, newest three days inside
 * each. A session that has been idle for a week is not going to become live
 * between two polls, and the project chooser reads the whole tree anyway.
 */
const YEARS = 2;
const MONTHS = 2;
const DAYS = 3;

/** Files quieter than this are not tailed by the poll at all. */
const WARM_MS = 30 * 60 * 1000;

export function codexDir(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * Codex nests the record kind one level down, so the discriminator is
 * `type/payload.type` and the dialect is keyed that way too.
 */
function kindOf(e: Record<string, unknown>): string {
  const top = typeof e.type === 'string' ? e.type : '';
  const payload = e.payload as { type?: unknown } | undefined;
  const sub = typeof payload?.type === 'string' ? payload.type : '';
  return sub ? `${top}/${sub}` : top;
}

/** Records whose `call_id` opens a tool. */
const OPENS = new Set([
  'response_item/function_call',
  'response_item/custom_tool_call',
  'response_item/local_shell_call',
  'response_item/web_search_call',
]);

/**
 * Records whose `call_id` closes one.
 *
 * The `*_end` events are in here alongside the `*_output` records because a
 * tool whose end event has arrived is not open, however its result was written.
 * Closing an id that is already closed is a no-op, so counting both is safe and
 * missing either would leave a tool open forever and the session permanently
 * `BUSY(tool:…)`.
 */
const CLOSES = new Set([
  'response_item/function_call_output',
  'response_item/custom_tool_call_output',
  'response_item/local_shell_call_output',
  'event_msg/exec_command_end',
  'event_msg/patch_apply_end',
  'event_msg/mcp_tool_call_end',
  'event_msg/web_search_end',
]);

/**
 * Which records mean "the human's move" and which mean "the agent's".
 *
 * `task_started` counts as the user's side because that is what it marks: the
 * prompt was accepted and the turn is in flight. `task_complete` and
 * `turn_aborted` both hand the ball back — one because the work finished, the
 * other because it stopped — and operationally those are the same thing, which
 * is the rule the state machine was built on.
 */
const ROLES: Record<string, 'user' | 'assistant'> = {
  'event_msg/user_message': 'user',
  'event_msg/task_started': 'user',
  'event_msg/agent_message': 'assistant',
  'event_msg/task_complete': 'assistant',
  'event_msg/turn_aborted': 'assistant',
};

export const applyCodexLines: LineApplier = (target, lines) => {
  const facts = target.facts;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      facts.parseFailures++;
      continue;
    }
    facts.linesParsed++;

    const kind = kindOf(e);
    if (kind && !KNOWN.has(kind) && !facts.unknownTypes.includes(kind)) {
      facts.unknownTypes.push(kind);
    }

    const payload = (e.payload ?? {}) as Record<string, unknown>;

    if (OPENS.has(kind)) {
      const id = payload.call_id;
      if (typeof id === 'string') {
        target.openTools.set(id, typeof payload.name === 'string' ? payload.name : 'unknown');
      }
      continue;
    }
    if (CLOSES.has(kind)) {
      const id = payload.call_id;
      if (typeof id === 'string') target.openTools.delete(id);
      continue;
    }

    const role = ROLES[kind];
    if (!role) continue;

    // The user's prompt, and the agent's own wording of what it is doing.
    // Redacted here, at the single point either enters the process — the same
    // rule the Claude Code reader follows, and for the same reason: three
    // surfaces draw this string and the one that forgets is the one that puts
    // a key on a window pinned above everything else.
    if (typeof payload.message === 'string' && payload.message) {
      if (role === 'user') facts.lastPrompt = redactSnippet(payload.message, 140);
      else facts.aiTitle = redactSnippet(payload.message, 140);
    }

    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (facts.lastEntryAt === undefined || ts >= facts.lastEntryAt) {
        facts.lastEntryAt = ts;
        facts.lastEntryRole = role;
      }
    } else {
      // No timestamp on this record, but the ordering in the file is authority
      // enough for "who moved last".
      facts.lastEntryRole = role;
    }
  }
};

interface Meta {
  sessionId?: string;
  cwd?: string;
  version?: string;
}

/**
 * `session_meta` from the head of a rollout.
 *
 * Cached by path for the process's lifetime: it is written once, on the first
 * line, and cannot change. Without the cache a poll would re-open every warm
 * rollout to re-read a line it already has.
 */
const metaCache = new Map<string, Meta>();

/**
 * One JSON string field out of a head we could not parse as a whole.
 *
 * Not a JSON parser: it finds `"key":"..."` and hands the captured span to
 * `JSON.parse` as a string literal, so escapes are decoded by the real thing
 * rather than by a regex. That matters here -- every path on this machine is a
 * Windows path, and every backslash in it arrives doubled.
 */
function fieldFromHead(text: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text);
  if (!m?.[1]) return undefined;
  try {
    const v = JSON.parse(m[1]) as unknown;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

async function readMeta(path: string): Promise<Meta> {
  const hit = metaCache.get(path);
  if (hit) return hit;
  let out: Meta = {};
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(META_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl >= 0) {
      const line = text.slice(0, nl);
      if (line.includes('session_meta')) {
        try {
          const p = ((JSON.parse(line) as { payload?: Record<string, unknown> }).payload ??
            {}) as Record<string, unknown>;
          // Older rollouts carry `id`, newer ones `session_id`, and the newest
          // carry both with the same value.
          const id = typeof p.session_id === 'string' ? p.session_id : p.id;
          out = {
            sessionId: typeof id === 'string' ? id : undefined,
            cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
            version: typeof p.cli_version === 'string' ? p.cli_version : undefined,
          };
        } catch {
          /* falls through to the field scan below */
        }
      }
    }
    // Either the first line ran past our window, or it would not parse. The
    // fields are still in here: they precede the system prompt.
    if (!out.cwd && text.includes('session_meta')) {
      out = {
        sessionId: fieldFromHead(text, 'session_id') ?? fieldFromHead(text, 'id'),
        cwd: fieldFromHead(text, 'cwd'),
        version: fieldFromHead(text, 'cli_version'),
      };
    }
  } catch {
    /* unreadable: treated as a rollout with no metadata */
  } finally {
    await fh?.close();
  }
  metaCache.set(path, out);
  return out;
}

/** Numeric-named subdirectories, newest first. */
async function newestDirs(dir: string, take: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, take)
    .map((n) => join(dir, n));
}

interface Rollout {
  path: string;
  size: number;
  mtimeMs: number;
}

async function rolloutsIn(dir: string): Promise<Rollout[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = await Promise.all(
    names
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (n): Promise<Rollout | null> => {
        const path = join(dir, n);
        try {
          const st = await stat(path);
          return { path, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  return out.filter((r): r is Rollout => r !== null);
}

/** Rollouts in the recent slice of the date tree. */
async function recentRollouts(root: string): Promise<Rollout[]> {
  const out: Rollout[] = [];
  for (const year of await newestDirs(root, YEARS)) {
    for (const month of await newestDirs(year, MONTHS)) {
      for (const day of await newestDirs(month, DAYS)) {
        out.push(...(await rolloutsIn(day)));
      }
    }
  }
  return out;
}

/** Every rollout, for the project chooser. Measured: 231 files in ~200 ms. */
async function allRollouts(root: string): Promise<Rollout[]> {
  const out: Rollout[] = [];
  for (const year of await newestDirs(root, 99)) {
    for (const month of await newestDirs(year, 99)) {
      for (const day of await newestDirs(month, 99)) {
        out.push(...(await rolloutsIn(day)));
      }
    }
  }
  return out;
}

export function createCodexAdapter(tail: () => TailReader): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      sessions: true,
      // No pid is recorded anywhere, so the PID-reuse guard has nothing to
      // compare and liveness is a recency window we declare.
      liveProcess: false,
      turnState: true,
      openTools: true,
      todos: false,
    },

    async detect(): Promise<DetectResult> {
      const root = codexDir();
      const sessions = join(root, 'sessions');
      try {
        await stat(root);
      } catch {
        return { installed: false, hasData: false, lastActivityAt: 0 };
      }
      const recent = await recentRollouts(sessions);
      const lastActivityAt = recent.reduce((a, r) => Math.max(a, r.mtimeMs), 0);
      return {
        installed: true,
        hasData: recent.length > 0,
        lastActivityAt,
        dir: sessions,
        note: 'no-registry',
      };
    },

    async listSessions(ctx: AdapterContext): Promise<ObservedSession[]> {
      const root = join(codexDir(), 'sessions');
      const warm = (await recentRollouts(root)).filter(
        (r) => ctx.now - r.mtimeMs < WARM_MS && r.size > 0,
      );
      const out = await Promise.all(
        warm.map(async (r): Promise<ObservedSession | null> => {
          const meta = await readMeta(r.path);
          if (!meta.cwd) return null;
          // `headBytes: 0` because the head is read here instead: this file's
          // origin facts are a Codex `session_meta`, not a Claude entry, and
          // the shared head reader looks for the latter.
          const facts: TranscriptFacts =
            (await tail().read(r.path, { apply: applyCodexLines, headBytes: 0 })) ??
            emptyFacts(r.path, r.mtimeMs, r.size);
          const last = Math.max(facts.lastEntryAt ?? 0, facts.mtimeMs);
          return {
            agentKind: 'codex',
            sessionId: meta.sessionId ?? r.path,
            cwd: meta.cwd,
            cliVersion: meta.version,
            startedAt: undefined,
            liveness: ctx.now - last < ctx.recencyMs ? 'live' : 'dead',
            livenessBasis: 'recency',
            facts,
          };
        }),
      );
      return out.filter((s): s is ObservedSession => s !== null);
    },

    async listProjectHints(): Promise<AgentProjectHint[]> {
      const root = join(codexDir(), 'sessions');
      const newestByPath = new Map<string, number>();
      for (const r of await allRollouts(root)) {
        if (r.size === 0) continue;
        const meta = await readMeta(r.path);
        if (!meta.cwd) continue;
        const prev = newestByPath.get(meta.cwd) ?? 0;
        if (r.mtimeMs > prev) newestByPath.set(meta.cwd, r.mtimeMs);
      }
      return [...newestByPath].map(([path, lastSeenAt]) => ({
        agentKind: 'codex',
        path,
        lastSeenAt,
      }));
    },
  };
}
