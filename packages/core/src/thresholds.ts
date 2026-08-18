/**
 * Every tuning number in the system, in one file.
 *
 * These decide whether the dashboard cries wolf, so they are collected here
 * rather than scattered through the logic: changing behaviour should mean
 * editing values, not hunting through branches.
 */

/**
 * Stall deadlines by tool class, in milliseconds. A test suite or workspace
 * build legitimately runs for many minutes writing nothing to the transcript,
 * because the agent flushes on message completion rather than continuously.
 * Local filesystem calls do not.
 */
export const STALL_MS: Record<string, number> = {
  Bash: 900_000,
  BashOutput: 900_000,
  Task: 900_000,
  WebSearch: 900_000,
  WebFetch: 900_000,
  Read: 60_000,
  Write: 60_000,
  Edit: 60_000,
  NotebookEdit: 60_000,
  Glob: 60_000,
  Grep: 60_000,
};

export const STALL_MCP_MS = 300_000;
export const STALL_THINKING_MS = 300_000;

/** Passive detection infers tool class less reliably, so it gets more rope. */
export const PASSIVE_MULTIPLIER = 1.5;

/**
 * Below this the process counts as doing nothing. An idle Node process still
 * shows around 1% from timers and IPC, so 1% was too generous — it kept
 * finished sessions reading as BUSY.
 */
export const CPU_BUSY_PCT = 3;

/**
 * The gap between "assistant finished its text" and "assistant starts the next
 * tool" is routinely 2-8 s. Twenty seconds is comfortably past that and still
 * reads as instant to someone scanning a dashboard.
 */
export const RECENT_WRITE_MS = 20_000;

/**
 * How long a local, in-process tool may stay open before the only sensible
 * explanation is a permission prompt rather than slowness. Read/Edit/Glob
 * finish in milliseconds; thirty seconds is three orders of magnitude of slack.
 */
export const LOCAL_TOOL_PERMISSION_MS = 30_000;

/** Grace period for a spawned command to actually appear in the process tree. */
export const SPAWN_GRACE_MS = 15_000;

/**
 * Below this a reading is an inference rather than an observation and must not
 * be drawn in the same visual language as a certain one. A red
 * WAITING_PERMISSION that turns out to be a slow build costs more trust than it
 * buys attention.
 */
export const CONFIDENT = 0.7;

/**
 * The process tree costs ~435 ms on Windows (WMI is the only way to get
 * parentage there; `Process.Parent` is unavailable on Windows PowerShell).
 * Far too expensive for a 2 s poll, and permission detection does not need
 * sub-second latency, so results are cached for this long.
 */
export const TREE_CACHE_MS = 5_000;

// ── retention ─────────────────────────────────────────────────────────────
// A daemon that runs 24/7 needs a ceiling it cannot exceed, not a hope that
// the data stays small. Counters and current state are kept forever; history
// is what ages out.

/** Transitions older than this are dropped. Ninety days of trend is plenty. */
export const RETAIN_TRANSITIONS_MS = 90 * 24 * 3600_000;

/** Sessions not seen for this long are gone; keeping their rows helps nobody. */
export const RETAIN_SESSIONS_MS = 90 * 24 * 3600_000;

/**
 * Hard cap. Above this the aggressive window runs immediately, whatever the
 * schedule says — an unbounded database on someone else's machine is a bug we
 * would only hear about after it had already cost them disk.
 */
export const DB_HARD_CAP_BYTES = 500 * 1024 * 1024;
export const RETAIN_AGGRESSIVE_MS = 7 * 24 * 3600_000;

/** How often maintenance runs. Cheap enough hourly, pointless more often. */
export const MAINTENANCE_INTERVAL_MS = 3600_000;

export function stallDeadline(tool: string | undefined, passive: boolean): number {
  let base: number;
  if (!tool) base = STALL_THINKING_MS;
  else if (tool.startsWith('mcp__')) base = STALL_MCP_MS;
  else base = STALL_MS[tool] ?? STALL_THINKING_MS;
  return passive ? base * PASSIVE_MULTIPLIER : base;
}
