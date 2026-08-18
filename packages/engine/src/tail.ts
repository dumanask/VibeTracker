import { open, type FileHandle } from 'node:fs/promises';
import type { TranscriptFacts } from '@vibetracker/shared';
import { dialectFor, knownEntryTypes, redactSnippet } from '@vibetracker/core';

/**
 * Bounded, incremental transcript reader.
 *
 * Two non-negotiable rules, enforced by this being the only reader in the
 * codebase:
 *
 * 1. A transcript is NEVER read in full. The largest observed on the reference
 *    machine is 518 MB (a Codex rollout reached 778 MB), and a single directory
 *    held 1.73 GB across 1,884 files.
 * 2. A file that has not grown is not read at all — only `fstat`ed.
 *
 * Rule 2 is where the daemon's cost lives. Measured on that 518 MB file:
 * open + seek + read 256 KB took 319 ms cold and 307 ms warm — identical.
 * That is not a page-cache miss, it is antivirus scanning at `CreateFile`.
 * The cost is in *opening the handle*, not in reading, so a poll loop that
 * reopens every transcript every few seconds pays ~310 ms per live session
 * forever. Holding the descriptor open turns each subsequent poll into an
 * `fstat` (~0.1 ms) plus, at most, a read of the bytes that were actually
 * appended — typically a few KB.
 *
 * The incremental path also makes tool pairing *better* than the windowed one:
 * a `tool_use` first seen in poll N is still remembered in poll N+40, even
 * after it has scrolled out of any fixed-size window.
 */

/**
 * Entry types we understand, from `dialects/claude-code.json`.
 *
 * Read once: the shapes are data so they can be patched without a release,
 * but they do not change while the process runs, and this set is consulted on
 * every line of a 500 MB file.
 */
const KNOWN_TYPES = knownEntryTypes(dialectFor('claude-code'));

export interface TailOptions {
  /** Bytes to read from the end on first sight of a file. */
  tailBytes?: number;
  /** Bytes to read from the start (session origin facts). 0 disables. */
  headBytes?: number;
  /**
   * How to turn lines into facts. Defaults to the Claude Code reader.
   *
   * Parameterised so other agents' JSONL can share this machinery rather than
   * copy it. What is being shared is not the parsing — every agent's records
   * are different — but the *discipline* around it: a persistent descriptor per
   * file, `fstat` before reading, an 8 MB catch-up limit that records an honest
   * gap instead of stalling the poll, a partial trailing line carried to the
   * next read, and never decoding past a newline so a slice cannot land
   * mid-UTF-8. Codex rollout files reach 778 MB. A second implementation of
   * this would be a second set of these bugs.
   */
  apply?: LineApplier;
}

/**
 * A line reader: given the accumulating facts and a batch of complete lines,
 * fold the lines in.
 *
 * `openTools` is a map rather than the array in `TranscriptFacts` because tool
 * calls are matched to their results by id across reads, and the array is only
 * the rendered view of what is still unmatched.
 */
export type LineApplier = (target: TailTarget, lines: string[]) => void;

export interface TailTarget {
  facts: TranscriptFacts;
  /** Tool call id -> tool name, for calls with no result yet. */
  openTools: Map<string, string>;
}

/**
 * A 256 KB tail can contain very few records: on the 518 MB reference file it
 * held 49 lines, and the final line was an 82-byte `mode` entry carrying no
 * timestamp at all. The first window therefore has to be generous enough to
 * reach back past the trailing metadata to a real message.
 */
const DEFAULT_TAIL = 256 * 1024;
const DEFAULT_HEAD = 64 * 1024;

/**
 * If a file grew by more than this while we were not looking (daemon asleep,
 * machine suspended), we do not read the whole gap — we skip to the last
 * CATCHUP_TAIL bytes and record that we lost events. An honest gap beats a
 * multi-second stall in the poll loop.
 */
const CATCHUP_LIMIT = 8 * 1024 * 1024;
const CATCHUP_TAIL = 1024 * 1024;

/**
 * A trailing fragment with no newline is an in-flight write, so we wait for it.
 * But waiting forever on a pathological single line would stall that session's
 * facts permanently, so past this size we give up on it and skip ahead.
 */
const MAX_PENDING = 2 * 1024 * 1024;

/**
 * Open descriptors are a real resource: Windows handles, inotify-free but still
 * per-process fd table entries. 64 covers every plausible number of *hot*
 * sessions (reference machine peak: 13 live) with room to spare.
 */
const FD_BUDGET = 64;

/** Entries whose files are gone or cold still cost a Map slot; bound that too. */
const MAX_TRACKED = 512;

interface Entry extends TailTarget {
  path: string;
  handle: FileHandle | null;
  /** Byte offset just past the last newline we have consumed. */
  consumed: number;
  /** How this file's lines are folded in. Fixed at first sight. */
  apply: LineApplier;
  /** False until the first (windowed) read has happened. */
  primed: boolean;
  headDone: boolean;
  /** Times we skipped forward and lost entries. */
  gaps: number;
  lastUsed: number;
}

export interface TailStats {
  tracked: number;
  openHandles: number;
  opens: number;
  reads: number;
  /** Polls where `fstat` proved nothing had been appended — the common case. */
  skipped: number;
  bytesRead: number;
  gaps: number;
}

export class TailReader {
  #entries = new Map<string, Entry>();
  #openCount = 0;
  #clock = 0;
  #stats = { opens: 0, reads: 0, skipped: 0, bytesRead: 0, gaps: 0 };

  stats(): TailStats {
    return {
      tracked: this.#entries.size,
      openHandles: this.#openCount,
      ...this.#stats,
    };
  }

  /**
   * Facts for one transcript, as of now.
   *
   * Returns a snapshot — the caller may keep it; the reader keeps mutating its
   * own copy.
   */
  async read(path: string, opts: TailOptions = {}): Promise<TranscriptFacts | null> {
    const tailBytes = opts.tailBytes ?? DEFAULT_TAIL;
    const headBytes = opts.headBytes ?? DEFAULT_HEAD;

    let entry = this.#entries.get(path);
    if (!entry) {
      entry = newEntry(path, opts.apply ?? applyLines);
      this.#entries.set(path, entry);
      if (this.#entries.size > MAX_TRACKED) await this.#trim();
    }
    entry.lastUsed = ++this.#clock;

    const handle = await this.#ensureOpen(entry);
    if (!handle) {
      this.#entries.delete(path);
      return null;
    }

    let st;
    try {
      st = await handle.stat();
    } catch {
      await this.#drop(entry);
      return null;
    }

    entry.facts.size = st.size;
    entry.facts.mtimeMs = st.mtimeMs;

    if (st.size === 0) {
      entry.consumed = 0;
      return snapshot(entry);
    }

    // The file shrank: a compaction rewrote it, so our offset points into
    // unrelated bytes and everything we derived from the old content is stale.
    if (st.size < entry.consumed) reset(entry);

    if (!entry.primed) {
      const start = Math.max(0, st.size - tailBytes);
      await this.#ingest(entry, handle, start, st.size, start > 0);
      entry.primed = true;
      if (!entry.headDone && headBytes > 0 && start > headBytes) {
        await this.#readHead(entry, handle, headBytes);
      }
    } else if (st.size > entry.consumed) {
      let from = entry.consumed;
      let dropPartial = false;
      if (st.size - from > CATCHUP_LIMIT) {
        from = st.size - CATCHUP_TAIL;
        dropPartial = true;
        entry.gaps++;
        this.#stats.gaps++;
      }
      await this.#ingest(entry, handle, from, st.size, dropPartial);
    } else {
      // Nothing appended. This is the whole point of the class.
      this.#stats.skipped++;
    }

    return snapshot(entry);
  }

  /**
   * Release everything not in `keep`. Sessions end; their descriptors should
   * not outlive them just because the process is still alive.
   */
  async retain(keep: ReadonlySet<string>): Promise<void> {
    const doomed = [...this.#entries.values()].filter((e) => !keep.has(e.path));
    for (const e of doomed) await this.#drop(e);
  }

  async close(): Promise<void> {
    const all = [...this.#entries.values()];
    this.#entries.clear();
    for (const e of all) await closeHandle(e);
    this.#openCount = 0;
  }

  async #ensureOpen(entry: Entry): Promise<FileHandle | null> {
    if (entry.handle) return entry.handle;
    try {
      // Read-only. Node's default share mode permits the agent to keep
      // appending while we hold this open — verified against a 518 MB file
      // being actively written.
      entry.handle = await open(entry.path, 'r');
    } catch {
      return null;
    }
    this.#openCount++;
    this.#stats.opens++;
    if (this.#openCount > FD_BUDGET) await this.#evict(entry);
    return entry.handle;
  }

  /** Close the least recently used handles until we are back under budget. */
  async #evict(protect: Entry): Promise<void> {
    const candidates = [...this.#entries.values()]
      .filter((e) => e.handle !== null && e !== protect)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of candidates) {
      if (this.#openCount <= FD_BUDGET) break;
      // The offset survives: on next use we reopen and resume from `consumed`.
      await closeHandle(e);
      this.#openCount--;
    }
  }

  /** Forget the coldest tracked entries entirely. */
  async #trim(): Promise<void> {
    const cold = [...this.#entries.values()]
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, this.#entries.size - MAX_TRACKED);
    for (const e of cold) await this.#drop(e);
  }

  async #drop(entry: Entry): Promise<void> {
    this.#entries.delete(entry.path);
    if (entry.handle) {
      await closeHandle(entry);
      this.#openCount--;
    }
  }

  /**
   * Read `[from, to)` and apply every complete line in it.
   *
   * `dropFirstPartial` must be true whenever `from` is not a known line
   * boundary — the start of a byte window almost always lands mid-line.
   */
  async #ingest(
    entry: Entry,
    handle: FileHandle,
    from: number,
    to: number,
    dropFirstPartial: boolean,
  ): Promise<void> {
    const length = to - from;
    if (length <= 0) return;

    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, from);
    this.#stats.reads++;
    this.#stats.bytesRead += bytesRead;
    const raw = buf.subarray(0, bytesRead);

    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // No complete line here. Normally we wait for the writer to finish, but a
      // fragment this large is not going to terminate on our timescale.
      if (length > MAX_PENDING) {
        entry.consumed = from + bytesRead;
        entry.gaps++;
        this.#stats.gaps++;
      }
      return;
    }

    // Decode only through the last newline. The remainder is a partial write
    // and may end mid-UTF-8-sequence; slicing at a newline guarantees the
    // decoded text ends on a character boundary.
    const text = raw.subarray(0, lastNewline + 1).toString('utf8');
    entry.consumed = from + lastNewline + 1;

    let lines = text.split('\n');
    if (dropFirstPartial) lines = lines.slice(1);
    entry.apply(entry, lines);
  }

  /** Origin facts from the first bytes of the file. Done once per file. */
  async #readHead(entry: Entry, handle: FileHandle, headBytes: number): Promise<void> {
    const buf = Buffer.allocUnsafe(headBytes);
    const { bytesRead } = await handle.read(buf, 0, headBytes, 0);
    this.#stats.reads++;
    this.#stats.bytesRead += bytesRead;
    entry.headDone = true;

    const raw = buf.subarray(0, bytesRead);
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const lines = raw.subarray(0, lastNewline + 1).toString('utf8').split('\n');
    // The head is for origin facts only; it must never overwrite newer values.
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as Record<string, unknown>;
        if (!entry.facts.gitBranch && typeof e.gitBranch === 'string') {
          entry.facts.gitBranch = e.gitBranch;
        }
      } catch {
        /* head parse failures are not interesting */
      }
    }
  }
}

function newEntry(path: string, apply: LineApplier): Entry {
  return {
    path,
    handle: null,
    apply,
    facts: {
      path,
      size: 0,
      mtimeMs: 0,
      openTools: [],
      unknownTypes: [],
      linesParsed: 0,
      parseFailures: 0,
    },
    consumed: 0,
    openTools: new Map(),
    primed: false,
    headDone: false,
    gaps: 0,
    lastUsed: 0,
  };
}

/** Everything derived from the old bytes is void; keep only identity. */
function reset(entry: Entry): void {
  const { path, size, mtimeMs } = entry.facts;
  entry.facts = {
    path,
    size,
    mtimeMs,
    openTools: [],
    unknownTypes: [],
    linesParsed: 0,
    parseFailures: 0,
  };
  entry.consumed = 0;
  entry.openTools.clear();
  entry.primed = false;
}

function snapshot(entry: Entry): TranscriptFacts {
  return { ...entry.facts, openTools: [...entry.openTools.values()] };
}

async function closeHandle(entry: Entry): Promise<void> {
  const h = entry.handle;
  entry.handle = null;
  if (h) await h.close().catch(() => {});
}

const applyLines: LineApplier = (entry, lines) => {
  const facts = entry.facts;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      facts.parseFailures++;
      continue;
    }
    facts.linesParsed++;

    const type = typeof e.type === 'string' ? e.type : '';
    if (type && !KNOWN_TYPES.has(type) && !facts.unknownTypes.includes(type)) {
      facts.unknownTypes.push(type);
    }

    switch (type) {
      // Both of these are free text the agent wrote, and `last-prompt` is
      // literally what the user typed. Redacted here, at the one place it
      // enters the process, rather than at each of the surfaces that show it:
      // three renderers draw this string and a fourth will, and the one that
      // forgets is the one that puts an API key on a window pinned above
      // everything else.
      case 'ai-title':
        // Multiple ai-title records can appear in one session; last wins.
        if (typeof e.aiTitle === 'string') facts.aiTitle = redactSnippet(e.aiTitle, 140);
        continue;
      case 'last-prompt':
        if (typeof e.lastPrompt === 'string') facts.lastPrompt = redactSnippet(e.lastPrompt, 140);
        continue;
      case 'user':
      case 'assistant':
        break;
      default:
        continue; // mode / queue-operation / attachment / file-history / system
    }

    if (typeof e.gitBranch === 'string') facts.gitBranch = e.gitBranch;

    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts) && (facts.lastEntryAt === undefined || ts > facts.lastEntryAt)) {
      facts.lastEntryAt = ts;
      facts.lastEntryRole = type === 'user' ? 'user' : 'assistant';
    }

    // Sidechain entries belong to subagents; they must not be read as the main
    // conversation's position.
    if (e.isSidechain === true) continue;

    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; id?: string; name?: string; tool_use_id?: string };
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        entry.openTools.set(b.id, typeof b.name === 'string' ? b.name : 'unknown');
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        entry.openTools.delete(b.tool_use_id);
      }
    }
  }
};

/**
 * One-shot convenience for callers with no reader to reuse. Pays the full
 * open cost every time, which is exactly what `TailReader` exists to avoid —
 * use it only outside a poll loop.
 */
export async function readTranscriptFacts(
  path: string,
  opts: TailOptions = {},
): Promise<TranscriptFacts | null> {
  const reader = new TailReader();
  try {
    return await reader.read(path, opts);
  } finally {
    await reader.close();
  }
}
