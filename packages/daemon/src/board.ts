/**
 * The phase board: one project's whole history on a single axis.
 *
 * Two sources feed it, and they are **not** the same kind of thing:
 *
 * - **Reconstructed** — phase mentions mined from commit subjects. One point
 *   per commit that named a phase, going back as far as the log. Cheap, but
 *   coarse: it knows a phase was worked on in March, not what percentage it
 *   stood at on the 14th.
 * - **Observed** — readings this daemon computed and stored. Fine-grained,
 *   but they begin the day it was installed.
 *
 * The board keeps them apart and says which is which. Drawing them in one
 * continuous line would make the reconstruction look as precise as the
 * observation, which is the specific lie this whole project exists to avoid.
 */
import { backfillPhases, toSpans, type PhaseSpan } from '@vibetracker/engine';
import type { Store, ProgressPoint } from './store.ts';

export interface Board {
  projectId: string;
  /** Root the history was read from, for the caller's own display. */
  root: string | null;
  reconstructed: {
    spans: PhaseSpan[];
    commitsScanned: number;
    from: number | null;
    to: number | null;
    reason?: string;
  };
  observed: {
    points: ProgressPoint[];
    /** When this daemon first recorded anything for this project. */
    since: number | null;
  };
  /**
   * Where reconstruction stops and observation starts. Rendered as a visible
   * seam so nobody reads the left half as being as precise as the right.
   */
  seam: number | null;
}

/** How many recorded readings the board carries. */
const MAX_POINTS = 500;

export async function buildBoard(
  store: Store,
  projectId: string,
  root: string | null,
): Promise<Board | null> {
  const observed = store.progressHistory(projectId, MAX_POINTS);
  const since = observed.length > 0 ? observed[0]!.at : null;

  // No git root means no archaeology — and that is reported, not faked. A
  // project without git has no recoverable past, which is itself a useful
  // thing for the card to say.
  const reconstructed = root
    ? await backfillPhases(root)
    : { points: [], commitsScanned: 0, from: null, to: null, reason: 'no-git' as const };

  if (observed.length === 0 && reconstructed.points.length === 0) {
    return { projectId, root, reconstructed: { spans: [], ...strip(reconstructed) }, observed: { points: [], since: null }, seam: null };
  }

  return {
    projectId,
    root,
    reconstructed: { spans: toSpans(reconstructed.points), ...strip(reconstructed) },
    observed: { points: observed, since },
    seam: since,
  };
}

function strip(r: {
  commitsScanned: number;
  from: number | null;
  to: number | null;
  reason?: string;
}): { commitsScanned: number; from: number | null; to: number | null; reason?: string } {
  return { commitsScanned: r.commitsScanned, from: r.from, to: r.to, reason: r.reason };
}
