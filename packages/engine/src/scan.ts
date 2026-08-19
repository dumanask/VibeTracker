import {
  interrupts,
  needsYou,
  type AgentTally,
  type DescendantSummaryLike,
  type IdeWindow,
  type Liveness,
  type ProcessTreeEntry,
  type ProcSnapshot,
  type ProjectView,
  type RegistryEntry,
  type SessionStateName,
  type SessionView,
  type StatusReport,
  type TranscriptFacts,
  type WorkspaceInfo,
} from '@vibetracker/shared';
import {
  assessDrift,
  attentionScore,
  awaitsAttention,
  fmtAge,
  deriveState,
  displayNameFor,
  labelWorkspaces,
  lastActivityOf,
  projectFlags,
  RECENT_WRITE_MS,
  sinceMs,
  SPAWN_GRACE_MS,
  summarizeAgents,
  summarizeBoard,
  urgencyOf,
  t,
  tr,
} from '@vibetracker/core';
import {
  claudeDir,
  classifyLiveness,
  classifyStorage,
  normPath,
  pathKey,
  realPathSafe,
  resolveProjectIdentity,
  summarizeDescendants,
  type GitFacts,
} from '@vibetracker/platform';
import { indexTranscripts, readIdeLocks, readPackageName, readRegistry } from './readers.ts';
import { ScanContext } from './context.ts';
import { readProjectProgress, type PriorReading } from './progress/scan.ts';
import {
  DEFAULT_RECENCY_MS,
  enabledAdapters,
  noteText,
  type AgentAdapter,
  type ObservedSession,
} from './agents/index.ts';

export interface ScanOptions {
  /** Sample CPU twice so "thinking" can be told from "stalled". */
  cpuSample: boolean;
  cpuSampleMs: number;
  includeDead: boolean;
  includeTemp: boolean;
  tailBytes: number;
  /** Read plan documents to derive phase and progress. Cached for 5 minutes. */
  progress?: boolean;
  /**
   * What the caller remembers about a project's earlier readings.
   *
   * Supplied by the daemon from its database; absent for one-shot `vt status`.
   * Detectors that need history simply do not fire without it, which is the
   * honest outcome — a single scan genuinely cannot see a trend.
   */
  history?: (projectId: string) => { prior: PriorReading | null; activitySince: number } | null;
  /**
   * What each session was called on the previous scan.
   *
   * Same shape and same reason as `history`: the daemon remembers, a one-shot
   * `vt status` does not, and without it the derivation simply has no previous
   * side to apply hysteresis against -- which is correct for a single reading.
   * It is only ever consulted at the cpu threshold; it can never carry a state
   * forward on its own.
   */
  previousState?: (sessionId: string) => SessionStateName | null;
  /**
   * Which projects the user follows. Absent means all of them.
   *
   * A predicate rather than a list so the engine never has to know how the
   * choice was spelled — by id here, by display name on the command line.
   */
  isTracked?: (projectId: string, displayName: string) => boolean;
  /**
   * Projects that stay on the board with no live agent at all.
   *
   * Supplied only when the user has picked projects by hand. Once picking is
   * an act, the list has to be the user's rather than the process table's: a
   * project you deliberately added and then closed should read `off`, not
   * vanish and leave you wondering whether the pick took. In `all` mode there
   * is no pick to honour, so nothing is kept and the board stays "whatever is
   * running" — otherwise every project ever opened would accumulate forever.
   */
  keepClosed?: (projectId: string, displayName: string) => boolean;
  /**
   * Directories to put on the board whether or not an agent has been near
   * them.
   *
   * Every other project here exists because a session ran in it. These exist
   * because the user said so — `vt projects add <yol>` — and they are the only
   * answer for a repository you want tracked before you have opened it with an
   * agent. Read-only like everything else: they contribute a workspace, a
   * phase and a percentage, and no sessions, because there are none.
   */
  extraRoots?: Array<{ projectId: string; path: string }>;
  /**
   * Which agents besides Claude Code to read, by adapter id. `['all']` means
   * every one whose state directory exists; an empty array means none.
   *
   * Undefined is *not* the same as `['all']` for a reason: `vt status` and the
   * daemon both pass the configured list, and a caller that forgot to would
   * otherwise silently get different results from the same machine. Undefined
   * therefore also means all, and the config always supplies a value.
   */
  agents?: readonly string[];
  /**
   * How long a session from a pid-less agent may have been quiet and still count
   * as live.
   *
   * Configurable because it is not a fact, it is an admission: Codex and
   * opencode record no pid, so this is the width of the window inside which we
   * cannot tell a working session from a closed one. Someone whose agent thinks
   * for minutes between writes wants it wider; someone who wants the board to
   * go quiet the moment they close a terminal wants it narrower.
   */
  agentRecencyMs?: number;
}

/**
 * Ceiling on confidence for a session whose liveness came from a clock.
 *
 * Codex and opencode record no pid, so "live" there means "wrote something
 * inside the window". A session the user closed thirty seconds ago still looks
 * live for the rest of it. The state machine's own numbers assume a process was
 * checked, so they are capped here rather than adjusted inside it — one author
 * for the number, one place that limits it.
 *
 * 0.55 sits below the dashed/hatched threshold the panel uses for "unsure",
 * which is how this reaches the screen without a second rule.
 */
const RECENCY_CONFIDENCE = 0.55;

/** Reads every enabled adapter, tolerating one that fails. */
async function readAdapters(
  adapters: AgentAdapter[],
  now: number,
  recencyMs: number,
): Promise<{
  sessions: ObservedSession[];
  recencyMs: number;
  perAdapter: Array<{
    adapter: AgentAdapter;
    detect: Awaited<ReturnType<AgentAdapter['detect']>>;
    sessions: ObservedSession[];
  }>;
}> {
  const perAdapter = await Promise.all(
    adapters.map(async (adapter) => {
      // An adapter that throws must not take the scan with it. These read files
      // written by programs we do not control, on machines we have never seen,
      // and the correct response to a surprise is to lose that agent's rows —
      // not the board.
      let detect: Awaited<ReturnType<AgentAdapter['detect']>>;
      try {
        detect = await adapter.detect();
      } catch {
        detect = { installed: false, hasData: false, lastActivityAt: 0 };
      }
      if (!detect.installed || !detect.hasData) return { adapter, detect, sessions: [] };
      try {
        return { adapter, detect, sessions: await adapter.listSessions({ now, recencyMs }) };
      } catch {
        return { adapter, detect, sessions: [] };
      }
    }),
  );
  return {
    sessions: perAdapter.flatMap((r) => r.sessions),
    recencyMs,
    perAdapter,
  };
}

export const DEFAULT_SCAN: ScanOptions = {
  cpuSample: true,
  cpuSampleMs: 1200,
  includeDead: false,
  includeTemp: false,
  tailBytes: 256 * 1024,
};

/**
 * One complete pass over the agent's state.
 *
 * Structured in three phases because the middle one is conditional: we cannot
 * know whether the (expensive) process tree is needed until the transcripts
 * have told us whether anything has a tool open.
 */
export async function scan(
  opts: ScanOptions = DEFAULT_SCAN,
  ctx?: ScanContext,
): Promise<StatusReport> {
  // Without a caller-supplied context we own the probe and must dispose it;
  // with one, it outlives us and is reused across polls.
  const owned = ctx ? null : new ScanContext();
  const context = ctx ?? owned!;
  try {
    return await runScan(opts, context);
  } finally {
    if (owned) await owned.close();
  }
}

async function runScan(opts: ScanOptions, ctx: ScanContext): Promise<StatusReport> {
  const dir = claudeDir();
  const now = Date.now();
  const warnings: string[] = [];
  const capabilities: Record<string, { ok: boolean; detail?: string }> = {};

  // Adapters are read here, in the same breath as Claude Code's own sources,
  // because their pids have to be in the probe snapshot below. Doing it later
  // would mean a second snapshot for the sake of ordering. Measured cost of the
  // whole set on this machine: single-digit milliseconds, because each adapter
  // only looks at what has moved recently.
  const adapters = enabledAdapters(() => ctx.tail(), opts.agents);
  const [registry, ideWindows, transcripts, observed] = await Promise.all([
    readRegistry(dir),
    readIdeLocks(dir),
    indexTranscripts(dir),
    readAdapters(adapters, now, opts.agentRecencyMs ?? DEFAULT_RECENCY_MS),
  ]);

  capabilities.claudeDir = { ok: true, detail: dir };
  capabilities.sessionRegistry = registry.error
    ? { ok: false, detail: registry.error }
    : {
        ok: true,
        detail:
          registry.entries.length === 1
            ? t`${registry.entries.length} record`
            : t`${registry.entries.length} records`,
      };
  capabilities.ideLocks = { ok: ideWindows.length > 0, detail: t`${ideWindows.length} lock files` };
  capabilities.transcriptIndex = {
    ok: transcripts.size > 0,
    detail: t`${transcripts.size} transcripts indexed`,
  };
  if (registry.error) {
    warnings.push(tr('The session registry could not be read. Liveness detection is unavailable.'));
  }

  // ── liveness ────────────────────────────────────────────────────────────
  const probe = ctx.probe();
  const allPids = [
    ...new Set([
      ...registry.entries.map((e) => e.pid),
      ...ideWindows.map((w) => w.pid),
      // Cline records a pid. Asking about it in the same call costs nothing and
      // buys the only non-Claude liveness on this board that is a fact about a
      // process rather than a window we declared.
      ...observed.sessions.flatMap((s) => (s.pid === undefined ? [] : [s.pid])),
    ]),
  ];

  let snap1 = new Map<number, ProcSnapshot>();
  let snap2: Map<number, ProcSnapshot> | null = null;
  let probeError: string | null = null;
  try {
    snap1 = await probe.snapshot(allPids);
  } catch (err) {
    probeError = (err as Error).message;
  }

  capabilities.processProbe = probeError
    ? { ok: false, detail: `${probe.kind}: ${probeError}` }
    : { ok: true, detail: t`${probe.kind} (precision: ${probe.precision})` };
  if (probeError) {
    warnings.push(t`The process probe failed. Liveness fell back to "does the PID exist".`);
  }

  const batch = classifyLiveness(
    registry.entries.map((e) => ({ pid: e.pid, procStart: e.procStart })),
    snap1,
    probeError ? 'none' : probe.precision,
  );

  capabilities.pidReuseGuard = batch.guardAvailable
    ? {
        ok: !batch.formatDriftSuspected,
        detail: batch.formatDriftSuspected
          ? tr('start-time format does not match — the guard is off')
          : batch.opaque > 0
            ? t`${batch.matched} matched / ${batch.mismatched} mismatched / ${batch.opaque} PIDs belong to someone else`
            : t`${batch.matched} matched / ${batch.mismatched} did not`,
      }
    : { ok: false, detail: tr('the agent writes no comparable start time') };

  if (batch.formatDriftSuspected) {
    warnings.push(
      t`PID-reuse guard disabled: NONE of the ${batch.mismatched} comparable records ` +
        t`matched. That means the agent's start-time format changed, not that every ` +
        t`process was recycled. Sessions were counted as "live".`,
    );
  }
  if (!probeError && probe.precision === 'second') {
    warnings.push(
      tr('Start time has one-second resolution on this platform; a PID recycled within ') +
        tr('the same second can slip past the guard.'),
    );
  }

  const cpuPctFor = (pid: number): number | null => {
    if (!snap2) return null;
    const a = snap1.get(pid);
    const b = snap2.get(pid);
    if (!a || !b || (a.cpuNs === 0 && b.cpuNs === 0)) return null;
    const deltaNs = b.cpuNs - a.cpuNs;
    if (deltaNs < 0) return null;
    return (deltaNs / (opts.cpuSampleMs * 1_000_000)) * 100;
  };

  for (const w of ideWindows) w.alive = snap1.has(w.pid);
  const ideByFolder = new Map<string, IdeWindow>();
  for (const w of ideWindows) {
    if (!w.alive) continue;
    for (const f of w.workspaceFolders) ideByFolder.set(pathKey(f), w);
  }

  // ── phase 1: read transcripts ───────────────────────────────────────────
  let live = 0;
  let dead = 0;
  let reused = 0;
  const scanned: Array<{
    entry: RegistryEntry;
    liveness: Liveness;
    facts: TranscriptFacts | null;
    transcriptPath?: string;
  }> = [];
  /** Dead or recycled entries, kept only to resurrect a picked project. */
  const closedEntries: RegistryEntry[] = [];

  await Promise.all(
    registry.entries.map(async (entry) => {
      const liveness = batch.verdicts.get(entry.pid) ?? 'unknown';
      if (liveness === 'live') live++;
      else if (liveness === 'reused') reused++;
      else dead++;
      if (liveness !== 'live' && !opts.includeDead) {
        if (opts.keepClosed) closedEntries.push(entry);
        return;
      }

      const transcriptPath = transcripts.get(entry.sessionId);
      const facts =
        transcriptPath && liveness === 'live'
          ? await ctx.tail().read(transcriptPath, { tailBytes: opts.tailBytes })
          : null;
      scanned.push({ entry, liveness, facts, transcriptPath });
    }),
  );

  // Ended sessions must not keep a descriptor open just because the daemon is
  // still running.
  //
  // The set has to name *everything* still being followed, and for a while it
  // named only Claude Code's registry paths. The adapters share this reader
  // (`enabledAdapters(() => ctx.tail(), …)` above) and Codex reads its rollouts
  // through it, so every scan dropped every Codex entry and the next scan
  // reopened it: the offset discipline this class exists for was switched off
  // for one agent in particular. Measured — three polls of one rollout with an
  // open `shell` call gave `["shell"], [], []` and four opens instead of
  // `["shell"]` three times and two. A tool that scrolled out of the 256 KB
  // window was simply forgotten, which is how `BUSY(tool:…)` went missing on
  // Codex sessions while looking like an agent difference.
  const activePaths = new Set(
    scanned.filter((s) => s.facts).map((s) => s.transcriptPath as string),
  );
  for (const s of observed.sessions) {
    if (s.facts.path) activePaths.add(s.facts.path);
  }
  await ctx.tail().retain(activePaths);

  const tailStats = ctx.tail().stats();
  capabilities.transcriptRead = {
    ok: true,
    detail:
      t`${tailStats.openHandles} open handles · ${tailStats.reads} reads / ` +
      t`${tailStats.skipped} skipped` +
      (tailStats.gaps > 0 ? t` · ${tailStats.gaps} gaps` : ''),
  };

  // ── phase 1b: CPU, only when a turn is actually in flight ───────────────
  //
  // Sampling CPU means holding still for the sample window — the single
  // largest cost in an otherwise idle poll. And it buys nothing most of the
  // time: deriveState consults CPU only for a session with an open tool, or
  // one whose last transcript entry was not the assistant's. Everything else
  // is decided by turn ownership, which the transcript already answered.
  // So we ask the transcripts first and sample only if the answer needs it.
  const needsCpu =
    opts.cpuSample &&
    !probeError &&
    scanned.some(({ liveness, facts }) => {
      if (liveness !== 'live' || !facts) return false;
      if (facts.openTools.length > 0) return true;
      const age = sinceMs(now, lastActivityOf(facts));
      return age >= RECENT_WRITE_MS && facts.lastEntryRole !== 'assistant';
    });

  if (needsCpu) {
    try {
      await new Promise((r) => setTimeout(r, opts.cpuSampleMs));
      snap2 = await probe.snapshot(allPids);
    } catch {
      snap2 = null; // Falls back to transcript-only reasoning, which is honest.
    }
  }
  capabilities.cpuSample = opts.cpuSample
    ? {
        ok: true,
        detail: needsCpu ? t`sampled over ${opts.cpuSampleMs} ms` : tr('not needed (no turn in flight)'),
      }
    : { ok: true, detail: tr('off (--quick)') };

  // ── phase 2: process tree, only if something has a tool open ────────────
  const needsTree = scanned.some((s) => (s.facts?.openTools.length ?? 0) > 0);
  let tree: Map<number, ProcessTreeEntry> | null = null;
  if (needsTree && !probeError) {
    tree = await ctx.tree(now);
  }

  capabilities.processTree = needsTree
    ? { ok: tree !== null, detail: tree ? t`${tree.size} processes` : tr('not applicable on this platform') }
    : { ok: true, detail: 'gerekmedi' };
  if (needsTree && tree === null) {
    warnings.push(
      tr('The process tree could not be read: for an open tool, "the command is running" ') +
        tr('cannot be told from "waiting for permission".'),
    );
  }

  // ── phase 3: decide ─────────────────────────────────────────────────────
  // Dialect drift, accumulated across every transcript in this scan.
  let dialectLines = 0;
  const dialectUnknown = new Map<string, number>();

  const views: Array<{ view: SessionView; identityCwd: string }> = [];
  for (const { entry, liveness, facts, transcriptPath } of scanned) {
    const descendants: DescendantSummaryLike | null =
      tree && facts && facts.openTools.length > 0
        ? summarizeDescendants(
            tree,
            entry.pid,
            // The call began roughly when the last transcript entry was written;
            // allow slack for clock granularity and flush lag.
            facts.lastEntryAt ? facts.lastEntryAt - SPAWN_GRACE_MS : null,
          )
        : null;

    // Derived from this one sample, then held to the previous answer unless
    // the change survives a second look. This is the path cpu noise enters by.
    const derived = ctx.settle(
      entry.sessionId,
      deriveState({
        liveness,
        facts,
        cpuPct: cpuPctFor(entry.pid),
        descendants,
        prevState: opts.previousState?.(entry.sessionId) ?? null,
        now,
      }),
      now,
    );

    // Unrecognised line types are accumulated rather than warned about one by
    // one: a single surprise is normal, a *rate* of them means this build no
    // longer understands the format. See `assessDrift`.
    if (facts) {
      dialectLines += facts.linesParsed;
      for (const kind of facts.unknownTypes) {
        dialectUnknown.set(kind, (dialectUnknown.get(kind) ?? 0) + 1);
      }
    }

    const ide = ideByFolder.get(pathKey(entry.cwd));
    views.push({
      identityCwd: entry.cwd,
      view: {
        sessionId: entry.sessionId,
        name: entry.name,
        pid: entry.pid,
        liveness,
        state: derived.state,
        evidence: derived.evidence,
        confidence: derived.confidence,
        cwd: entry.cwd,
        normPath: normPath(entry.cwd),
        entrypoint: entry.entrypoint,
        cliVersion: entry.version,
        startedAt: entry.startedAt,
        idePid: ide?.pid,
        ideName: ide?.ideName,
        title: facts?.aiTitle,
        lastPrompt: facts?.lastPrompt,
        lastActivityAt: facts ? lastActivityOf(facts) : undefined,
        openTools: facts?.openTools ?? [],
        transcriptPath,
        transcriptSize: facts?.size,
      },
    });
  }

  // ── the other agents ────────────────────────────────────────────────────
  //
  // They join the same `views` list, which is the point: from here on nothing
  // distinguishes a Codex session from a Claude Code one except its badge.
  // Identity resolution, workspace grouping, the tracking filter, the fleet-load
  // strip and the phase engine all run over the merged list, so "this project
  // has two agents in it" needs no special case anywhere.
  const agentTallies: AgentTally[] = [];
  for (const found of observed.perAdapter) {
    let live = 0;
    for (const s of found.sessions) {
      if (!s.cwd) continue;

      // A pid is a question. Cline records one and no start time, so the answer
      // is only "does this pid exist" — weaker than Claude Code's start-time
      // equality, and the evidence says so rather than letting it pass as equal.
      let liveness: Liveness = s.liveness;
      const extra: string[] = [];
      if (s.pid !== undefined) {
        liveness = snap1.has(s.pid) ? 'live' : 'dead';
        if (!s.procStart) extra.push(tr('liveness:pid present, no start time'));
      } else if (s.livenessBasis === 'recency') {
        extra.push(t`liveness:rests on the last write (no pid, window ${fmtAge(observed.recencyMs)})`);
      }

      if (liveness !== 'live' && !opts.includeDead) continue;
      live++;

      const derived = ctx.settle(
        s.sessionId,
        deriveState({
          liveness,
          facts: s.facts,
          // No CPU for these: sampling costs a held poll and only pays off for
          // a session whose pid we know, which is exactly the case where the
          // transcript has already answered. With no cpu there is no threshold
          // to sit on, so the previous state has nothing to decide either.
          cpuPct: null,
          descendants: null,
          prevState: null,
          now,
        }),
        now,
      );
      const evidence = [...derived.evidence, ...extra];
      // Liveness we inferred from a clock cannot support the confidence of
      // liveness we measured. Capped rather than recomputed, so the state
      // machine stays the single author of the number and this only limits it.
      const confidence =
        s.livenessBasis === 'recency'
          ? Math.min(derived.confidence, RECENCY_CONFIDENCE)
          : derived.confidence;

      views.push({
        identityCwd: s.cwd,
        view: {
          sessionId: s.sessionId,
          agentKind: s.agentKind,
          name: s.name,
          // Sessions with no pid still need one: `pid` is the tiebreaker that
          // keeps two same-named rows apart. Zero reads as "not a process we
          // can point at", which is the truth.
          pid: s.pid ?? 0,
          liveness,
          state: derived.state,
          evidence,
          confidence,
          cwd: s.cwd,
          normPath: normPath(s.cwd),
          cliVersion: s.cliVersion,
          startedAt: s.startedAt,
          title: s.facts.aiTitle,
          lastPrompt: s.facts.lastPrompt,
          lastActivityAt: lastActivityOf(s.facts),
          openTools: s.facts.openTools,
        },
      });

      if (s.facts.linesParsed > 0) {
        dialectLines += s.facts.linesParsed;
        for (const kind of s.facts.unknownTypes) {
          dialectUnknown.set(kind, (dialectUnknown.get(kind) ?? 0) + 1);
        }
      }
    }

    agentTallies.push({
      agentKind: found.adapter.id,
      displayName: found.adapter.displayName,
      installed: found.detect.installed,
      live,
      readsSessions: found.adapter.capabilities.sessions,
      lastActivityAt: found.detect.lastActivityAt,
      livenessBasis: found.adapter.capabilities.liveProcess
        ? 'pid'
        : found.adapter.capabilities.sessions
          ? 'recency'
          : 'none',
      turnState: found.adapter.capabilities.turnState,
      openTools: found.adapter.capabilities.openTools,
      note: found.detect.note,
    });
  }
  for (const tally of agentTallies) {
    const note = tally.note ? ` · ${noteText(tally.note as never)}` : '';
    capabilities[`agent:${tally.agentKind}`] = {
      // `ok` means "this adapter is doing everything it claims", not "this agent
      // is busy". An editor that only lists folders is working correctly when it
      // lists folders, and an installed agent nobody has used is not broken.
      ok: tally.installed,
      detail: !tally.installed
        ? tr('not installed')
        : !tally.readsSessions
          ? tr('folder list') + note
          : t`${tally.live} sessions · liveness: ${
              tally.livenessBasis === 'pid' ? tr('pid') : tr('last write')
            }` + note,
    };
  }

  // ── project identity + grouping ─────────────────────────────────────────
  const identityCache = new Map<
    string,
    { projectId: string; identityKind: 'git_root' | 'package' | 'path'; git: GitFacts | null }
  >();
  const uniqueCwds = [...new Set(views.map((v) => v.identityCwd).filter(Boolean))];
  await Promise.all(
    uniqueCwds.map(async (cwd) => {
      const key = pathKey(cwd);
      identityCache.set(
        key,
        await ctx.identity(key, now, () => resolveProjectIdentity(cwd, readPackageName)),
      );
    }),
  );
  const gitCount = [...identityCache.values()].filter((i) => i.identityKind === 'git_root').length;
  capabilities.git = {
    ok: gitCount > 0,
    detail: t`${gitCount}/${identityCache.size} by root commit`,
  };

  const projects = new Map<string, ProjectView>();
  const closedProjects = new Map<string, ProjectView>();
  for (const { view, identityCwd } of views) {
    const ident = identityCache.get(pathKey(identityCwd)) ?? {
      projectId: `path:${pathKey(identityCwd)}`,
      identityKind: 'path' as const,
      git: null,
    };
    const storageKind = classifyStorage(identityCwd);
    if (storageKind === 'temp' && !opts.includeTemp) continue;

    let proj = projects.get(ident.projectId);
    if (!proj) {
      proj = {
        projectId: ident.projectId,
        identityKind: ident.identityKind,
        displayName: displayNameFor(ident.git?.toplevel ?? identityCwd),
        workspaces: [],
        sessions: [],
        flags: [],
        tracked: true,
        // Filled in below, once every session has been attached.
        summary: { kind: 'none', waiting: 0, blocked: 0, running: 0, live: 0, total: 0, urgency: 0 },
      };
      proj.tracked = opts.isTracked
        ? opts.isTracked(proj.projectId, proj.displayName)
        : true;
      projects.set(ident.projectId, proj);
    }

    const wsPath = ident.git?.toplevel ?? normPath(identityCwd);
    if (!proj.workspaces.some((w) => w.normPath === wsPath)) {
      proj.workspaces.push(buildWorkspace(wsPath, identityCwd, ident.git, storageKind));
    }
    proj.sessions.push(view);
  }

  // ── projects picked by hand that have nothing running ───────────────────
  // Identity is resolved here rather than in phase 1 because it needs a git
  // probe per directory, and doing that for every dead registry entry would
  // pay the most expensive part of the scan for rows nobody asked to see.
  if (opts.keepClosed && closedEntries.length > 0) {
    const cwds = [...new Set(closedEntries.map((e) => e.cwd).filter(Boolean))];
    await Promise.all(
      cwds.map(async (cwd) => {
        const key = pathKey(cwd);
        if (identityCache.has(key)) return;
        identityCache.set(
          key,
          await ctx.identity(key, now, () => resolveProjectIdentity(cwd, readPackageName)),
        );
      }),
    );
    for (const entry of closedEntries) {
      const ident = identityCache.get(pathKey(entry.cwd));
      if (!ident) continue;
      // A project that already has a live session is complete; adding its old
      // sessions here would put a dozen tombstones under a working project.
      if (projects.has(ident.projectId)) continue;
      const storageKind = classifyStorage(entry.cwd);
      if (storageKind === 'temp' && !opts.includeTemp) continue;
      const displayName = displayNameFor(ident.git?.toplevel ?? entry.cwd);
      if (!opts.keepClosed(ident.projectId, displayName)) continue;

      let proj = closedProjects.get(ident.projectId);
      if (!proj) {
        proj = {
          projectId: ident.projectId,
          identityKind: ident.identityKind,
          displayName,
          workspaces: [],
          sessions: [],
          flags: [],
          tracked: true,
          summary: { kind: 'none', waiting: 0, blocked: 0, running: 0, live: 0, total: 0, urgency: 0 },
        };
        closedProjects.set(ident.projectId, proj);
      }
      const wsPath = ident.git?.toplevel ?? normPath(entry.cwd);
      if (!proj.workspaces.some((w) => w.normPath === wsPath)) {
        proj.workspaces.push(buildWorkspace(wsPath, entry.cwd, ident.git, storageKind));
      }
      // The state machine decides, here as everywhere else.
      //
      // These three fields were written by hand — `'ORPHANED'`, `['proc:gone']`,
      // `0.95` — which is `deriveState`'s dead branch copied out. But this list
      // holds every entry whose liveness is not `live`, and that includes
      // `reused`: a PID that now belongs to a stranger. For those the machine
      // says `proc:pid-reused`, and the copy said the process was gone. PID
      // reuse is the one thing this tool can measure that a directory listing
      // cannot — printing the wrong reason for it on the row that shows it is
      // the worst place in the product to have a second opinion.
      const liveness = batch.verdicts.get(entry.pid) ?? 'unknown';
      const derived = deriveState({
        liveness,
        facts: null,
        cpuPct: null,
        descendants: null,
        prevState: null,
        now,
      });
      proj.sessions.push({
        sessionId: entry.sessionId,
        name: entry.name,
        pid: entry.pid,
        liveness,
        state: derived.state,
        evidence: derived.evidence,
        confidence: derived.confidence,
        cwd: entry.cwd,
        normPath: normPath(entry.cwd),
        entrypoint: entry.entrypoint,
        cliVersion: entry.version,
        startedAt: entry.startedAt,
        openTools: [],
      });
    }
    for (const [id, proj] of closedProjects) projects.set(id, proj);
  }

  // ── directories the user named by hand ──────────────────────────────────
  if (opts.extraRoots?.length) {
    await Promise.all(
      opts.extraRoots.map(async (root) => {
        const key = pathKey(root.path);
        let ident = identityCache.get(key);
        if (!ident) {
          try {
            ident = await ctx.identity(key, now, () =>
              resolveProjectIdentity(root.path, readPackageName),
            );
          } catch {
            return;
          }
          identityCache.set(key, ident);
        }
        // Already on the board through a session: nothing to add, and the
        // session-derived entry is the richer one.
        if (projects.has(ident.projectId)) return;
        const displayName = displayNameFor(ident.git?.toplevel ?? root.path);
        projects.set(ident.projectId, {
          projectId: ident.projectId,
          identityKind: ident.identityKind,
          displayName,
          workspaces: [
            buildWorkspace(
              ident.git?.toplevel ?? normPath(root.path),
              root.path,
              ident.git,
              classifyStorage(root.path),
            ),
          ],
          sessions: [],
          flags: [],
          tracked: opts.isTracked ? opts.isTracked(ident.projectId, displayName) : true,
          summary: { kind: 'none', waiting: 0, blocked: 0, running: 0, live: 0, total: 0, urgency: 0 },
        });
      }),
    );
  }

  // ── phase / progress ────────────────────────────────────────────────────
  // Last, and only for projects we are actually showing: reading a docs tree
  // costs far more than everything above it, and it answers a question that
  // changes daily rather than per-poll.
  if (opts.progress !== false) {
    await Promise.all(
      [...projects.values()].map(async (proj) => {
        const ws = proj.workspaces[0];
        if (!ws) return;
        // Reading a documentation tree is the most expensive thing in the
        // scan. A project the user is not following does not get one — that
        // is the entire point of letting them choose.
        if (!proj.tracked) return;
        const ident = identityCache.get(pathKey(ws.rawPathSample));
        try {
          const past = opts.history?.(proj.projectId) ?? null;
          const r = await ctx.progress(proj.projectId, now, () =>
            readProjectProgress(ws.normPath, {
              git: ident?.git ?? null,
              now,
              prior: past?.prior ?? null,
              activitySince: past?.activitySince ?? 0,
            }),
          );
          proj.progress = {
            phase: r.phase,
            percent: r.percent,
            basis: r.basis,
            percentSuppressed: r.percentSuppressed,
            phaseSuppressed: r.phaseSuppressed,
            approximate: r.approximate,
            nextAction: r.nextAction,
            observedAt: r.observedAt,
            provenance: r.provenance,
            drift: r.drift,
            sourceCount: r.sourceCount,
            planCount: r.planCount,
            doneWeight: r.doneWeight,
            totalWeight: r.totalWeight,
          };
        } catch {
          /* an unreadable docs tree must not fail the whole scan */
        }
      }),
    );
    const withPhase = [...projects.values()].filter((p) => p.progress?.phase).length;
    capabilities.progress = {
      ok: withPhase > 0,
      detail: t`phase ladder found in ${withPhase}/${projects.size} projects`,
    };
  }

  for (const proj of projects.values()) {
    proj.sessions.sort((a, b) => {
      const byUrgency = urgencyOf(b.state) - urgencyOf(a.state);
      if (byUrgency !== 0) return byUrgency;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
    labelWorkspaces(proj.workspaces);
    proj.flags = projectFlags(proj);
  }

  // One computation, three renderers. The terminal, the dashboard and the
  // pinned note all draw this; none of them re-derives it.
  for (const proj of projects.values()) proj.summary = summarizeAgents(proj, now);

  const ordered = [...projects.values()].sort((a, b) => attentionScore(b) - attentionScore(a));
  // Counts describe what the user is following. An agent waiting inside a
  // project they stopped tracking must not raise the "someone needs you"
  // number, or the selection would be a filter on the list but not on the
  // alarm — and the alarm is the part that interrupts them.
  const followed = ordered.filter((p) => p.tracked);
  const needsYouCount = followed.reduce(
    (n, p) => n + p.sessions.filter((s) => awaitsAttention(s, now)).length,
    0,
  );
  // The subset that is allowed to interrupt someone. Counted here beside the
  // number it is a subset of, so no surface has to work it out again -- and
  // work it out differently, which is exactly what had happened.
  const blockedCount = followed.reduce(
    (n, p) => n + p.sessions.filter((s) => interrupts(s.state)).length,
    0,
  );

  // Dialect health. Reported as a capability rather than a warning when it is
  // fine, because "we still understand the format" is a fact worth showing
  // next to the others — and the day it stops being true, the same line says
  // so instead of the dashboard quietly showing less.
  const unknownTotal = [...dialectUnknown.values()].reduce((a, b) => a + b, 0);
  const byFrequency = [...dialectUnknown.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind]) => kind);
  const drift = assessDrift(dialectLines, byFrequency, unknownTotal);
  capabilities.dialect = {
    ok: !drift.drifted,
    detail: drift.drifted
      ? t`${byFrequency.length} unrecognised line types · ${Math.round(drift.ratio * 100)}% — ` +
        t`your agent version may be newer than this VibeTracker build`
      : byFrequency.length > 0
        ? t`${dialectLines} lines · ${byFrequency.length} unrecognised types (ignored)`
        : t`${dialectLines} lines · all recognised`,
  };
  if (drift.drifted) {
    warnings.push(
      t`The transcript format may have changed: ${byFrequency.slice(0, 4).join(', ')}. Monitoring is limited.`,
    );
  }

  return {
    generatedAt: now,
    platform: `${process.platform}-${process.arch}`,
    probeKind: probe.kind,
    probePrecision: probeError ? 'none' : probe.precision,
    claudeDir: dir,
    counts: {
      registryEntries: registry.entries.length,
      live,
      dead,
      reused,
      projects: followed.length,
      untracked: ordered.length - followed.length,
      needsYou: needsYouCount,
      blocked: blockedCount,
      ideWindows: ideWindows.filter((w) => w.alive).length,
    },
    // Kept out of `counts` deliberately: that block is the Claude Code
    // registry's story, and the 50/13/3 in it is the evidence that the
    // PID-reuse guard works. Folding six agents into those three numbers would
    // erase the only measurement this tool can point at.
    agents: agentTallies,
    // Computed here, next to the counts it is made of, so the strip along the
    // top of every surface says the same thing as the rows below it.
    load: summarizeBoard(followed.map((p) => p.summary)),
    capabilities,
    warnings,
    projects: ordered,
    ideWindows,
  };
}

function buildWorkspace(
  wsPath: string,
  rawSample: string,
  git: GitFacts | null,
  storageKind: WorkspaceInfo['storageKind'],
): WorkspaceInfo {
  return {
    normPath: wsPath,
    realPath: realPathSafe(wsPath),
    rawPathSample: rawSample,
    isWorktree: git?.isWorktree ?? false,
    gitRootSha: git?.rootSha ?? undefined,
    gitCommonDir: git?.commonDir,
    gitRemote: git?.remote ?? undefined,
    branch: git?.branch ?? undefined,
    headSha: git?.headSha ?? undefined,
    headSubject: git?.headSubject ?? undefined,
    headAtMs: git?.headAtMs ?? undefined,
    commitCount: git?.commitCount ?? undefined,
    dirtyCount: git?.dirtyCount,
    dirtyIsBuildNoise: git?.dirtyIsBuildNoise,
    storageKind,
  };
}
