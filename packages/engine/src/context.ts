import type { ProcessTreeEntry, ProcessProbe } from '@vibetracker/shared';
import { TREE_CACHE_MS } from '@vibetracker/core';
import { createProcessProbe, type ProjectIdentity } from '@vibetracker/platform';
import { TailReader } from './tail.ts';
import { closeAdapters } from './agents/index.ts';
import type { ProgressReport } from './progress/scan.ts';

/**
 * Plan documents change on the timescale of days, and reading a project's
 * whole docs tree costs 140-570 ms on the reference machine. Re-deriving that
 * every three seconds would make the phase engine the most expensive thing in
 * the loop, to answer a question whose answer did not change.
 */
const PROGRESS_CACHE_MS = 300_000;

/**
 * How long git facts stay fresh. A branch, commit count and dirty count do not
 * change on the timescale of a poll loop, and `git status` on a large working
 * tree costs ~45 ms per repository.
 */
const GIT_CACHE_MS = 60_000;

/**
 * Long-lived resources shared across scans.
 *
 * This exists because of a measurement: a full scan took 2.2 s, and essentially
 * all of it was starting a fresh PowerShell probe host. The host itself answers
 * in ~15 ms once running. A one-shot CLI can afford to pay that startup; a
 * daemon polling every couple of seconds cannot, and would spend more time
 * spawning shells than observing anything.
 *
 * The process tree is cached here too: it costs ~435 ms on Windows (WMI is the
 * only source of parentage there) and permission detection does not need
 * sub-second latency.
 *
 * The transcript reader lives here for the same reason at a different scale:
 * opening a transcript costs ~310 ms under Defender regardless of file size,
 * so its descriptors must outlive a single scan.
 */
export class ScanContext {
  #probe: ProcessProbe | null = null;
  #tree: { at: number; value: Map<number, ProcessTreeEntry> | null } | null = null;
  #identity = new Map<string, { at: number; value: ProjectIdentity }>();
  #tail = new TailReader();
  #progress = new Map<string, { at: number; value: ProgressReport }>();
  #closed = false;

  /** Project progress, cached — see PROGRESS_CACHE_MS. */
  async progress(
    key: string,
    now: number,
    resolve: () => Promise<ProgressReport>,
  ): Promise<ProgressReport> {
    const hit = this.#progress.get(key);
    if (hit && now - hit.at < PROGRESS_CACHE_MS) return hit.value;
    const value = await resolve();
    this.#progress.set(key, { at: now, value });
    return value;
  }

  /** Persistent transcript reader — see TailReader for why it must persist. */
  tail(): TailReader {
    if (this.#closed) throw new Error('ScanContext is closed');
    return this.#tail;
  }

  /**
   * Project identity and git facts for a working directory, cached.
   * `key` must be the case-folded path key so two spellings share one entry.
   */
  async identity(
    key: string,
    now: number,
    resolve: () => Promise<ProjectIdentity>,
  ): Promise<ProjectIdentity> {
    const hit = this.#identity.get(key);
    if (hit && now - hit.at < GIT_CACHE_MS) return hit.value;
    const value = await resolve();
    this.#identity.set(key, { at: now, value });
    return value;
  }

  probe(): ProcessProbe {
    if (this.#closed) throw new Error('ScanContext is closed');
    // A probe that failed is replaced rather than retried forever: the host may
    // have been killed by something outside our control.
    if (this.#probe && (this.#probe as { broken?: boolean }).broken === true) {
      void this.#probe.dispose().catch(() => {});
      this.#probe = null;
    }
    this.#probe ??= createProcessProbe();
    return this.#probe;
  }

  /** Process tree, cached for TREE_CACHE_MS. Null when unavailable. */
  async tree(now: number): Promise<Map<number, ProcessTreeEntry> | null> {
    if (this.#tree && now - this.#tree.at < TREE_CACHE_MS) return this.#tree.value;
    let value: Map<number, ProcessTreeEntry> | null = null;
    try {
      value = await this.probe().listTree();
    } catch {
      value = null;
    }
    this.#tree = { at: now, value };
    return value;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const p = this.#probe;
    this.#probe = null;
    this.#tree = null;
    this.#progress.clear();
    await this.#tail.close();
    // The other agents' readers hold SQLite handles of their own. A one-shot
    // `vt status` that left them open would keep a 361 MB database mapped for
    // the life of a command that has already printed its answer.
    closeAdapters();
    if (p) await p.dispose().catch(() => {});
  }
}
