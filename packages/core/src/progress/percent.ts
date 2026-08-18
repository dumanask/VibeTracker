import { ph, type Phrase } from '../phrase.ts';
import type { WorkItem } from './extract.ts';
import type { StatusKind } from './marks.ts';

/**
 * Turning items into a percentage, or refusing to.
 *
 * The refusal is the feature. A number on a dashboard is read as a
 * measurement, so producing one from four checkboxes in a design document is
 * worse than producing nothing: "—, because this file is a changelog" is
 * information, "%100" is a lie the user will act on.
 */

export interface PercentGateFailure {
  /** Machine-readable, so the UI can pick its own wording. */
  code: 'not_a_plan' | 'too_few_items' | 'nothing_unfinished' | 'ambiguous_sources';
  /** Structured, not prose — see `phrase.ts` for why. */
  detail: Phrase;
}

export interface PercentResult {
  percent: number | null;
  doneWeight: number;
  totalWeight: number;
  counts: Record<StatusKind, number>;
  suppressed?: PercentGateFailure;
}

/**
 * A denominator smaller than this is noise. Eight is deliberately awkward: it
 * is large enough that a stray checklist in a README cannot produce a
 * project-level number, small enough that a genuine eight-task plan still
 * reports.
 */
export const MIN_DENOMINATOR = 8;

/** Partially-done work counts as half. Anything finer is false precision. */
const PARTIAL_CREDIT = 0.5;

export interface PercentInput {
  items: WorkItem[];
  /** False when the source document is not a plan. */
  countable: boolean;
  roleLabel: string;
}

export function computePercent(input: PercentInput): PercentResult {
  const counts: Record<StatusKind, number> = {
    done: 0,
    partial: 0,
    todo: 0,
    blocked: 0,
    dropped: 0,
  };
  let doneWeight = 0;
  let totalWeight = 0;

  for (const it of input.items) {
    counts[it.status]++;
    // Dropped work leaves both sides of the fraction: it was descoped, not
    // finished, and leaving it in the denominator would cap the project below
    // 100% forever.
    if (it.status === 'dropped') continue;
    totalWeight += it.weight;
    if (it.status === 'done') doneWeight += it.weight;
    else if (it.status === 'partial') doneWeight += it.weight * PARTIAL_CREDIT;
  }

  const base = { doneWeight, totalWeight, counts };

  if (!input.countable) {
    return {
      ...base,
      percent: null,
      suppressed: {
        code: 'not_a_plan',
        detail: ph('kaynak bir plan değil ({0})', input.roleLabel),
      },
    };
  }
  if (totalWeight < MIN_DENOMINATOR) {
    return {
      ...base,
      percent: null,
      suppressed: {
        code: 'too_few_items',
        detail: ph('sayılabilir madde {0} < {1}', totalWeight, MIN_DENOMINATOR),
      },
    };
  }
  const unfinished = counts.todo + counts.partial + counts.blocked;
  if (unfinished === 0) {
    return {
      ...base,
      percent: null,
      suppressed: {
        code: 'nothing_unfinished',
        detail: ph(
          '{0} maddenin tamamı işaretli, bitmemiş madde yok — bu bir kayıt belgesi',
          counts.done,
        ),
      },
    };
  }

  return { ...base, percent: Math.round((doneWeight / totalWeight) * 100) };
}

/**
 * Round an inferred percentage to a coarse bucket.
 *
 * Applied to anything not counted from explicit items. `%62` invites the
 * reader to believe two significant figures; `~%60` tells the truth about how
 * much the number knows.
 */
export function coarsen(percent: number): number {
  return Math.round(percent / 10) * 10;
}
