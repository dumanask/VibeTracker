import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { displayNameFor } from '@vibetracker/core';
import { classifyStorage, normPath, resolveProjectIdentity } from '@vibetracker/platform';
import { readKnownProjects } from './readers.ts';
import { readPackageName } from './readers.ts';
import { allAdapters } from './agents/index.ts';
import { TailReader } from './tail.ts';

/**
 * Every project the agent has ever recorded, as identities.
 *
 * This answers a different question from `scan`. The board asks "what is
 * happening"; this asks "what could I choose to follow", and the two lists are
 * nothing like the same size: on the reference machine the session registry
 * held six projects and the transcript directory held twenty-three. A chooser
 * built from the first cannot be used to add anything you are not running at
 * that exact moment, which is almost everything.
 *
 * Nothing here reads a transcript body, samples a process, or looks at a
 * documentation tree. The cost is one `git rev-list` per directory, and the
 * caller is expected to run it once and remember the answer.
 */

export interface DiscoveredProject {
  projectId: string;
  identityKind: 'git_root' | 'package' | 'path';
  displayName: string;
  /** The path the transcript recorded, verbatim. */
  cwd: string;
  /** Newest transcript mtime — when the project was last worked in. */
  lastSeenAt: number;
  /**
   * Which agents have been used in this project, most recent first.
   *
   * Shown by the chooser because it answers what a bare path does not: a folder
   * you last opened in an editor eight months ago and one you ran Codex in
   * yesterday are indistinguishable as strings.
   */
  agents?: string[];
}

export interface DiscoverOptions {
  /**
   * Keep scratch directories. Off by default: nine of the reference machine's
   * twenty-three were `%TEMP%\fb-claude-live-…` fixtures from this project's
   * own test suite, and a chooser two-fifths full of them is a chooser nobody
   * reads to the bottom of.
   */
  includeTemp?: boolean;
  /**
   * Also ask the other agents where they have been used, by adapter id.
   * `['all']` means every installed one. Undefined asks none, which is what a
   * caller that only wants Claude Code's list gets.
   *
   * Opt-in because it costs real time — measured, ~200 ms for Codex's 231
   * rollouts plus 117 `workspace.json` reads for the editors. Fine for a chooser
   * someone opened by hand; wrong for anything on a timer.
   */
  agents?: readonly string[];
}

export async function discoverProjects(
  claudeDir: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredProject[]> {
  // One candidate list from every agent that can name a directory. Merged here
  // rather than in the chooser, because merging is exactly what the identity
  // ladder is for: Codex reports `c:\GDEV\ViberHubWebsite` and `C:\GDEV\
  // ViberHubWebsite` for the same repository — both spellings are in the real
  // data — and only `resolveProjectIdentity` can tell that they are one project.
  const candidates: Array<{ cwd: string; lastSeenAt: number; agent: string }> = (
    await readKnownProjects(claudeDir)
  ).map((k) => ({ cwd: k.cwd, lastSeenAt: k.lastSeenAt, agent: 'claude-code' }));

  if (opts.agents?.length) {
    const want = new Set(opts.agents);
    const tail = new TailReader();
    try {
      const adapters = allAdapters(() => tail).filter((a) => want.has('all') || want.has(a.id));
      const found = await Promise.all(
        adapters.map(async (a) => {
          try {
            return await a.listProjectHints();
          } catch {
            // An agent whose state we cannot read costs its own rows and
            // nothing else. A chooser that refused to open because one of nine
            // agents changed a file format would be worse than a short list.
            return [];
          }
        }),
      );
      for (const hint of found.flat()) {
        candidates.push({ cwd: hint.path, lastSeenAt: hint.lastSeenAt, agent: hint.agentKind });
      }
    } finally {
      await tail.close();
    }
  }

  const byId = new Map<string, DiscoveredProject & { seen: Map<string, number> }>();
  for (const k of candidates) {
    if (!opts.includeTemp && classifyStorage(k.cwd) === 'temp') continue;
    let ident;
    try {
      ident = await resolveProjectIdentity(k.cwd, readPackageName);
    } catch {
      continue;
    }
    const existing = byId.get(ident.projectId);
    if (existing) {
      // Same project, seen through another agent or another spelling. The agent
      // list grows; the name and path come from the most recent sighting.
      const prev = existing.seen.get(k.agent) ?? 0;
      if (k.lastSeenAt > prev) existing.seen.set(k.agent, k.lastSeenAt);
      if (k.lastSeenAt > existing.lastSeenAt) {
        existing.lastSeenAt = k.lastSeenAt;
        existing.cwd = k.cwd;
        existing.displayName = displayNameFor(ident.git?.toplevel ?? k.cwd);
      }
      continue;
    }
    byId.set(ident.projectId, {
      projectId: ident.projectId,
      identityKind: ident.identityKind,
      displayName: displayNameFor(ident.git?.toplevel ?? k.cwd),
      cwd: k.cwd,
      lastSeenAt: k.lastSeenAt,
      seen: new Map([[k.agent, k.lastSeenAt]]),
    });
  }

  return [...byId.values()]
    .map(({ seen, ...rest }) => ({
      ...rest,
      agents: [...seen].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Identify a directory the user named.
 *
 * The one way a project reaches the board without an agent ever having opened
 * it. Everything else on the list exists because a session ran, was recorded,
 * and left a `cwd` behind; a repository you want tracked *before* you point an
 * agent at it has left no trace anywhere, and no amount of reading the agent's
 * state directory will invent one.
 *
 * It stays a thing the user types or picks. Nothing here walks a disk looking
 * for candidates — that is the one discovery method the plan rules out, and
 * the reason the chooser can be honest about where its list came from.
 *
 * Returns null for anything that is not a directory, so an ordinary typo still
 * reads as "no such project" rather than as a mysterious path error.
 */
export async function identifyDirectory(
  arg: string,
): Promise<{ projectId: string; path: string; displayName: string } | null> {
  let abs: string;
  try {
    abs = await realpath(resolve(arg));
    if (!(await stat(abs)).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const ident = await resolveProjectIdentity(abs, readPackageName);
    return {
      projectId: ident.projectId,
      path: normPath(abs),
      displayName: displayNameFor(ident.git?.toplevel ?? abs),
    };
  } catch {
    return null;
  }
}
