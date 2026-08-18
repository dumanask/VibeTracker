/**
 * The contract every agent other than Claude Code is read through.
 *
 * The shape is chosen so that adding an agent adds a *reader*, not a second
 * opinion. An adapter's whole job is to turn whatever the agent writes to disk
 * into `TranscriptFacts` — the same structure `tail.ts` produces for Claude
 * Code — and hand it back. `deriveState` then decides what the session is
 * doing, once, for all of them.
 *
 * That is deliberate and it is the only reason six agents can share one board.
 * If each adapter decided its own states, "waiting" would mean six things, the
 * fleet-load strip would be adding up incomparable numbers, and every rule the
 * state machine has learned (turn ownership beats CPU; a tool's deadline
 * depends on which tool; 20 seconds of debounce before believing a transition)
 * would have to be re-learned per agent, badly.
 *
 * What an adapter is NOT allowed to do:
 *
 * - **Write anything.** Not to the agent's state directory, not to the
 *   project. Every reader here opens files read-only, and SQLite is opened with
 *   `readOnly: true` so a corrupted page cannot be blamed on us and a lock
 *   cannot be taken from a running agent.
 * - **Copy free text.** Titles and prompts go through `redactSnippet` at the
 *   point they enter, exactly as the Claude Code reader does. Message bodies,
 *   tool inputs and tool outputs are never read at all — the readers select the
 *   columns they need, and the text columns are not among them.
 * - **Claim what it cannot see.** `capabilities` is the honest answer, and
 *   `vt doctor` prints it. An adapter that cannot tell a live session from a
 *   finished one says so, and the board draws that session with lower
 *   confidence instead of pretending.
 */
import type { Liveness, TranscriptFacts } from '@vibetracker/shared';

/** What an adapter can and cannot observe. Reported, never assumed. */
export interface AgentCapabilities {
  /** Sessions can be enumerated at all. */
  sessions: boolean;
  /** The agent records a pid, so PID-reuse protection applies. */
  liveProcess: boolean;
  /** Turn ownership is readable — "whose move is it". */
  turnState: boolean;
  /** Unfinished tool calls are readable, so `BUSY(tool:…)` is possible. */
  openTools: boolean;
  /** A machine-verified task list, like Claude Code's `TodoWrite`. */
  todos: boolean;
}

export interface DetectResult {
  /** The agent's state directory exists. */
  installed: boolean;
  /** It contains data we can actually read. */
  hasData: boolean;
  /** Newest activity we could see, ms since epoch. 0 when unknown. */
  lastActivityAt: number;
  /** Where we looked. Shown by `vt doctor`; never a guess. */
  dir?: string;
  /**
   * Why a capability is off, when the reason is this machine rather than the
   * adapter.
   *
   * A code, not a sentence. Free text here would never reach the English
   * catalogue: translation is keyed on the source string and the extractor is
   * static, so a `tr(detect.note)` at the render site is invisible to it and
   * would ship Turkish to an English user with nothing failing. The engine
   * reports the fact, `noteText` words it — the same split `Phrase` makes for
   * everything else that crosses the wire.
   */
  note?: AdapterNote;
}

/**
 * Reasons an adapter can give for reading less than it would like to.
 *
 * - `no-registry`  : the agent records no pid, so liveness is a recency window.
 * - `folders-only` : directories are readable, sessions are not.
 * - `never-used`   : installed, and has produced nothing to read.
 * - `schema-drift` : sessions exist but this build cannot find their messages.
 * - `log-only`     : the session store is empty; runs come from a log file.
 * - `unreadable`   : the store is there and would not open.
 */
export type AdapterNote =
  | 'no-registry'
  | 'folders-only'
  | 'never-used'
  | 'schema-drift'
  | 'log-only'
  | 'unreadable';

/**
 * How an adapter knows a session is alive — the thing that decides how much
 * the board is allowed to claim.
 *
 * - `pid`     : the agent wrote a pid, and the process probe confirmed it,
 *               start-time and all. As strong as Claude Code's.
 * - `recency` : no pid anywhere, so "alive" means "wrote something moments
 *               ago". A session the user closed a minute ago still looks live
 *               for the length of the window, and confidence is capped to say
 *               so.
 * - `none`    : we can enumerate the session and nothing more.
 */
export type LivenessBasis = 'pid' | 'recency' | 'none';

/**
 * One session as an adapter sees it, ready to be merged into the same
 * pipeline the Claude Code reader feeds.
 */
export interface ObservedSession {
  /** Adapter id — `codex`, `opencode`, … Never `claude-code`. */
  agentKind: string;
  sessionId: string;
  /** Working directory, verbatim from the agent. Normalised by the caller. */
  cwd: string;
  pid?: number;
  /**
   * Opaque process start time, when the agent records one. Compared for
   * equality only, exactly like Claude Code's `procStart`.
   */
  procStart?: string;
  startedAt?: number;
  name?: string;
  cliVersion?: string;
  liveness: Liveness;
  livenessBasis: LivenessBasis;
  /**
   * The same structure the Claude Code tail produces, so one state machine
   * serves every agent. `path` may be a database file rather than a
   * transcript; nothing downstream reads it except to show provenance.
   */
  facts: TranscriptFacts;
}

/** A directory an agent has been used in, for the project chooser. */
export interface AgentProjectHint {
  agentKind: string;
  /** Absolute path as the agent recorded it. */
  path: string;
  lastSeenAt: number;
}

export interface AdapterContext {
  now: number;
  /**
   * How recently a session must have been written to count as live when no pid
   * is available. Not a guess dressed up as a fact: it is the width of the
   * window inside which we admit we cannot tell.
   */
  recencyMs: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<DetectResult>;
  /**
   * Sessions worth putting on a board. Empty is a normal answer — an installed
   * agent that has not been used has nothing to show and that is not an error.
   */
  listSessions(ctx: AdapterContext): Promise<ObservedSession[]>;
  /**
   * Directories this agent has been used in, whether or not anything is
   * running. Feeds the project chooser only: a folder that was open in an IDE
   * is not a session, and inventing one would put thirty rows on the board
   * that nobody is working in.
   */
  listProjectHints(): Promise<AgentProjectHint[]>;
}

/** How long a pid-less session may have been quiet and still count as live. */
export const DEFAULT_RECENCY_MS = 90_000;

/**
 * Facts for a session we can enumerate but barely read.
 *
 * Every field absent rather than zeroed: `deriveState` distinguishes "the
 * assistant finished" from "we do not know whose turn it is", and a zero-filled
 * default would quietly answer the second question with the first.
 */
export function emptyFacts(path: string, mtimeMs: number, size = 0): TranscriptFacts {
  return {
    path,
    size,
    mtimeMs,
    openTools: [],
    unknownTypes: [],
    linesParsed: 0,
    parseFailures: 0,
  };
}
