/**
 * Shared vocabulary for VibeTracker.
 *
 * Erasable-syntax-only TypeScript: no `enum`, no `namespace`, no parameter
 * properties. Node 22 strips types at load time, so anything that emits
 * runtime code from a type position would break `node src/index.ts`.
 */

// ── session state machine ────────────────────────────────────────────────
export const SessionState = {
  Starting: 'STARTING',
  Busy: 'BUSY',
  WaitingPermission: 'WAITING_PERMISSION',
  WaitingInput: 'WAITING_INPUT',
  Stalled: 'STALLED',
  Errored: 'ERRORED',
  Ended: 'ENDED',
  Orphaned: 'ORPHANED',
  Unknown: 'UNKNOWN',
} as const;
export type SessionStateName = (typeof SessionState)[keyof typeof SessionState];

/** 0 = nothing to do, 3 = drop everything. Drives sort order and notifications. */
export const URGENCY: Record<SessionStateName, 0 | 1 | 2 | 3> = {
  STARTING: 0,
  BUSY: 0,
  WAITING_PERMISSION: 3,
  WAITING_INPUT: 1,
  STALLED: 2,
  ERRORED: 2,
  ENDED: 0,
  ORPHANED: 0,
  UNKNOWN: 0,
};

export function needsYou(state: SessionStateName): boolean {
  return (
    state === SessionState.WaitingPermission ||
    state === SessionState.WaitingInput ||
    state === SessionState.Stalled ||
    state === SessionState.Errored
  );
}

// ── process liveness ────────────────────────────────────────────────────
/**
 * `reused` is a first-class value, not an error: the PID exists but belongs to
 * a different process than the one that wrote the registry entry. Measured on
 * the reference machine: 3 of 50 entries. Collapsing it into `live` produces a
 * 23% false-positive rate on "how many agents are running".
 */
export type Liveness = 'live' | 'dead' | 'reused' | 'unknown';

/**
 * How precisely we can tell two processes apart that shared a PID.
 * - `exact`  : start time is exact enough that equality is proof (Windows FILETIME, Linux jiffies)
 * - `second` : start time has 1-second granularity (macOS `ps lstart`); a PID
 *              recycled inside the same second can evade the guard.
 * - `none`   : we can only tell whether the PID exists at all.
 */
export type ProbePrecision = 'exact' | 'second' | 'none';

export type StartTimeKind = 'filetime' | 'jiffies' | 'lstart' | 'none';

export interface ProcSnapshot {
  pid: number;
  /** Opaque. Compared for equality only — never parsed, never ordered. */
  startTime: string;
  startTimeKind: StartTimeKind;
  /** Cumulative kernel+user CPU in nanoseconds. Only deltas are meaningful. */
  cpuNs: number;
  /** Resident set size in bytes, 0 when unavailable. */
  rss: number;
}

/**
 * One node of the system process tree.
 *
 * Deliberately carries no command line. That is where API keys, tokens and
 * connection strings live; capturing it would make every log line and every
 * diagnostic bundle a credential leak. Parentage and start time are enough to
 * answer the only question we ask of the tree.
 */
export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
  /** Wall-clock start, ms since epoch. Null when the platform cannot supply it. */
  startMs: number | null;
}

export interface ProcessProbe {
  readonly kind: string;
  readonly precision: ProbePrecision;
  snapshot(pids: number[]): Promise<Map<number, ProcSnapshot>>;
  /**
   * Whole process tree, or null when unavailable on this platform. Used to tell
   * "the command is genuinely running" from "the agent is sitting on a
   * permission prompt" — see `classifyOpenTool`.
   */
  listTree(): Promise<Map<number, ProcessTreeEntry> | null>;
  dispose(): Promise<void>;
}

/**
 * What a tool does while it is open, which decides how to read its silence.
 *
 * - `spawns-children`: the work happens in a child process, so the agent's own
 *   CPU is 0% whether the command is running or the agent is blocked on a
 *   permission prompt. Only the process tree can tell them apart.
 * - `local-instant`: completes in milliseconds. Still being open after tens of
 *   seconds is not slowness, it is a permission prompt.
 * - `network`: legitimately slow and invisible to both CPU and the process tree.
 */
export type ToolClass = 'spawns-children' | 'local-instant' | 'network' | 'unknown';

/**
 * Structural shape of a descendant summary, so pure logic can depend on it
 * without importing the platform package.
 */
export interface DescendantSummaryLike {
  total: number;
  recent: number;
  startTimesKnown: boolean;
}

export function classifyTool(tool: string): ToolClass {
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') return 'spawns-children';
  if (
    tool === 'Read' ||
    tool === 'Write' ||
    tool === 'Edit' ||
    tool === 'NotebookEdit' ||
    tool === 'Glob' ||
    tool === 'Grep' ||
    tool === 'TodoWrite'
  ) {
    return 'local-instant';
  }
  if (tool === 'WebFetch' || tool === 'WebSearch' || tool === 'Task' || tool.startsWith('mcp__')) {
    return 'network';
  }
  return 'unknown';
}

// ── agent-side raw records ──────────────────────────────────────────────

/** One `<claudeDir>/sessions/<pid>.json` file. Undocumented shape; all optional. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  /** Absent on platforms/versions that don't write it — feature-detected. */
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  /** Absolute path of the file this came from. */
  sourceFile: string;
}

/** One `<claudeDir>/ide/<port>.lock` file — maps an IDE window to its folders. */
export interface IdeWindow {
  pid: number;
  workspaceFolders: string[];
  ideName?: string;
  transport?: string;
  lockFile: string;
  alive: boolean;
}

/** What a bounded tail read of a transcript told us. */
export interface TranscriptFacts {
  path: string;
  size: number;
  mtimeMs: number;
  aiTitle?: string;
  lastPrompt?: string;
  gitBranch?: string;
  /** Timestamp of the newest entry that carried one. */
  lastEntryAt?: number;
  /** Role of the newest message-bearing entry. */
  lastEntryRole?: 'user' | 'assistant';
  /** Tool calls seen with no matching result in everything read so far. */
  openTools: string[];
  /** Line types we did not recognize — feeds dialect-drift detection. */
  unknownTypes: string[];
  linesParsed: number;
  parseFailures: number;
}

// ── project identity ────────────────────────────────────────────────────
export type IdentityKind = 'git_root' | 'package' | 'path';

export interface WorkspaceInfo {
  normPath: string;
  realPath: string;
  rawPathSample: string;
  label?: string;
  isWorktree: boolean;
  gitRootSha?: string;
  gitCommonDir?: string;
  gitRemote?: string;
  branch?: string;
  headSha?: string;
  headSubject?: string;
  headAtMs?: number;
  commitCount?: number;
  dirtyCount?: number;
  /** True when >80% of dirty paths look like build output, not authored work. */
  dirtyIsBuildNoise?: boolean;
  storageKind: 'local' | 'cloud' | 'temp' | 'network' | 'wsl';
}

export interface SessionView {
  sessionId: string;
  /**
   * Which agent produced this session — `claude-code`, `codex`, `opencode`,
   * `kilo`, `cline`.
   *
   * Absent on reports older than 0.2, where every session was Claude Code's.
   * Carried per session rather than per project because one project routinely
   * has two agents in it, and a board that could not say which was which would
   * be adding up rows the user cannot tell apart.
   */
  agentKind?: string;
  name?: string;
  pid: number;
  liveness: Liveness;
  state: SessionStateName;
  /** Why we believe `state` — rendered in the UI, never invented. */
  evidence: string[];
  confidence: number;
  cwd: string;
  normPath: string;
  entrypoint?: string;
  cliVersion?: string;
  startedAt?: number;
  idePid?: number;
  ideName?: string;
  title?: string;
  lastPrompt?: string;
  lastActivityAt?: number;
  openTools: string[];
  transcriptPath?: string;
  transcriptSize?: number;
  /**
   * When the session entered its current state. Filled by the daemon from
   * persisted history — a single scan cannot know it, and it is what makes
   * "blocked for 41 minutes" answerable rather than "blocked".
   */
  stateSince?: number;
  /**
   * True when this session's state came from hook events rather than from
   * inference. Shown in the UI, because the difference is real: a passive
   * `WAITING_PERMISSION` is a good guess, a hooked one is a fact.
   */
  hooked?: boolean;
  /** Live subagent count, only knowable from SubagentStart/Stop hooks. */
  subagents?: number;
}

/**
 * A sentence the engine describes but does not write: a source-language
 * template plus its arguments.
 *
 * It lives in `shared` because it crosses the wire. The HTTP API serves these
 * structurally, so a client can translate the template, style the arguments
 * differently, or turn a file name into a link — none of which is possible
 * once the parts have been glued into a finished string.
 */
export interface Phrase {
  key: string;
  args: Array<string | number | Phrase>;
}

/**
 * What the project's own planning documents say about where it is.
 * Structurally typed here so `shared` stays free of engine imports.
 */
export interface ProgressView {
  phase: {
    labelRaw: string;
    unit: string;
    ordinal: number;
    total: number;
    kind: string;
    sub?: string;
    basis: string;
    confidence: number;
  } | null;
  percent: number | null;
  basis: string;
  percentSuppressed?: Phrase;
  /** Why no phase is named, when documents were read but none could speak. */
  phaseSuppressed?: Phrase;
  approximate: boolean;
  nextAction?: string;
  observedAt?: number;
  provenance?: Phrase;
  drift: Array<{ code: string; severity: string; claim: Phrase; evidence: Phrase }>;
  sourceCount: number;
  planCount: number;
  /** Counted weights behind `percent`, so history can compare like with like. */
  doneWeight?: number | null;
  totalWeight?: number | null;
}

export interface ProjectView {
  projectId: string;
  identityKind: IdentityKind;
  displayName: string;
  workspaces: WorkspaceInfo[];
  sessions: SessionView[];
  /** e.g. 'no-git', 'dirty-flood', 'diverged', 'duplicate-path', 'subdir-project' */
  flags: string[];
  /** Absent until the phase engine has read this project's documents. */
  progress?: ProgressView;
  /**
   * Whether the user asked to follow this project.
   *
   * Untracked projects are still reported, and deliberately so: `vt projects`
   * needs something to offer, and a project you cannot see is a project you
   * cannot add back. They are simply not rendered by default, and they skip
   * the expensive document read, so an ignored project costs nearly nothing.
   */
  tracked: boolean;
  /**
   * What this project's agents are doing, in one row's worth of numbers.
   *
   * Computed once, in the engine, because three surfaces render it — the
   * terminal, the dashboard and the pinned note — and two of them disagreeing
   * about the same project destroys trust in both. Whoever draws it decides
   * how it looks; nobody re-decides what it says.
   */
  summary: AgentSummary;
  /**
   * Recent agent activity, oldest first: one value per minute, each the most
   * sessions this project had engaged during that minute.
   *
   * Only the daemon can supply it — a single `vt status` has no past to draw —
   * so it is absent rather than zero-filled when nobody has been watching. A
   * flat line and no line are different statements and are drawn differently.
   */
  momentum?: number[];
}

export type AgentSummaryKind = 'waiting' | 'running' | 'idle' | 'none';

export interface AgentSummary {
  kind: AgentSummaryKind;
  /** Sessions blocked on the user. */
  waiting: number;
  /** Sessions doing work right now. */
  running: number;
  /** Sessions whose process is still alive, running or not. */
  live: number;
  /** Every session seen for this project, dead ones included. */
  total: number;
  /** Highest urgency among the waiting sessions; 0 when none wait. */
  urgency: number;
  /** Session id of the one worth naming first, if any. */
  leadSessionId?: string;
  /** When that session entered its current state. */
  leadSince?: number;
  /** What it is doing, for the one line there is room for. */
  leadTitle?: string;
}

/**
 * The whole board in one bar. Computed in core by `summarizeBoard`; see there
 * for why this is a load figure and not an overall completion percentage.
 */
export interface BoardLoad {
  live: number;
  waiting: number;
  running: number;
  /** Engaged share of live sessions, or null when nothing is live. */
  percent: number | null;
}

/** What one adapter found this pass. Rendered by `vt doctor` and the panel. */
export interface AgentTally {
  agentKind: string;
  displayName: string;
  installed: boolean;
  /** Sessions this pass put on the board. */
  live: number;
  /**
   * Whether this adapter reads sessions at all.
   *
   * False for the editors: they can name every folder they have opened and
   * nothing about what an agent is doing inside one. Distinguishing that from
   * "reads sessions and found none" is the difference between a capability that
   * is missing and one that is idle.
   */
  readsSessions: boolean;
  lastActivityAt: number;
  /**
   * How liveness was established. `recency` means the agent records no pid, so
   * "live" is a declared window rather than a fact about a process.
   */
  livenessBasis: 'pid' | 'recency' | 'none';
  turnState: boolean;
  openTools: boolean;
  /**
   * Why a capability is off, when the reason is this machine.
   *
   * A code the client words itself — see `AdapterNote`. Crossing the wire as a
   * sentence would put the daemon's language on the reader's screen.
   */
  note?: string;
}

export interface StatusReport {
  generatedAt: number;
  platform: string;
  probeKind: string;
  probePrecision: ProbePrecision;
  claudeDir: string;
  counts: {
    registryEntries: number;
    live: number;
    dead: number;
    reused: number;
    projects: number;
    /** Projects seen but not followed — the pool `vt projects add` draws from. */
    untracked: number;
    needsYou: number;
    ideWindows: number;
  };
  /**
   * Per-agent tallies, one entry per adapter that was read.
   *
   * Separate from `counts` on purpose. `counts` tells the Claude Code registry's
   * story — 50 entries, 13 live, 3 with recycled pids — and folding other agents
   * into it would destroy the one number that proves the PID-reuse guard works.
   * Absent on reports older than 0.2.
   */
  agents?: AgentTally[];
  /** Feature-detection results — what worked, what is missing and why. */
  capabilities: Record<string, { ok: boolean; detail?: string }>;
  warnings: string[];
  projects: ProjectView[];
  ideWindows: IdeWindow[];
  /** Fleet load across followed projects. Absent on reports older than 0.1. */
  load?: BoardLoad;
}

export * from './hooks.ts';
