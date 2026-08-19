import {
  SessionState,
  type ProjectView,
  type SessionStateName,
  type WorkspaceInfo,
} from '@vibetracker/shared';
import { normPath } from './path-lite.ts';

export function displayNameFor(p: string): string {
  const parts = normPath(p).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * When one project lives at several paths, label each by the first path segment
 * that differs, so the UI never shows two identical names for what the user
 * experiences as two different checkouts.
 */
export function labelWorkspaces(list: WorkspaceInfo[]): void {
  if (list.length < 2) return;
  const split = list.map((w) => w.normPath.split('/').filter(Boolean));
  for (let i = 0; i < list.length; i++) {
    const mine = split[i]!;
    let label = mine[mine.length - 1] ?? '';
    for (let depth = 0; depth < mine.length; depth++) {
      const seg = mine[depth];
      if (split.every((o, j) => j === i || o[depth] !== seg)) {
        label = seg ?? label;
        break;
      }
    }
    list[i]!.label = label;
  }
}

/**
 * Flags are identifiers, not prose. `attentionScore` and the dashboard both
 * match on them (`f.startsWith('dirty-flood')`), so translating them here would
 * silently break risk scoring in every language but English. They are
 * translated where they are *displayed*, and nowhere else.
 */
export function projectFlags(p: ProjectView): string[] {
  const flags: string[] = [];
  if (p.identityKind !== 'git_root') flags.push('no-git');

  for (const w of p.workspaces) {
    if ((w.dirtyCount ?? 0) > 200) {
      // A repo with 500 dirty paths under `target/` is not busy, it is missing a
      // gitignore. Treating that as heat would pin it to the top of the
      // attention list forever.
      flags.push(w.dirtyIsBuildNoise ? 'build-noise' : `dirty-flood(${w.dirtyCount})`);
    }
    if (w.isWorktree) flags.push('worktree');
    if (w.storageKind === 'cloud') flags.push('cloud-sync');
    if (w.storageKind === 'wsl') flags.push('wsl');
  }

  if (p.workspaces.length > 1) {
    flags.push(`duplicate-path(${p.workspaces.length})`);
    const branches = new Set(p.workspaces.map((w) => w.branch ?? '?'));
    if (branches.size > 1) flags.push('diverged');
  }
  return [...new Set(flags)];
}

export function urgencyOf(state: SessionStateName): number {
  if (state === SessionState.WaitingPermission) return 3;
  if (state === SessionState.Stalled || state === SessionState.Errored) return 2;
  if (state === SessionState.WaitingInput) return 1;
  return 0;
}

/**
 * "Where should I look first" — not "what is the status of my projects".
 * Those are different sorts, and this is the one the top of the screen answers.
 *
 * Momentum and drift terms arrive with the phase engine; until then this is the
 * live + waiting + risk subset.
 */
export function attentionScore(p: ProjectView): number {
  const anyLive = p.sessions.some((s) => s.liveness === 'live');
  const maxUrgency = Math.max(0, ...p.sessions.map((s) => urgencyOf(s.state)));
  const risk = p.flags.filter(
    (f) => f.startsWith('dirty-flood') || f === 'no-git' || f === 'diverged',
  ).length;
  const oldestWait = Math.max(
    0,
    ...p.sessions
      .filter((s) => urgencyOf(s.state) > 0 && s.lastActivityAt)
      .map((s) => (Date.now() - (s.lastActivityAt ?? 0)) / 60_000),
  );
  return (
    (anyLive ? 2.6 : 0) +
    maxUrgency * 1.7 +
    Math.min(oldestWait / 10, 3) * 0.6 +
    risk * 1.5 +
    p.sessions.length * 0.05
  );
}
