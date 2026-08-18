/**
 * Dialects: the shapes of files we do not own.
 *
 * Claude Code's transcript format, session registry and IDE locks are all
 * undocumented. They change with the agent, on its schedule, and a change can
 * arrive on a user's machine long before it reaches ours. Two consequences
 * shaped this file.
 *
 * **The shapes are data.** A release that only renames a field should be a
 * JSON patch, not a code release — the same reasoning as `lexicons/`, and for
 * a stronger reason: here the format belongs to someone else entirely.
 *
 * **Nothing here ever throws.** An unknown entry type is counted and ignored.
 * A parser that refuses to run because the agent added a field would take the
 * whole dashboard down for a change that does not affect anything we read.
 * Instead the unknown *rate* is measured, and past a threshold the user is
 * told plainly that their agent is newer than this build.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type EntryRole = 'message' | 'meta.title' | 'meta.lastPrompt' | 'ignore';

export interface Dialect {
  dialectVersion: number;
  agent: string;
  appliesTo: string;
  entryTypes: Record<string, EntryRole>;
  fields: Record<string, string>;
  content: Record<string, string>;
  /**
   * Only agents that publish a live-session registry have these. Codex and
   * opencode do not — which is not a gap in the dialect but a fact about those
   * agents, and the reason their adapters report `liveProcess: false`.
   */
  registry?: { path: string; fields: Record<string, string>; startTimeKind: string };
  ide?: { path: string; fields: Record<string, string> };
  dead?: { paths: string[] };
}

const DIALECT_DIR = join(import.meta.dirname, '..', 'dialects');

/**
 * Unknown-line rate past which we stop claiming to understand the format.
 * Five percent of 200 lines is ten surprises — well past noise, well short of
 * the one-off malformed line every long-running file eventually has.
 */
export const DIALECT_DRIFT_RATIO = 0.05;
/** Below this many lines the ratio means nothing. */
export const DIALECT_DRIFT_MIN_LINES = 200;

let cache: Dialect[] | null = null;

function fallback(): Dialect {
  // A build with no dialect files still works, with the shapes that were true
  // when this was written. Degrading to "we know nothing" would be worse than
  // degrading to "we know what we knew".
  return {
    dialectVersion: 0,
    agent: 'claude-code',
    appliesTo: '*',
    entryTypes: {
      user: 'message',
      assistant: 'message',
      system: 'ignore',
      'ai-title': 'meta.title',
      'last-prompt': 'meta.lastPrompt',
      mode: 'ignore',
      'queue-operation': 'ignore',
      attachment: 'ignore',
      'file-history-snapshot': 'ignore',
      'file-history-delta': 'ignore',
      summary: 'ignore',
    },
    fields: {
      type: 'type',
      timestamp: 'timestamp',
      branch: 'gitBranch',
      sidechain: 'isSidechain',
      aiTitle: 'aiTitle',
      lastPrompt: 'lastPrompt',
      messageContent: 'message.content',
    },
    content: {
      toolUse: 'tool_use',
      toolResult: 'tool_result',
      toolUseId: 'id',
      toolResultId: 'tool_use_id',
      toolName: 'name',
    },
    registry: {
      path: 'sessions/*.json',
      fields: {
        pid: 'pid',
        sessionId: 'sessionId',
        cwd: 'cwd',
        startedAt: 'startedAt',
        startTime: 'procStart',
        version: 'version',
        kind: 'kind',
        entrypoint: 'entrypoint',
        name: 'name',
      },
      startTimeKind: 'filetime',
    },
    ide: {
      path: 'ide/*.lock',
      fields: { pid: 'pid', workspaceFolders: 'workspaceFolders', ideName: 'ideName', transport: 'transport' },
    },
    dead: { paths: ['history.jsonl', 'stats-cache.json'] },
  };
}

function loadAll(): Dialect[] {
  if (cache) return cache;
  const out: Dialect[] = [];
  try {
    for (const name of readdirSync(DIALECT_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(readFileSync(join(DIALECT_DIR, name), 'utf8')) as Dialect;
        if (typeof d?.agent === 'string' && d.entryTypes) out.push(d);
      } catch {
        /* a broken dialect file must not take the tool down */
      }
    }
  } catch {
    /* no dialects directory in this build */
  }
  cache = out.length > 0 ? out : [fallback()];
  return cache;
}

/**
 * Version range matching, for the two forms the dialect files use: `*` and
 * `>=A.B.C <D.E.F`.
 *
 * Hand-written rather than pulled in, for the same reason as the TOML parser:
 * this runs before anything else works, and it is thirty lines. Anything more
 * exotic than a bounded range would be a sign the dialect files are trying to
 * express something that belongs in a separate file.
 */
export function satisfies(version: string | undefined, range: string): boolean {
  if (range.trim() === '*' || !version) return true;
  const v = parse(version);
  if (!v) return true;
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})/.exec(part);
    if (!m) continue;
    const bound = parse(m[2]!);
    if (!bound) continue;
    const c = compare(v, bound);
    const op = m[1] ?? '=';
    const ok =
      op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

function parse(s: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * The dialect for an agent at an observed version.
 *
 * Falls back to the newest dialect for that agent rather than to nothing: a
 * user running a version past every declared range still gets a parser, plus
 * the drift warning that tells them why some things may be missing.
 */
export function dialectFor(agent = 'claude-code', version?: string): Dialect {
  const forAgent = loadAll().filter((d) => d.agent === agent);
  if (forAgent.length === 0) return fallback();
  const match = forAgent.find((d) => satisfies(version, d.appliesTo));
  if (match) return match;
  return forAgent.reduce((a, b) => (b.dialectVersion > a.dialectVersion ? b : a));
}

/** Entry types this dialect recognises, for the tail reader's fast path. */
export function knownEntryTypes(d: Dialect): Set<string> {
  return new Set(Object.keys(d.entryTypes));
}

export interface DriftVerdict {
  drifted: boolean;
  ratio: number;
  /** Types seen that the dialect does not name, most frequent first. */
  unknown: string[];
}

/**
 * Has the format moved out from under us?
 *
 * The signal is a *rate*, not a single surprise: agents add entry types
 * routinely, and one unrecognised line in ten thousand is nothing. A tenth of
 * every line being unrecognised means this build no longer understands the
 * file, and the user should hear that rather than quietly see less.
 */
export function assessDrift(linesParsed: number, unknown: string[], unknownCount: number): DriftVerdict {
  const ratio = linesParsed > 0 ? unknownCount / linesParsed : 0;
  return {
    drifted: linesParsed >= DIALECT_DRIFT_MIN_LINES && ratio > DIALECT_DRIFT_RATIO,
    ratio,
    unknown: unknown.slice(0, 8),
  };
}

/** Files a current agent no longer writes. Reading them would show stale data as fresh. */
export function deadPaths(d: Dialect): string[] {
  return d.dead?.paths ?? [];
}
