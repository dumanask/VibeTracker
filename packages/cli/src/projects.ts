/**
 * `vt projects` — choose which projects the tracker is for.
 *
 * Watching everything is the right default and the wrong steady state: a
 * machine that has run agents for a month accumulates experiments, scratch
 * clones and one-afternoon ideas, and a board showing all of them is a board
 * nobody reads.
 *
 * Two rules shape this command. Every change prints what it did — including
 * the switch from "everything" to "only these", which is a side effect big
 * enough that inferring it silently would be a trap. And nothing is ever
 * matched by guessing: an ambiguous name is reported with its candidates
 * rather than resolved to whichever came first.
 */
import { readFile } from 'node:fs/promises';
import { configPath, writeConfig, loadConfig } from '@vibetracker/platform';
import { ScanContext, scan, discoverProjects, identifyDirectory } from '@vibetracker/engine';
import { claudeDir } from '@vibetracker/platform';
import {
  addTracked,
  isTracked,
  matchProject,
  removeTracked,
  configuredRoots,
  setTomlValues,
  summarizeAgents,
  t,
  trackAll,
  tr,
  type TrackableProject,
  type TrackingChange,
  type TrackingConfig,
} from '@vibetracker/core';
import type { ProjectView } from '@vibetracker/shared';

const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = wrap('2');
const bold = wrap('1');
const cyan = wrap('36');
const green = wrap('32');

export interface ProjectsArgs {
  /** `list` (default), `add`, `rm`, `all`. */
  sub?: string;
  names: string[];
  json: boolean;
}

/**
 * Discover what there is to choose from.
 *
 * Two sources, because they answer different questions. The scan says what is
 * *happening* — which projects have agents, and what those agents are doing.
 * `discoverProjects` says what *exists*, recovered from the agent's transcript
 * directory, and that list is several times longer: six projects had a session
 * registry entry on the reference machine while twenty-three had transcripts.
 * Offering only the first meant you could add a project exactly while you were
 * running it, and never afterwards.
 *
 * Tracking is switched off for both — you cannot pick from a list already
 * filtered by the choice you are trying to change.
 */
async function discover(): Promise<ProjectView[]> {
  const ctx = new ScanContext();
  try {
    const [report, known] = await Promise.all([
      scan(
        {
          cpuSample: false,
          cpuSampleMs: 0,
          includeDead: true,
          includeTemp: false,
          tailBytes: 32 * 1024,
          progress: false,
          extraRoots: configuredRoots((await loadConfig()).config),
        },
        ctx,
      ),
      // The chooser is opened by hand, so it can afford to ask every agent
      // where it has been used. Without this a project you only ever ran Codex
      // in would be impossible to add except by typing its path.
      discoverProjects(claudeDir(), { agents: ['all'] }).catch(() => []),
    ]);

    const out = [...report.projects];
    const seen = new Set(out.map((p) => p.projectId));
    for (const k of known) {
      if (seen.has(k.projectId)) continue;
      // A project with no session at all still has an identity and a name,
      // and that is everything the chooser needs. It carries no sessions
      // because there genuinely are none — `activity` says "oturum yok".
      out.push({
        projectId: k.projectId,
        identityKind: k.identityKind,
        displayName: k.displayName,
        workspaces: [],
        sessions: [],
        flags: [],
        tracked: false,
        summary: { kind: 'none', waiting: 0, running: 0, live: 0, total: 0, urgency: 0 },
      });
    }
    return out;
  } finally {
    await ctx.close();
  }
}

/** Record where a hand-named project lives, leaving the rest of its table alone. */
async function rememberRoot(projectId: string, path: string): Promise<void> {
  const file = configPath();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    text = '';
  }
  await writeConfig(setTomlValues(text, `projects."${projectId}"`, { path }), file);
}

async function persist(next: TrackingConfig): Promise<void> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // No config yet is the normal state before `vt init`. Writing just this
    // one table is better than materialising a full template the user never
    // asked for and would then have to read.
    text = '';
  }
  await writeConfig(
    setTomlValues(text, 'tracking', { mode: next.mode, selected: next.selected }),
    path,
  );
}

function line(p: TrackableProject, tracked: boolean, extra: string): string {
  const mark = tracked ? green('●') : dim('○');
  // Pad the plain text, then colour it: escape codes have no width on screen
  // but plenty in `padEnd`, and mixing the two is what makes a column wander.
  const padded = p.displayName.padEnd(26);
  return `  ${mark} ${tracked ? bold(padded) : dim(padded)}  ${dim(extra)}`;
}

/**
 * One line summarising what a project's sessions are doing.
 *
 * Reads the engine's summary rather than counting states again. The count it
 * used to do here was subtly its own — it excluded `ORPHANED` and `ENDED` but
 * not `UNKNOWN` — so the picker could disagree with the list you were about
 * to add the project to, about the project you were looking at.
 */
function activity(p: ProjectView): string {
  const a = p.summary ?? summarizeAgents(p);
  if (a.total === 0) return tr('no sessions');
  const bits: string[] = [];
  if (a.waiting > 0) bits.push(t`${a.waiting} waiting`);
  if (a.running > 0) bits.push(t`${a.running} running`);
  if (bits.length === 0) bits.push(a.live > 0 ? t`${a.live} live agents` : tr('off'));
  return bits.join(' · ');
}

export async function runProjects(args: ProjectsArgs): Promise<number> {
  const sub = args.sub ?? 'list';
  if (!['list', 'add', 'rm', 'remove', 'all'].includes(sub)) {
    process.stderr.write(
      t`Unknown subcommand: ${sub}\nUsage: vt projects [list|add <project…>|rm <project…>|all]\n`,
    );
    return 64;
  }

  const loaded = await loadConfig();
  const tracking = loaded.config.tracking;
  const projects = await discover();
  const trackables: TrackableProject[] = projects.map((p) => ({
    projectId: p.projectId,
    displayName: p.displayName,
  }));

  if (sub === 'list') {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: tracking.mode,
            selected: tracking.selected,
            projects: projects.map((p) => ({
              projectId: p.projectId,
              displayName: p.displayName,
              tracked: isTracked(tracking, p.projectId),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    process.stdout.write(
      '\n' +
        (tracking.mode === 'all'
          ? tr('Every project is being tracked.\n')
          : t`Tracking the ${tracking.selected.length} projects you chose.\n`),
    );
    process.stdout.write('\n');
    // Tracked comes from the config, not from the scan: `discover()`
    // deliberately runs unfiltered so there is something to choose from.
    for (const p of projects) {
      const on = isTracked(tracking, p.projectId);
      process.stdout.write(`${line(p, on, `${activity(p)} · ${p.projectId}`)}\n`);
    }

    // A selected id that matches nothing on this machine is worth saying out
    // loud: it is usually a project that moved, was deleted, or a typo, and it
    // would otherwise just be silently absent from the board forever.
    const known = new Set(trackables.map((p) => p.projectId));
    const ghosts = tracking.selected.filter((id) => !known.has(id));
    for (const id of ghosts) {
      process.stdout.write(`  ${dim('○')} ${dim(id)}  ${dim(tr('selected but not visible right now'))}\n`);
    }

    process.stdout.write(
      '\n' +
        dim(tr('  vt projects add <project>   start tracking it\n')) +
        dim(tr('  vt projects rm <project>    stop tracking it\n')) +
        dim(tr('  vt projects all             go back to all of them\n')),
    );
    return 0;
  }

  if (sub === 'all') {
    await persist(trackAll());
    process.stdout.write(t`Tracking every project (${projects.length} projects).\n`);
    return 0;
  }

  if (args.names.length === 0) {
    process.stderr.write(t`Which project? Usage: vt projects ${sub} <project…>\n`);
    return 64;
  }

  // Resolve every name before changing anything: a half-applied edit across a
  // list of projects is harder to reason about than a refusal.
  const ids: string[] = [];
  /** Directories named by hand, to be remembered in the config. */
  const roots: Array<{ projectId: string; path: string; displayName: string }> = [];
  for (const name of args.names) {
    const m = matchProject(name, trackables);
    if (m.kind === 'none') {
      // Not a project we know — but it may be a directory, and naming one is
      // the only way to put a repository on the board before an agent has ever
      // been near it. Only when the user typed it: nothing here walks a disk
      // looking for candidates.
      const byPath = sub === 'add' ? await identifyDirectory(name) : null;
      if (byPath) {
        ids.push(byPath.projectId);
        roots.push(byPath);
        continue;
      }
      process.stderr.write(t`No such project: ${name}\n`);
      process.stderr.write(dim(tr('  Run `vt projects` to see the list.\n')));
      process.stderr.write(dim(tr('  For a project no agent has ever opened, give a directory path.\n')));
      return 65;
    }
    if (m.kind === 'many') {
      process.stderr.write(t`${name} matches more than one project:\n`);
      for (const c of m.candidates) {
        process.stderr.write(`  ${c.displayName}  ${dim(c.projectId)}\n`);
      }
      process.stderr.write(dim(tr('  Use its id instead.\n')));
      return 65;
    }
    ids.push(m.project.projectId);
  }

  // The path is written before the tracking list, so a project can never be
  // followed by an id nothing on this machine can resolve back to a directory.
  for (const r of roots) await rememberRoot(r.projectId, r.path);

  const change: TrackingChange =
    sub === 'add' ? addTracked(tracking, ids) : removeTracked(tracking, ids, trackables);

  await persist(change.next);

  // A directory named by hand is not in `trackables` — that list is what the
  // scan found — so its name comes from the identity we just resolved.
  const nameOf = (id: string): string =>
    trackables.find((p) => p.projectId === id)?.displayName ??
    roots.find((r) => r.projectId === id)?.displayName ??
    id;

  if (change.switchedToSelected) {
    process.stdout.write(
      cyan(tr('From now on only the projects you chose are shown.\n')) +
        dim(tr('  To go back to all of them: vt projects all\n')),
    );
  }
  for (const id of change.added) process.stdout.write(t`+ ${nameOf(id)} is now tracked\n`);
  for (const id of change.removed) process.stdout.write(t`− ${nameOf(id)} is no longer tracked\n`);
  if (change.added.length === 0 && change.removed.length === 0) {
    process.stdout.write(tr('Nothing changed.\n'));
  }
  process.stdout.write(t`Tracked: ${change.next.selected.length} projects\n`);
  return 0;
}
