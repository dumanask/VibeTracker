import type {
  ProcessProbe,
  ProcessTreeEntry,
  ProcSnapshot,
  ProbePrecision,
} from '@vibetracker/shared';

/**
 * Floor implementation: can only answer "does this PID exist".
 *
 * Used on unknown platforms and whenever a primary probe proves unusable. It
 * is a *tested tier*, not an error path — the dashboard must stay useful with
 * it, while clearly reporting that PID-reuse detection and the
 * thinking-vs-hung discriminator are unavailable.
 */
export class DegradedProbe implements ProcessProbe {
  readonly kind = 'degraded-kill0';
  readonly precision: ProbePrecision = 'none';
  broken = false;

  async snapshot(pids: number[]): Promise<Map<number, ProcSnapshot>> {
    const out = new Map<number, ProcSnapshot>();
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        out.set(pid, { pid, startTime: '', startTimeKind: 'none', cpuNs: 0, rss: 0 });
      } catch (err) {
        // EPERM means the process exists but belongs to another user.
        if ((err as NodeJS.ErrnoException).code === 'EPERM') {
          out.set(pid, { pid, startTime: '', startTimeKind: 'none', cpuNs: 0, rss: 0 });
        }
      }
    }
    return out;
  }

  /** No portable way to enumerate parentage here; callers degrade gracefully. */
  async listTree(): Promise<Map<number, ProcessTreeEntry> | null> {
    return null;
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}
