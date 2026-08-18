/**
 * Recent activity per project, as a short series the surfaces can draw.
 *
 * The counts on a row answer "what is happening now"; they cannot answer "has
 * this project been busy or has it been sitting there". A twenty-four minute
 * trace answers that in a shape the eye reads without counting, which is the
 * only reason to spend pixels on it.
 *
 * Three decisions worth stating:
 *
 * - **Only the daemon can produce it.** A one-shot `vt status` has no past, so
 *   the field is absent there rather than zero-filled. Absent and flat are
 *   different claims and are drawn differently.
 * - **A minute nobody observed is not a quiet minute.** Buckets before the
 *   first sample — a project that only just appeared, or a daemon that just
 *   started — come back as `-1`, and renderers leave that stretch empty rather
 *   than drawing a floor the project never sat on.
 * - **Memory only.** This describes the last half hour; persisting it would
 *   mean a schema, a retention rule and a migration for something whose whole
 *   value expires while you look away.
 */

/** One bar per minute. */
const BUCKET_MS = 60_000;

/** How many minutes the trace covers. */
export const MOMENTUM_BUCKETS = 24;

/** Buckets kept per project before the oldest is dropped. */
const KEEP = MOMENTUM_BUCKETS * 2;

/** A project not sampled for this long is forgotten entirely. */
const FORGET_MS = 2 * 3600_000;

interface Bucket {
  bucket: number;
  value: number;
}

export class Momentum {
  #series = new Map<string, Bucket[]>();

  /**
   * Record what this project had engaged at `now`.
   *
   * The maximum within the minute, not the last sample or the mean: a scan
   * every three seconds would otherwise let a burst that filled half a minute
   * vanish because it ended before the tick that closed the bucket.
   */
  sample(projectId: string, engaged: number, now: number): void {
    const bucket = Math.floor(now / BUCKET_MS);
    let s = this.#series.get(projectId);
    if (!s) {
      s = [];
      this.#series.set(projectId, s);
    }
    const last = s[s.length - 1];
    if (last && last.bucket === bucket) last.value = Math.max(last.value, engaged);
    else s.push({ bucket, value: engaged });
    while (s.length > KEEP) s.shift();
  }

  /**
   * The last {@link MOMENTUM_BUCKETS} minutes, oldest first.
   *
   * `-1` marks a minute before this project was first seen. Undefined means
   * nothing has been sampled at all, which is what `vt status` reports.
   */
  series(projectId: string, now: number): number[] | undefined {
    const s = this.#series.get(projectId);
    if (!s || s.length === 0) return undefined;
    const end = Math.floor(now / BUCKET_MS);
    const first = s[0]!.bucket;
    const out: number[] = [];
    for (let b = end - MOMENTUM_BUCKETS + 1; b <= end; b++) {
      if (b < first) {
        out.push(-1);
        continue;
      }
      const hit = s.find((x) => x.bucket === b);
      // Inside the observed span a missing bucket is a minute we watched and
      // saw nothing in — the daemon samples every project on every tick.
      out.push(hit ? hit.value : 0);
    }
    return out;
  }

  /** Drop projects nothing has reported for a while. */
  prune(now: number): void {
    const cutoff = Math.floor((now - FORGET_MS) / BUCKET_MS);
    for (const [id, s] of this.#series) {
      const last = s[s.length - 1];
      if (!last || last.bucket < cutoff) this.#series.delete(id);
    }
  }

  get size(): number {
    return this.#series.size;
  }
}
