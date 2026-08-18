/**
 * Which projects the user follows.
 *
 * The rule is one mode and one list. `all` shows everything; `selected` shows
 * exactly what is in the list. Removing a project while in `all` mode is
 * therefore expressed as "select all the others" — the same decision said in
 * one vocabulary, rather than a second `hidden` list that can contradict the
 * first the moment a name appears in both.
 */
import type { TrackingConfig } from './config.ts';
import { fold } from './progress/fold.ts';

export interface TrackableProject {
  projectId: string;
  displayName: string;
}

/** Does the current setting follow this project? */
export function isTracked(tracking: TrackingConfig, projectId: string): boolean {
  if (tracking.mode === 'all') return true;
  return tracking.selected.includes(projectId);
}

export type MatchResult =
  | { kind: 'one'; project: TrackableProject }
  | { kind: 'none' }
  | { kind: 'many'; candidates: TrackableProject[] };

/**
 * Resolve what someone typed to a project.
 *
 * Ids are exact — they are machine-readable and a near miss is a typo, not a
 * guess to be resolved. Names are matched through the same locale-safe fold
 * the rest of the product uses, so `masaustu` finds `Masaüstü` and Turkish
 * dotted-I does not silently fail to match.
 *
 * An ambiguous name is never resolved by picking the first: two projects can
 * legitimately share a display name (§C.4 measured exactly that), and quietly
 * tracking the wrong one is worse than asking.
 */
export function matchProject(input: string, projects: TrackableProject[]): MatchResult {
  const raw = input.trim();
  if (raw === '') return { kind: 'none' };

  const byId = projects.filter((p) => p.projectId === raw);
  if (byId.length === 1 && byId[0]) return { kind: 'one', project: byId[0] };

  const needle = fold(raw);
  const exact = projects.filter((p) => fold(p.displayName) === needle);
  if (exact.length === 1 && exact[0]) return { kind: 'one', project: exact[0] };
  if (exact.length > 1) return { kind: 'many', candidates: exact };

  // A prefix is offered only as a convenience, and only when it is unique.
  const prefix = projects.filter((p) => fold(p.displayName).startsWith(needle));
  if (prefix.length === 1 && prefix[0]) return { kind: 'one', project: prefix[0] };
  if (prefix.length > 1) return { kind: 'many', candidates: prefix };

  return { kind: 'none' };
}

export interface TrackingChange {
  next: TrackingConfig;
  /** Ids added to the selection by this operation. */
  added: string[];
  /** Ids dropped from the selection by this operation. */
  removed: string[];
  /** True when the operation also switched away from following everything. */
  switchedToSelected: boolean;
}

/**
 * Add projects to the selection.
 *
 * Coming from `all`, this necessarily narrows the view — there is no way to
 * "add" to everything. The caller is told via `switchedToSelected` so it can
 * say so out loud instead of leaving the user wondering where the rest went.
 */
export function addTracked(tracking: TrackingConfig, ids: string[]): TrackingChange {
  const wasAll = tracking.mode === 'all';
  // Coming from `all`, the projects already on screen are not part of a
  // choice the user made; only what they name now is.
  const base = wasAll ? [] : [...tracking.selected];
  const added: string[] = [];
  for (const id of ids) {
    if (!base.includes(id)) {
      base.push(id);
      added.push(id);
    }
  }
  return {
    next: { mode: 'selected', selected: base },
    added,
    removed: [],
    switchedToSelected: wasAll,
  };
}

/**
 * Remove projects from the selection.
 *
 * From `all`, "remove one" means "keep the others", so the currently visible
 * projects become the selection minus the named ones. That is why this needs
 * to know what is on screen: without it, the first removal would produce an
 * empty selection and hide everything.
 */
export function removeTracked(
  tracking: TrackingConfig,
  ids: string[],
  visible: TrackableProject[],
): TrackingChange {
  const wasAll = tracking.mode === 'all';
  const base = wasAll ? visible.map((p) => p.projectId) : [...tracking.selected];
  const removed = base.filter((id) => ids.includes(id));
  return {
    next: { mode: 'selected', selected: base.filter((id) => !ids.includes(id)) },
    added: [],
    removed,
    switchedToSelected: wasAll,
  };
}

export function trackAll(): TrackingConfig {
  return { mode: 'all', selected: [] };
}
