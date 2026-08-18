import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { join } from 'node:path';
import type {
  ProcessProbe,
  ProcessTreeEntry,
  ProcSnapshot,
  ProbePrecision,
} from '@vibetracker/shared';

const SCRIPT = join(import.meta.dirname, 'win-probe.ps1');
const REQUEST_TIMEOUT_MS = 8000;

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Windows probe backed by a single long-lived PowerShell host.
 *
 * Precision is `exact`: the FILETIME start time distinguishes a recycled PID
 * from the original process with certainty.
 */
export class WindowsProbe implements ProcessProbe {
  readonly kind = 'windows-powershell';
  readonly precision: ProbePrecision = 'exact';

  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #pending: Pending | null = null;
  #nextId = 1;
  #disposed = false;
  /** Set when the host proved unusable; callers should fall back. */
  broken = false;

  #start(): void {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;

    child.on('error', () => this.#fail(new Error('probe host failed to start')));
    child.on('exit', () => {
      if (!this.#disposed) this.#fail(new Error('probe host exited'));
    });
    // Drain stderr so a chatty host cannot fill the pipe and deadlock.
    child.stderr.resume();

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => this.#onLine(line));

    this.#child = child;
    this.#reader = reader;
  }

  #fail(err: Error): void {
    const p = this.#pending;
    this.#pending = null;
    this.#teardown();
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  #teardown(): void {
    try {
      this.#reader?.close();
    } catch {
      /* already closed */
    }
    try {
      this.#child?.kill();
    } catch {
      /* already gone */
    }
    this.#reader = null;
    this.#child = null;
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const p = this.#pending;
    if (!p) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // Not our frame (a stray warning). Keep waiting.
    }

    this.#pending = null;
    clearTimeout(p.timer);

    const obj = parsed as Record<string, unknown>;
    if (obj.ok !== true) {
      p.reject(new Error(typeof obj.error === 'string' ? obj.error : 'probe host error'));
      return;
    }
    p.resolve(obj);
  }

  async #request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.broken || this.#disposed) throw new Error('probe unavailable');
    if (this.#pending) throw new Error('probe is busy: requests must be serialized');
    if (!this.#child) this.#start();

    const body = JSON.stringify({ id: this.#nextId++, ...payload }) + '\n';
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          // A wedged host must never wedge the caller. Kill, mark broken, move on.
          this.#pending = null;
          this.broken = true;
          this.#teardown();
          reject(new Error('probe timeout'));
        }, REQUEST_TIMEOUT_MS);

        this.#pending = { resolve, reject, timer };
        this.#child!.stdin.write(body, (err) => {
          if (err) {
            clearTimeout(timer);
            this.#pending = null;
            reject(err);
          }
        });
      });
    } catch (err) {
      this.broken = true;
      throw err;
    }
  }

  async snapshot(pids: number[]): Promise<Map<number, ProcSnapshot>> {
    if (pids.length === 0 || this.broken || this.#disposed) return new Map();
    const obj = await this.#request({ cmd: 'procs', pids });

    // PowerShell's ConvertTo-Json collapses a one-element array to an object.
    const list = asArray(obj.procs);
    const out = new Map<number, ProcSnapshot>();
    for (const item of list) {
      const r = item as { pid?: number; startTime?: string; cpuNs?: number; rss?: number };
      if (typeof r?.pid !== 'number') continue;
      out.set(r.pid, {
        pid: r.pid,
        startTime: typeof r.startTime === 'string' ? r.startTime : '',
        startTimeKind: 'filetime',
        cpuNs: typeof r.cpuNs === 'number' ? r.cpuNs : 0,
        rss: typeof r.rss === 'number' ? r.rss : 0,
      });
    }
    return out;
  }

  async listTree(): Promise<Map<number, ProcessTreeEntry> | null> {
    if (this.broken || this.#disposed) return null;
    let obj: Record<string, unknown>;
    try {
      obj = await this.#request({ cmd: 'tree' });
    } catch {
      return null;
    }
    const out = new Map<number, ProcessTreeEntry>();
    for (const item of asArray(obj.tree)) {
      const r = item as { pid?: number; ppid?: number; startMs?: number | null };
      if (typeof r?.pid !== 'number') continue;
      out.set(r.pid, {
        pid: r.pid,
        ppid: typeof r.ppid === 'number' ? r.ppid : 0,
        startMs: typeof r.startMs === 'number' ? r.startMs : null,
      });
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    try {
      this.#child?.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {
      /* host already gone */
    }
    this.#teardown();
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
