/**
 * The hook ingest buffer.
 *
 * An HTTP hook is *blocking*: Claude Code POSTs and waits for the response
 * before continuing the turn. `async` exists only for command hooks. So the
 * request path here is the one piece of this program that can freeze someone
 * else's work, and it is written accordingly — a bounded array, one push, no
 * parsing, no database, no await, no allocation beyond the string itself.
 *
 * When the buffer is full we drop the *oldest* entry and count it. Dropping
 * events degrades the dashboard; blocking the agent degrades the user's actual
 * work. That trade is never close, and the drop counter is surfaced rather than
 * hidden so a persistently full buffer is visible instead of mysterious.
 */

export const RING_CAPACITY = 8192;

export class HookRing {
  #buf: (string | null)[];
  #head = 0;
  #count = 0;
  #received = 0;
  #dropped = 0;

  constructor(capacity = RING_CAPACITY) {
    this.#buf = new Array<string | null>(capacity).fill(null);
  }

  /** The hot path. Must stay O(1) and allocation-free. */
  push(raw: string): void {
    const cap = this.#buf.length;
    if (this.#count === cap) {
      this.#head = (this.#head + 1) % cap;
      this.#count--;
      this.#dropped++;
    }
    this.#buf[(this.#head + this.#count) % cap] = raw;
    this.#count++;
    this.#received++;
  }

  /** Take everything currently buffered. Called from the poll loop. */
  drain(): string[] {
    if (this.#count === 0) return [];
    const cap = this.#buf.length;
    const out: string[] = new Array(this.#count);
    for (let i = 0; i < this.#count; i++) {
      const idx = (this.#head + i) % cap;
      out[i] = this.#buf[idx]!;
      this.#buf[idx] = null;
    }
    this.#head = 0;
    this.#count = 0;
    return out;
  }

  get pending(): number {
    return this.#count;
  }
  get received(): number {
    return this.#received;
  }
  get dropped(): number {
    return this.#dropped;
  }
}
