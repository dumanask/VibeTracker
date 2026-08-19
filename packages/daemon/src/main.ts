import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  scan,
  ScanContext,
  discoverProjects,
  identifyDirectory,
  validateChoice,
  type ScanOptions,
} from '@vibetracker/engine';
import { dataDir, configPath, claudeDir, loadConfig, writeConfig } from '@vibetracker/platform';
import {
  t,
  ALERT_REARM_MS,
  MAINTENANCE_INTERVAL_MS,
  redactSnippet,
  tr,
  configuredRoots,
  isTracked,
  defaultConfig,
  setTomlValues,
  type TrackingConfig,
  setCustomPatterns,
} from '@vibetracker/core';
import { interrupts, type SessionStateName, type StatusReport } from '@vibetracker/shared';
import { Store, type MaintenanceResult, type StateChange } from './store.ts';
import { DaemonServer } from './server.ts';
import { bindWarning } from './security.ts';
import { enableFileLog, log } from './log.ts';
import { HookRing } from './hooks/ring.ts';
import { HookIngest } from './hooks/ingest.ts';
import { buildBoard, type Board } from './board.ts';
import { Momentum } from './momentum.ts';
import { loadOrCreateApiToken, loadOrCreateHookToken } from './tokens.ts';
import { digestView } from './digest-settings.ts';

export const DEFAULT_PORT = 47823;

/**
 * How far back D5 looks. Matches the detector's own window in the engine: a
 * ratio frozen for three weeks while work continues is a pattern, and a
 * shorter window would fire on any project that took a holiday.
 */
const D5_WINDOW_MS = 21 * 24 * 3600_000;
export const VERSION = '0.1.0';

/**
 * The port is fixed rather than negotiated.
 *
 * Claude Code hook URLs are static strings in settings.json with no
 * interpolation, and a hook cannot read a port file. So a daemon that quietly
 * moved to another port would keep serving a dashboard that looks alive while
 * being blind to every permission prompt — the worst possible failure, because
 * it is invisible. If the port is taken by something that is not us, we fail
 * loudly instead.
 */

export interface DaemonOptions {
  port?: number;
  host?: string;
  scanIntervalMs?: number;
  scan?: Partial<ScanOptions>;
  /** Override the database location; ':memory:' for tests. */
  dbPath?: string;
}

export interface RuntimeInfo {
  schemaVersion: 1;
  daemonId: string;
  port: number;
  pid: number;
  token: string;
  startedAt: number;
  version: string;
}

export function runtimeFilePath(): string {
  return join(dataDir(), 'daemon.json');
}

export function logFilePath(): string {
  return join(dataDir(), 'daemon.log');
}

export function readRuntimeInfo(): RuntimeInfo | null {
  try {
    const raw = readFileSync(runtimeFilePath(), 'utf8');
    const info = JSON.parse(raw) as RuntimeInfo;
    return typeof info?.port === 'number' && typeof info?.token === 'string' ? info : null;
  } catch {
    return null;
  }
}

export class Daemon {
  #opts: Required<Pick<DaemonOptions, 'port' | 'host' | 'scanIntervalMs'>>;
  #scanOpts: ScanOptions;
  /** Which non-Claude agents to read, from `[agents] enabled`. */
  #agents: readonly string[] | undefined;
  #agentRecencyMs: number | undefined;
  /** Hand-named project directories, refreshed with the tracking config. */
  #roots: Array<{ projectId: string; path: string }> = [];
  #ctx = new ScanContext();
  #store: Store;
  #server: DaemonServer;
  #latest: StatusReport | null = null;
  #timer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #maintenance: NodeJS.Timeout | null = null;
  #lastMaintenance: (MaintenanceResult & { at: number }) | null = null;
  #scanning = false;
  #stopped = false;
  #daemonId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  /**
   * The dashboard token, persisted rather than minted per start.
   *
   * See `tokens.ts`: every surface that shows the board holds this string for
   * as long as the surface lives, and a daemon restart used to lock all of them
   * out at once. The daemon restarts on its own — the watchdog exits rather
   * than hang — so that was not a rare state.
   */
  #token = loadOrCreateApiToken();
  #hookToken = loadOrCreateHookToken();
  #ring = new HookRing();
  /**
   * The last state we announced for each session, so we do not announce it
   * again. Bounded by the sessions the daemon has seen and pruned by
   * maintenance; see `#emitChange` for what it is defending against.
   */
  #alerted = new Map<string, string>();
  #momentum = new Momentum();
  #hooks = new HookIngest();
  #oversize = 0;
  #startedAt = Date.now();
  #scanCount = 0;
  #lastScanMs = 0;
  #lastError: string | null = null;
  /** Last few event-loop phases, so a watchdog kill can explain itself. */
  #tracking: TrackingConfig = defaultConfig().tracking;
  /** Exactly what the config file says, before identity moves are applied. */
  #trackingRaw: TrackingConfig = defaultConfig().tracking;
  #loggedMoves = new Set<string>();
  #trackingStamp = 0;
  #phase = 'idle';
  #phaseSince = Date.now();

  constructor(opts: DaemonOptions = {}) {
    this.#opts = {
      port: opts.port ?? DEFAULT_PORT,
      host: opts.host ?? '127.0.0.1',
      scanIntervalMs: opts.scanIntervalMs ?? 3000,
    };
    this.#scanOpts = {
      cpuSample: true,
      cpuSampleMs: 700,
      includeDead: false,
      includeTemp: false,
      tailBytes: 256 * 1024,
      ...opts.scan,
    };
    this.#store = new Store(opts.dbPath ? { path: opts.dbPath } : {});
    this.#server = new DaemonServer({
      port: this.#opts.port,
      host: this.#opts.host,
      token: this.#token,
      daemonId: this.#daemonId,
      version: VERSION,
      latest: () => this.#latest,
      health: () => this.health(),
      hookToken: this.#hookToken,
      onHook: (raw) => this.#ring.push(raw),
      // `vt daemon stop` arrives here. We stop ourselves rather than being
      // killed, so the database closes cleanly and the runtime file is removed
      // instead of being left behind pointing at a pid that no longer exists.
      onShutdown: () => {
        log(t`shutdown requested`);
        void this.stop().then(
          () => process.exit(0),
          () => process.exit(0),
        );
      },
      onOversize: () => this.#oversize++,
      board: (projectId) => this.#board(projectId),
      setTracking: (mode, selected) => this.#setTracking(mode, selected),
      changeTracking: (add, remove) => this.#changeTracking(add, remove),
      candidates: () =>
        this.#store.candidates().map((c) => ({
          ...c,
          tracked: isTracked(this.#tracking, c.projectId),
        })),
      addPath: (path) => this.#addPath(path),
      digest: () => this.#digest(),
      setDigest: (choice) => this.#setDigest(choice),
    });
  }

  get token(): string {
    return this.#token;
  }
  get hookToken(): string {
    return this.#hookToken;
  }
  get port(): number {
    return this.#opts.port;
  }

  health(): Record<string, unknown> {
    const stats = this.#store.stats();
    return {
      uptimeMs: Date.now() - this.#startedAt,
      scans: this.#scanCount,
      lastScanMs: this.#lastScanMs,
      lastError: this.#lastError,
      clients: this.#server.clientCount,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      db: { path: this.#store.path, ...stats },
      // `vt doctor` reads this, and a daemon reachable from the network should
      // say so to the tool whose job is telling you what your install is doing.
      bind: this.#opts.host,
      transcripts: this.#ctx.tail().stats(),
      hooks: this.hookHealth(),
      maintenance: this.#lastMaintenance,
      phase: this.#phase,
    };
  }

  /**
   * Hook health is reported per event, because "hooks are installed" and
   * "hooks are firing" are different claims and only the second one is useful.
   * An event that was bound but has never arrived is the signature of a
   * settings file the agent is not reading, or an event name that drifted.
   */
  hookHealth(): Record<string, unknown> {
    const s = this.#hooks.stats;
    return {
      received: this.#ring.received,
      dropped: this.#ring.dropped,
      oversize: this.#oversize,
      pending: this.#ring.pending,
      parsed: s.parsed,
      unparsable: s.unparsable,
      ignored: s.ignored,
      sessions: s.bySession,
      lastAt: s.lastAt,
      byEvent: Object.fromEntries(s.events),
    };
  }

  /**
   * Record every project the agent has ever worked in, once, at startup.
   *
   * The board only ever sees projects with a live agent, so the database only
   * learned about a project while it was running — and the chooser, which
   * reads that database, could offer you nothing you were not running at that
   * moment. The session registry is barely better: six projects against the
   * twenty-three the transcript directory remembers.
   *
   * So the source is the transcript directory, read through
   * `discoverProjects`: a few kilobytes per project for the path, then one git
   * probe per directory. Measured at 11 projects in under a second, once per
   * daemon.
   *
   * Deliberately not part of the poll loop. This answers "what exists", which
   * changes when you start a project, not every two seconds.
   */
  async #seedProjects(): Promise<void> {
    try {
      // Once per daemon, not per poll — so the other agents' directory lists
      // are affordable here too, and the panel's chooser offers a project you
      // last touched with opencode instead of pretending it does not exist.
      const known = await discoverProjects(claudeDir(), { agents: ['all'] });
      this.#store.rememberProjects(known);
    } catch (err) {
      // A chooser missing a few rows is a small loss; a daemon that will not
      // start is not. This is the one place that failure is genuinely optional.
      log(`could not seed the project list: ${String(err)}`);
    }
  }

  async start(): Promise<void> {
    mkdirSync(dataDir(), { recursive: true });
    enableFileLog(logFilePath());

    // Read the selection before anything can be asked about it.
    //
    // `#tracking` starts at the default, which is *follow everything*, and it
    // used to be corrected only by the first scan -- several seconds later,
    // because that scan pays the probe host's startup. In between, the chooser
    // answered `tracked: true` for all 42 projects, so a panel opened at launch
    // showed every box ticked; pressing save from that screen would have
    // written the lie back over a real selection. The desktop app opens the
    // panel the moment it starts the daemon, which is precisely that window.
    await this.#refreshTracking();

    // Single instance: if the port is busy, ask who is there.
    const existing = await probeExisting(this.#opts.port);
    if (existing?.ok) {
      throw new AlreadyRunningError(existing.daemonId ?? 'unknown', this.#opts.port);
    }

    try {
      await this.#server.listen();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE') {
        throw new PortTakenError(this.#opts.port);
      }
      throw err;
    }

    this.#writeRuntimeInfo();
    this.#startWatchdog();

    // Run one scan immediately so the dashboard has content, then settle into
    // the interval. The first scan pays the probe host startup (~2.2 s).
    await this.#seedProjects();
    await this.#tick();
    this.#timer = setInterval(() => void this.#tick(), this.#opts.scanIntervalMs);

    // Retention runs at startup too: the interesting case is a daemon that was
    // off for a month, where waiting an hour to notice the database is over the
    // cap would be the wrong hour to wait.
    this.#runMaintenance();
    this.#maintenance = setInterval(() => this.#runMaintenance(), MAINTENANCE_INTERVAL_MS);
    this.#maintenance.unref();

    log(
      t`started · pid ${process.pid} · port ${this.#opts.port} · v${VERSION} · ` +
        t`node ${process.version} · db ${this.#store.path}`,
    );
  }

  /**
   * Write a new project selection to the config file.
   *
   * The file is the single source of truth, shared with `vt projects`, so the
   * dashboard and the command line cannot drift apart. The edit preserves
   * comments — the config is TOML precisely so a human can annotate it — and
   * the next scan picks the change up through the same mtime check any other
   * edit goes through.
   */
  /**
   * Apply a follow/unfollow delta on top of whatever is configured now.
   *
   * Read-modify-write against the file rather than against `this.#tracking`,
   * which is a cached copy refreshed on a timer: two clicks in the same second
   * would otherwise both start from the same stale set and the second would
   * undo the first.
   */
  async #changeTracking(add: string[], remove: string[]): Promise<number> {
    await this.#refreshTracking();
    const base =
      this.#tracking.mode === 'all'
        ? // Coming from `all`, everything on the board is followed, so
          // unfollowing one means following the rest.
          (this.#latest?.projects ?? []).map((p) => p.projectId)
        : [...this.#tracking.selected];
    const next = base.filter((id) => !remove.includes(id));
    for (const id of add) if (!next.includes(id)) next.push(id);
    await this.#setTracking('selected', next);
    return next.length;
  }

  /**
   * Follow a directory the user named.
   *
   * Three writes in a deliberate order. The path goes into the config first,
   * so the project can never be followed by an id nothing on this machine can
   * resolve back to a directory. Then the tracking delta, which is what puts
   * it on the board. Then the project row, so the chooser lists it with a tick
   * on the very next open rather than after the next restart.
   *
   * A directory already known simply becomes followed — naming a project you
   * already have is not an error, it is a way of saying "this one".
   */
  async #addPath(
    path: string,
  ): Promise<
    { ok: true; projectId: string; displayName: string } | { ok: false; reason: 'notdir' | 'failed' }
  > {
    const found = await identifyDirectory(path);
    if (!found) return { ok: false, reason: 'notdir' };
    try {
      await this.#rememberRoot(found.projectId, found.path);
      await this.#changeTracking([found.projectId], []);
      this.#store.rememberProjects([
        {
          projectId: found.projectId,
          identityKind: found.projectId.startsWith('git:')
            ? 'git_root'
            : found.projectId.startsWith('pkg:')
              ? 'package'
              : 'path',
          displayName: found.displayName,
        },
      ]);
      log(t`added by hand · ${found.displayName} · ${found.path}`);
      return { ok: true, projectId: found.projectId, displayName: found.displayName };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }

  /** Record where a hand-named project lives, leaving the rest of its table alone. */
  async #rememberRoot(projectId: string, path: string): Promise<void> {
    const file = configPath();
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    await writeConfig(setTomlValues(text, `projects."${projectId}"`, { path }), file);
    // The mtime check in `#refreshTracking` normally picks this up a moment
    // later. Applied here as well because if that read fails — a config the
    // user is halfway through editing — the project would still be followed,
    // with no directory to look in.
    this.#roots = [
      ...this.#roots.filter((r) => r.projectId !== projectId),
      { projectId, path },
    ];
  }

  /**
   * Carry a selection across an identity change.
   *
   * A project's id can change under it — `git init` in a followed directory
   * moves it from `pkg:…` to `git:…` — and the config still names the id that
   * was true when the box was ticked. Left alone the project simply vanishes
   * from the board, which reads as the tool losing it rather than as the
   * ground moving.
   *
   * Applied on read, not written back. The config keeps saying what the user
   * typed; the daemon resolves it the way a name is resolved. The next
   * deliberate change — following or unfollowing anything — writes the
   * resolved list, so the file heals at a moment the user is already editing it
   * rather than behind their back.
   */
  #followMoves(tracking: TrackingConfig): TrackingConfig {
    if (tracking.mode !== 'selected') return tracking;
    const moves = this.#store.identityMoves();
    if (moves.size === 0) return tracking;
    const seen = new Set<string>();
    const selected: string[] = [];
    for (const id of tracking.selected) {
      const to = moves.get(id) ?? id;
      if (seen.has(to)) continue;
      seen.add(to);
      selected.push(to);
      // Once per move, not once per scan: this runs every three seconds.
      if (to !== id && !this.#loggedMoves.has(id + '>' + to)) {
        this.#loggedMoves.add(id + '>' + to);
        log(t`project identity changed · ${id} → ${to}`);
      }
    }
    return { mode: 'selected', selected };
  }

  /**
   * The `[digest]` section, read from disk each time.
   *
   * Not from `#opts` or from anything cached at boot: the daemon never runs a
   * digest, `vt digest` reads the file when a person types it, and a panel
   * that answered from a startup snapshot would describe a decision that
   * command is not going to make. Reading a small TOML file on a click is not
   * a cost worth optimising against correctness.
   */
  async #digest(): Promise<unknown> {
    const { config } = await loadConfig();
    return digestView(config.digest);
  }

  /**
   * Write a provider choice, having first refused the ones a socket may not make.
   *
   * `command` and `args` are never touched — not written, and not cleared when
   * the provider moves away from `cli`. They are inert unless the provider
   * names them, and silently deleting a line somebody typed into their own
   * config file is not this endpoint's business.
   */
  async #setDigest(input: unknown): Promise<
    { ok: true; view: unknown } | { ok: false; reason: string }
  > {
    const choice = validateChoice(input);
    if (!choice.ok) return { ok: false, reason: choice.reason };
    const path = configPath();
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // No config yet — the same reasoning as `#setTracking`: one table beats
      // materialising a template the user never asked for.
    }
    try {
      await writeConfig(
        setTomlValues(text, 'digest', {
          provider: choice.value.provider,
          model: choice.value.model,
          base_url: choice.value.baseUrl,
          api_key_env: choice.value.keyEnv,
        }),
        path,
      );
    } catch {
      return { ok: false, reason: 'failed' };
    }
    // Named in the log because it is the one setting that decides whether
    // anything leaves this machine. The address is included and the key never
    // is; this log is read by `vt doctor --bundle`.
    const where = choice.value.baseUrl ? ` · ${choice.value.baseUrl}` : '';
    log(t`LLM provider changed · ${choice.value.provider}${where}`);
    return { ok: true, view: await this.#digest() };
  }

  async #setTracking(mode: string, selected: string[]): Promise<void> {
    const path = configPath();
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // No config yet: writing this one table beats materialising a template
      // the user never asked for.
    }
    await writeConfig(setTomlValues(text, 'tracking', { mode, selected }), path);
    // Apply immediately rather than waiting for the mtime check, so the very
    // next push already reflects the click that caused it.
    this.#tracking = { mode: mode === 'selected' ? 'selected' : 'all', selected };
    // What was just written *is* the file now, so it is also the raw reading.
    this.#trackingRaw = this.#tracking;
    try {
      this.#trackingStamp = statSync(path).mtimeMs;
    } catch {
      this.#trackingStamp = 0;
    }
    log(t`tracked projects updated · ${mode} · ${selected.length}`);
  }

  /**
   * Pick up a changed project selection without a restart.
   *
   * `vt projects add` writes the config while this process is running, and a
   * dashboard that ignores the change until the next restart would look
   * broken. One `stat` per scan is cheaper than parsing, and the file only
   * changes when a human changes it.
   */
  async #refreshTracking(): Promise<void> {
    let stamp = 0;
    try {
      stamp = statSync(configPath()).mtimeMs;
    } catch {
      stamp = 0; // No config file: defaults, which means everything.
    }
    if (stamp === this.#trackingStamp) {
      // The file has not changed, but the ground under it can: a directory
      // gets a git history and the id in the file stops naming anything. Cheap
      // enough to redo every scan -- two queries over a table with one row per
      // workspace -- and skipped outright while following everything.
      this.#tracking = this.#followMoves(this.#trackingRaw);
      return;
    }
    this.#trackingStamp = stamp;
    try {
      const cfg = (await loadConfig()).config;
      // The user's own secret shapes. Re-applied on every config read rather
      // than once at boot, because adding a pattern to protect something you
      // just noticed should not need a restart to take effect.
      setCustomPatterns(cfg.privacy.custom_patterns);
      this.#trackingRaw = cfg.tracking;
      this.#tracking = this.#followMoves(cfg.tracking);
      // Read from the same file at the same moment: a selection that names a
      // hand-added project while its path is still the previous read's would
      // put the project on the board with no directory to look in.
      this.#roots = configuredRoots(cfg);
      // Picked up on the same read: turning an agent on should not need a
      // restart, and the file's mtime is already the trigger.
      this.#agents = cfg.agents.enabled;
      this.#agentRecencyMs = cfg.thresholds.agent_recency_sec * 1000;
      log(t`tracked projects re-read · ${this.#tracking.mode}`);
    } catch {
      // A broken config must not stop the daemon; the previous selection
      // stands and `vt config check` is where the error belongs.
    }
  }

  async stop(): Promise<void> {
    if (!this.#stopped) log(t`stopping · ${this.#scanCount} scans done`);
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#maintenance) clearInterval(this.#maintenance);
    await this.#server.close();
    await this.#ctx.close();
    this.#store.close();
    try {
      unlinkSync(runtimeFilePath());
    } catch {
      /* already gone */
    }
  }

  #writeRuntimeInfo(): void {
    const info: RuntimeInfo = {
      schemaVersion: 1,
      daemonId: this.#daemonId,
      port: this.#opts.port,
      pid: process.pid,
      token: this.#token,
      startedAt: this.#startedAt,
      version: VERSION,
    };
    // 0600: the token in this file is the only thing standing between a local
    // process and the dashboard.
    writeFileSync(runtimeFilePath(), JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  async #tick(): Promise<void> {
    if (this.#scanning || this.#stopped) return;
    this.#scanning = true;
    this.#phase = 'scan';
    this.#phaseSince = Date.now();
    const t0 = Date.now();
    try {
      // Drain hooks *before* scanning so an event that arrived during the last
      // interval is already reflected in the state we are about to persist.
      this.#phase = 'hooks';
      const raws = this.#ring.drain();
      if (raws.length > 0) this.#hooks.apply(raws);

      // The daemon is the only caller that can answer "has this moved?", so
      // it hands the engine what it remembers. `vt status` passes nothing and
      // the history-dependent detectors stay quiet rather than guess.
      await this.#refreshTracking();

      // Snapshotted before the scan rather than queried inside it: `apply`
      // rewrites these rows at the end of this same cycle, so reading them
      // afterwards would hand the derivation its own output.
      const prevStates = this.#store.stateMap();

      const report = await scan(
        {
          ...this.#scanOpts,
          isTracked: (projectId) => isTracked(this.#tracking, projectId),
          previousState: (sessionId) => prevStates.get(sessionId) ?? null,
          keepClosed:
            this.#tracking.mode === 'selected'
              ? (projectId) => isTracked(this.#tracking, projectId)
              : undefined,
          extraRoots: this.#roots,
          agents: this.#agents,
          agentRecencyMs: this.#agentRecencyMs,
          history: (projectId) => ({
            prior: this.#store.priorProgress(projectId, D5_WINDOW_MS, Date.now()),
            activitySince: this.#store.activitySince(projectId, Date.now() - D5_WINDOW_MS),
          }),
        },
        this.#ctx,
      );

      // Hook facts outrank inference: `PermissionRequest` states outright what
      // the passive layer can only deduce from an unusually long-lived tool.
      this.#phase = 'overlay';
      let hookedSessions = 0;
      for (const p of report.projects) {
        for (const s of p.sessions) {
          if (this.#hooks.overlay(s)) hookedSessions++;
        }
      }
      report.capabilities.hooks = {
        ok: this.#ring.received > 0,
        detail:
          this.#ring.received > 0
            ? t`${this.#ring.received} events · ${hookedSessions} sessions hooked` +
              (this.#ring.dropped > 0 ? t` · ${this.#ring.dropped} DROPPED` : '')
            : tr('no hook event ever arrived (not installed, or disabled)'),
      };
      if (this.#ring.dropped > 0) {
        report.warnings.push(
          t`${this.#ring.dropped} hook events were dropped: the buffer filled. States may be incomplete.`,
        );
      }
      // Repeated on every report rather than logged once at startup. Reaching
      // the whole network is a decision worth being reminded of, and the
      // reminder has to be where the user is looking.
      const wide = bindWarning(this.#opts.host, this.#server.boundPort);
      if (wide) report.warnings.push(wide);

      // Dwell timers come from the store, not from this scan: "waiting for 41
      // minutes" is only answerable because we remember when the state began.
      this.#phase = 'store';
      const changes = this.#store.apply(report);
      // Record what the plans said, so the next scan can tell whether it moved.
      // Only actual changes are written — see `recordProgress`.
      for (const p of report.projects) {
        const pr = p.progress;
        if (!pr) continue;
        this.#store.recordProgress(
          p.projectId,
          {
            percent: pr.percent,
            doneWeight: pr.doneWeight ?? null,
            totalWeight: pr.totalWeight ?? null,
            ordinal: pr.phase?.ordinal ?? null,
            basis: pr.basis,
            phaseLabel: pr.phase?.labelRaw ?? null,
          },
          Date.now(),
        );
      }
      // Momentum: sampled for every project the scan saw, tracked or not, so
      // a project you start following already has a past to draw.
      const now = Date.now();
      for (const p of report.projects) {
        this.#momentum.sample(p.projectId, p.summary.waiting + p.summary.running, now);
        p.momentum = this.#momentum.series(p.projectId, now);
      }

      const since = this.#store.sinceMap();
      for (const p of report.projects) {
        for (const s of p.sessions) {
          const st = since.get(s.sessionId);
          if (st) s.stateSince = st;
        }
      }

      // The last thing a model said, if anybody ever asked one.
      //
      // Read, never produced. `vt digest` is the only writer, because it is
      // the only part of this product that talks to a network and the daemon
      // is deliberately not going to be the second. Attached rather than
      // merged into `progress`: a counted number and a model's reading of one
      // are different claims, and the surfaces draw them differently.
      const digests = this.#store.digests();
      if (digests.size > 0) {
        for (const p of report.projects) {
          const d = digests.get(p.projectId);
          if (d) p.digest = d;
        }
      }

      this.#latest = report;
      this.#lastError = null;
      this.#scanCount++;
      this.#lastScanMs = Date.now() - t0;

      this.#phase = 'broadcast';
      this.#server.broadcast('overview', report);
      for (const c of changes) this.#emitChange(c);
    } catch (err) {
      // Redacted before it is kept. This string is served by `/health`, shown
      // by `vt doctor` and pasted into issues, and a scan failure is usually a
      // filesystem or child-process error carrying whatever it was handed.
      this.#lastError = redactSnippet((err as Error).message, 200);
    } finally {
      this.#scanning = false;
      this.#phase = 'idle';
      this.#phaseSince = Date.now();
    }
  }

  /**
   * Phase board for one project. The root comes from the latest report rather
   * than from the database, because the board reads git and git lives at a
   * path — one that can move between runs.
   */
  async #board(projectId: string): Promise<Board | null> {
    const proj = this.#latest?.projects.find((p) => p.projectId === projectId);
    if (this.#latest && !proj) return null;
    return buildBoard(this.#store, projectId, proj?.workspaces[0]?.normPath ?? null);
  }

  #runMaintenance(): void {
    if (this.#stopped) return;
    this.#phase = 'maintenance';
    try {
      this.#hooks.prune();
      this.#momentum.prune(Date.now());
      // Sessions the last scan no longer saw will never transition again, so
      // their entry can only grow the map.
      if (this.#latest) {
        const seen = new Set(
          this.#latest.projects.flatMap((p) => p.sessions.map((s) => s.sessionId)),
        );
        for (const id of this.#alerted.keys()) if (!seen.has(id)) this.#alerted.delete(id);
      }
      const result = this.#store.maintain();
      this.#lastMaintenance = { ...result, at: Date.now() };
      if (result.hardCapTriggered) {
        log(
          t`the database passed its hard cap; aggressive retention was applied ` +
            t`(${result.transitionsDropped} transitions, ${result.sessionsDropped} sessions deleted)`,
        );
      } else if (result.transitionsDropped > 0 || result.sessionsDropped > 0) {
        log(
          t`maintenance: ${result.transitionsDropped} transitions, ${result.sessionsDropped} sessions ` +
            t`deleted · ${result.ms} ms`,
        );
      }
    } catch (err) {
      // Maintenance failing must never take the daemon down with it: the
      // dashboard is still correct, it just keeps more history than intended.
      this.#lastError = t`maintenance: ${(err as Error).message}`;
    } finally {
      this.#phase = 'idle';
    }
  }

  #emitChange(c: StateChange): void {
    // What may interrupt a person is one rule, in `shared`, read by every
    // surface. This used to include STALLED, which the dashboard then filtered
    // out again -- so the daemon's idea of "worth interrupting for" and the
    // dashboard's disagreed, and each new surface picked one at random.
    if (!interrupts(c.to as SessionStateName)) return;

    // Once is enough.
    //
    // A transition is an edge, and an edge is only worth announcing if the
    // signal under it is steady. Measured here: two sessions crossed
    // BUSY/STALLED 485 times in six hours because their cpu sat on a
    // threshold. The hysteresis in `deriveState` cures that particular noise;
    // this is the floor under every future source of it, because the cost of
    // being wrong is asymmetric -- a late notification is one missed
    // notification, a repeated one teaches the user to ignore all of them.
    //
    // `dwellMs` is how long the session spent in the state it just left, so
    // this reads as: you already heard about this, and it has not been away
    // from it long enough for coming back to be news.
    const last = this.#alerted.get(c.sessionId);
    if (last === c.to && (c.dwellMs ?? Number.POSITIVE_INFINITY) < ALERT_REARM_MS) return;
    this.#alerted.set(c.sessionId, c.to);
    this.#server.broadcast('alert', c);
  }

  /**
   * Better dead than hung.
   *
   * A daemon that stops responding while still holding the port is far worse
   * than one that exits: with hooks installed (M2) an unresponsive HTTP
   * endpoint stalls every agent session, whereas a dead daemon refuses the
   * connection instantly and costs nothing. So we measure event-loop lag and
   * exit if it goes unresponsive — after logging what we were doing, because an
   * unexplained exit in someone else's daemon is its own kind of failure.
   */
  #startWatchdog(): void {
    let last = Date.now();
    const period = 250;
    this.#watchdog = setInterval(() => {
      const now = Date.now();
      const lag = now - last - period;
      last = now;
      if (lag > 2000) {
        const stuckFor = now - this.#phaseSince;
        log(
          t`the event loop blocked for ${lag}ms, phase="${this.#phase}" ` +
            t`(in this phase for ${stuckFor}ms) · scan #${this.#scanCount} · ` +
            t`${Math.round(process.memoryUsage().rss / 1048576)} MB RSS. ` +
            t`Exiting rather than hanging.`,
        );
        process.exit(1);
      }
    }, period);
    this.#watchdog.unref();
  }
}

// Plain fields rather than parameter properties: parameter properties emit
// runtime code from a type position, which Node's type-stripping loader cannot
// handle. `erasableSyntaxOnly` in tsconfig is what caught this.
export class AlreadyRunningError extends Error {
  daemonId: string;
  port: number;
  constructor(daemonId: string, port: number) {
    super(t`VibeTracker is already running (port ${port}, id ${daemonId})`);
    this.daemonId = daemonId;
    this.port = port;
  }
}

export class PortTakenError extends Error {
  port: number;
  constructor(port: number) {
    super(
      t`Port ${port} is held by another program. ` +
        t`Hook URLs are fixed, so VibeTracker never moves to another port quietly.`,
    );
    this.port = port;
  }
}

/** Ask whatever holds the port whether it is one of ours. */
async function probeExisting(
  port: number,
): Promise<{ ok: boolean; daemonId?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; daemonId?: string };
    return body?.ok === true && typeof body.daemonId === 'string'
      ? { ok: true, daemonId: body.daemonId }
      : null;
  } catch {
    return null; // Nothing there, or not speaking our protocol.
  }
}

export { Store };
export { existsSync };
export {
  loadOrCreateHookToken,
  readHookToken,
  hookTokenPath,
  loadOrCreateApiToken,
  readApiToken,
  apiTokenPath,
} from './tokens.ts';
export { HookRing } from './hooks/ring.ts';
export { HookIngest, type SessionHookState } from './hooks/ingest.ts';
