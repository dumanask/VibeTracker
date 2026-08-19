import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  allAdapters,
  noteText,
  scan,
  ScanContext,
  type DetectResult,
  cliProgram,
} from '@vibetracker/engine';
import {
  claudeDir,
  configDir,
  createProcessProbe,
  dataDir,
  findBrowser,
  listVoices,
  otherAgentDirs,
  speaksLanguage,
  vscodeUserDirs,
} from '@vibetracker/platform';
import { DEFAULT_PORT, readRuntimeInfo } from '@vibetracker/daemon';
import { t, hasComments, tr, getLang, fmtAge } from '@vibetracker/core';
import { autostartStatus } from './autostart.ts';

const exec = promisify(execFile);

/**
 * `vt doctor` answers one question: which of the things this tool claims to do
 * actually work on THIS machine?
 *
 * Two rules keep it honest. It never reports a capability as broken when the
 * real answer is "not built yet" or "not installed" — those are different
 * problems with different fixes, and conflating them sends people hunting for
 * a bug that does not exist. And every degraded result carries the reason, not
 * just the verdict: "permission detection unavailable — no hooks installed" is
 * actionable, "permission detection unavailable" is not.
 */

export type Status = 'ok' | 'warn' | 'fail' | 'todo' | 'info';

export interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  /** What the user can do about it, when there is something. */
  fix?: string;
}

const GLYPH: Record<Status, string> = {
  ok: '✔',
  warn: '!',
  fail: '✖',
  todo: '·',
  info: 'ℹ',
};

const MIN_NODE = [22, 20] as const;

/**
 * Run every check. Split out from `runDoctor` because `vt doctor --bundle`
 * needs the results as data, and a diagnostic bundle assembled from parsed
 * terminal output would go stale the first time a label changed.
 */
export async function collectChecks(): Promise<{ checks: Check[]; projectPaths: string[] }> {
  const checks: Check[] = [];
  const projectPaths: string[] = [];
  const ctx = new ScanContext();
  try {
    checks.push(checkNode());
    checks.push(...(await checkProbe(ctx)));
    checks.push(...(await checkAgentDir()));
    checks.push(await checkTranscriptRead());
    checks.push(...(await checkScan(ctx)));
    checks.push(await checkGit());
    checks.push(checkDataDir());
    checks.push(...(await checkDaemon()));
    checks.push(await checkAutostart());
    checks.push(...(await checkHooks()));
    checks.push(...(await checkOtherAgents(ctx)));
    checks.push(checkMiniWindow());
    checks.push(await checkVoice());
    checks.push(await checkDigest());
    checks.push(checkWriteSafety());
  } finally {
    await ctx.close();
  }
  for (const p of SEEN_PATHS) projectPaths.push(p);
  SEEN_PATHS.length = 0;
  return { checks, projectPaths };
}

export async function runDoctor(json: boolean): Promise<number> {
  const { checks } = await collectChecks();

  if (json) {
    process.stdout.write(JSON.stringify({ generatedAt: Date.now(), checks }, null, 2) + '\n');
  } else {
    process.stdout.write(render(checks));
  }
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

// ── checks ────────────────────────────────────────────────────────────────

function checkNode(): Check {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return {
    id: 'node',
    label: tr('Node version'),
    status: ok ? 'ok' : 'fail',
    detail: t`${process.version} (needs ≥ v${MIN_NODE[0]}.${MIN_NODE[1]})`,
    fix: ok
      ? undefined
      : tr("node:sqlite and running TypeScript without a build step require this version."),
  };
}

async function checkProbe(ctx: ScanContext): Promise<Check[]> {
  const probe = ctx.probe();
  const t0 = performance.now();
  let err: string | null = null;
  let seen = 0;
  try {
    seen = (await probe.snapshot([process.pid])).size;
  } catch (e) {
    err = (e as Error).message;
  }
  const ms = Math.round(performance.now() - t0);

  const out: Check[] = [
    {
      id: 'probe',
      label: tr('Process probe'),
      status: err ? 'fail' : seen > 0 ? 'ok' : 'warn',
      detail: err
        ? `${probe.kind}: ${err}`
        : t`${probe.kind} · first answer ${ms} ms · our own PID ${seen > 0 ? tr('seen') : tr('NOT SEEN')}`,
      fix: err ? tr('Liveness detection falls back to "does the PID exist".') : undefined,
    },
  ];

  const precision = probe.precision;
  out.push({
    id: 'pid-reuse',
    label: tr('PID-reuse guard'),
    status: precision === 'exact' ? 'ok' : precision === 'second' ? 'warn' : 'fail',
    detail:
      precision === 'exact'
        ? tr('exact (start time compares bit for bit)')
        : precision === 'second'
          ? tr('one-second resolution — a PID recycled within the same second can slip through')
          : tr('none — start time cannot be read on this platform'),
    fix: precision === 'exact' ? undefined : tr('A platform limit; there is nothing to fix on your side.'),
  });
  return out;
}

async function checkAgentDir(): Promise<Check[]> {
  const dir = claudeDir();
  const out: Check[] = [];
  const override = !!process.env.CLAUDE_CONFIG_DIR?.trim();

  if (!existsSync(dir)) {
    out.push({
      id: 'agent-dir',
      label: tr('Agent state directory'),
      status: 'fail',
      detail: t`${dir} not found`,
      fix: tr('Is Claude Code installed? If it lives elsewhere, point at it with $CLAUDE_CONFIG_DIR.'),
    });
    return out;
  }
  out.push({
    id: 'agent-dir',
    label: tr('Agent state directory'),
    status: 'ok',
    detail: dir + (override ? tr(' ($CLAUDE_CONFIG_DIR)') : ''),
  });

  const count = async (sub: string, ext: string): Promise<number> => {
    try {
      return (await readdir(join(dir, sub))).filter((f) => f.endsWith(ext)).length;
    } catch {
      return -1;
    }
  };
  const sessions = await count('sessions', '.json');
  const locks = await count('ide', '.lock');
  // A directory that has never held a session is a different situation from
  // one whose format we can no longer read, and the two want opposite
  // responses: "run the agent once" versus "this build is behind the agent".
  // Reporting both as a failure sends first-time users hunting for a bug that
  // is not there.
  const virgin = sessions < 0 && !existsSync(join(dir, 'projects'));

  out.push({
    id: 'session-registry',
    label: tr('Session registry'),
    status: sessions > 0 ? 'ok' : virgin ? 'todo' : sessions === 0 ? 'warn' : 'fail',
    detail: virgin
      ? tr('no sessions yet — this directory is new')
      : sessions >= 0
        ? sessions === 1
          ? t`${sessions} record in sessions/`
          : t`${sessions} records in sessions/`
        : tr('sessions/ unreadable'),
    fix: virgin
      ? tr('Run `claude` once; the dashboard starts populated next time.')
      : sessions === 0
        ? tr('No session records at all. Run `claude` once and look again.')
        : sessions < 0
          ? tr('This file is undocumented; your Claude Code version may no longer write it.')
          : undefined,
  });
  out.push({
    id: 'ide-locks',
    label: tr('IDE windows'),
    status: locks > 0 ? 'ok' : 'info',
    detail:
      locks < 0
        ? tr('ide/ unreadable')
        : locks === 1
          ? t`${locks} lock in ide/`
          : t`${locks} locks in ide/`,
    fix: locks === 0 ? tr('No IDE window open; window grouping is disabled.') : undefined,
  });

  // Not a capability check — a standing reminder of what lives next to the data
  // we read, and why the diagnostics bundle is allowlist-based (M4).
  const cred = join(dir, '.credentials.json');
  if (existsSync(cred)) {
    out.push({
      id: 'credentials',
      label: tr('Credentials file'),
      status: 'info',
      detail: t`${cred} present — VibeTracker never opens this file`,
    });
  }
  return out;
}

/**
 * The single most important performance number on Windows.
 *
 * Defender scans at CreateFile, and the measured cost on a 518 MB transcript was
 * ~310 ms per open with no difference between cold and warm. That is why the
 * daemon holds descriptors open; this check reports what opening actually costs
 * here, so a user on a machine with a more aggressive scanner sees the reason
 * their polls are slow instead of guessing.
 */
async function checkTranscriptRead(): Promise<Check> {
  const projects = join(claudeDir(), 'projects');
  let biggest: { path: string; size: number } | null = null;
  try {
    for (const slug of await readdir(projects)) {
      const sub = join(projects, slug);
      let files: string[];
      try {
        files = await readdir(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(sub, f);
        try {
          const size = statSync(p).size;
          if (!biggest || size > biggest.size) biggest = { path: p, size };
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  } catch {
    return {
      id: 'transcript-read',
      label: tr('Transcript reading'),
      status: 'warn',
      detail: tr('projects/ unreadable'),
    };
  }
  if (!biggest) {
    return {
      id: 'transcript-read',
      label: tr('Transcript reading'),
      status: 'info',
      detail: tr('no transcripts yet'),
    };
  }

  // Two opens of the same file: if the second is no faster than the first, the
  // cost is a scanner, not the page cache.
  const timeOpen = async (): Promise<number> => {
    const t0 = performance.now();
    const h = await open(biggest!.path, 'r');
    const buf = Buffer.allocUnsafe(256 * 1024);
    await h.read(buf, 0, buf.length, Math.max(0, biggest!.size - buf.length));
    await h.close();
    return performance.now() - t0;
  };
  const first = await timeOpen();
  const second = await timeOpen();
  const mb = (biggest.size / 1048576).toFixed(0);
  const slow = Math.min(first, second) > 50;

  return {
    id: 'transcript-read',
    label: tr('Transcript reading'),
    status: slow ? 'warn' : 'ok',
    detail:
      t`largest file ${mb} MB · 256 KB tail open ` +
      t`${first.toFixed(0)} ms → ${second.toFixed(0)} ms`,
    fix: slow
      ? tr('Open cost is high (an antivirus scan, most likely). The daemon pays it once ') +
        tr('because it keeps handles open; a one-shot `vt status` pays it every time.')
      : undefined,
  };
}

/**
 * Project roots observed during the scan, so `--bundle` can report their
 * *shape* without a second scan. Never the names — see `aliasPath`.
 */
const SEEN_PATHS: string[] = [];

async function checkScan(ctx: ScanContext): Promise<Check[]> {
  const t0 = performance.now();
  const report = await scan(
    { cpuSample: false, cpuSampleMs: 0, includeDead: true, includeTemp: true, tailBytes: 262144 },
    ctx,
  );
  const ms = Math.round(performance.now() - t0);
  const c = report.counts;
  for (const p of report.projects) {
    for (const w of p.workspaces) SEEN_PATHS.push(w.rawPathSample);
  }

  const out: Check[] = [
    {
      id: 'scan',
      label: tr('Full scan'),
      status: 'ok',
      detail:
        t`${ms} ms · ${c.registryEntries} records → ${c.live} live / ${c.dead} dead / ` +
        t`${c.reused} PID reuse · ${c.projects} projects`,
    },
  ];

  const guard = report.capabilities.pidReuseGuard;
  if (guard && !guard.ok) {
    out.push({
      id: 'pid-reuse-data',
      label: tr('PID-reuse data'),
      status: 'warn',
      detail: guard.detail ?? tr('the guard could not be applied'),
      fix: tr('The agent writes no comparable start time, or its format changed. Sessions were counted as live.'),
    });
  }
  for (const w of report.warnings) {
    out.push({ id: 'warning', label: tr('Scan warning'), status: 'warn', detail: w });
  }
  return out;
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await exec('git', ['--version'], { timeout: 5000 });
    return {
      id: 'git',
      label: 'git',
      status: 'ok',
      detail: stdout.trim(),
    };
  } catch {
    return {
      id: 'git',
      label: 'git',
      status: 'warn',
      detail: tr('not found'),
      fix:
        tr('Project identity falls back to the package name or the path instead of the root commit: two ') +
        tr('copies of one project may appear as separate cards. Branch and dirty counts are not shown.'),
    };
  }
}

/**
 * Which model, if any, and whether the answer is honest about egress.
 *
 * Here because "what LLM is this using?" is a question a person is entitled to
 * be able to answer without reading the source, and because the honest answer
 * for most installs is "none, and nothing is sent" -- which is worth saying
 * out loud rather than leaving as an absence.
 */
async function checkDigest(): Promise<Check> {
  const { loadConfig: load } = await import('@vibetracker/platform');
  const {
    resolveKey: resolve,
    needsKey: wants,
    egress: where_,
    isCliProvider: isCli,
    DEFAULT_BASE: bases,
    DEFAULT_MODEL: models,
  } = await import('@vibetracker/engine');
  const { whichCommand: which } = await import('@vibetracker/platform');
  let cfg;
  try {
    ({ config: cfg } = await load());
  } catch {
    return { id: 'digest', label: tr('LLM summary'), status: 'info', detail: tr('the configuration could not be read') };
  }
  const d = cfg.digest;
  if (d.provider === 'off') {
    return {
      id: 'digest',
      label: tr('LLM summary'),
      status: 'info',
      detail: tr('off — every number is computed locally, nothing is sent'),
      fix: tr('If you want to turn it on, the options are: vt digest providers'),
    };
  }
  const cli = isCli(d.provider);
  const base = cli ? '' : d.base_url || bases[d.provider as 'anthropic' | 'openai' | 'ollama'] || '';
  const model = d.model || models[d.provider];
  const key = resolve(d.provider, d.api_key_env);
  const out = where_({
    provider: d.provider,
    model,
    baseUrl: d.base_url,
    apiKey: key.key,
    command: d.command,
    args: d.args,
  });
  const where =
    out === 'yes'
      ? tr('data leaves the machine')
      : out === 'no'
        ? tr('data does not leave the machine')
        : tr('whether data leaves is unknown');

  // A configured provider that names a program nobody can run is a failure
  // that would otherwise wait until the day somebody actually wanted a
  // summary. It is exactly what a doctor is for.
  if (cli) {
    const exe =
      cliProgram(d);
    const path = exe ? which(exe) : null;
    if (!exe) {
      return {
        id: 'digest',
        label: tr('LLM summary'),
        status: 'warn',
        detail: `${d.provider} · ${tr('no command set')}`,
        fix: tr('Set [digest] command in the config file, or: vt digest providers'),
      };
    }
    if (!path) {
      return {
        id: 'digest',
        label: tr('LLM summary'),
        status: 'warn',
        detail: `${d.provider} · "${exe}" ${tr("not found on PATH")}`,
        fix: tr('Install it, or pick another provider: vt digest providers'),
      };
    }
    return {
      id: 'digest',
      label: tr('LLM summary'),
      status: 'ok',
      detail: `${d.provider} · ${path}${model ? ' · ' + model : ''} · ${where}`,
    };
  }

  if (wants(d.provider, d.base_url) && key.key === null) {
    return {
      id: 'digest',
      label: tr('LLM summary'),
      status: 'warn',
      detail: `${d.provider} · ${model} · ${tr('no key')}`,
      fix: t`Set ${key.envName ?? tr('an environment variable')}, or: vt digest key <key>`,
    };
  }
  return {
    id: 'digest',
    label: tr('LLM summary'),
    status: 'ok',
    detail: `${d.provider} · ${model}${base ? ' · ' + base : ''} · ${where}`,
  };
}

function checkDataDir(): Check {
  const dir = dataDir();
  const db = join(dir, 'vibetracker.db');
  if (!existsSync(db)) {
    return {
      id: 'db',
      label: tr('Database'),
      status: 'info',
      detail: t`${db} does not exist yet (the first \`vt daemon\` creates it)`,
    };
  }
  const size = statSync(db).size;
  const wal = existsSync(db + '-wal') ? statSync(db + '-wal').size : 0;
  return {
    id: 'db',
    label: tr('Database'),
    status: size > 500 * 1024 * 1024 ? 'warn' : 'ok',
    detail: t`${(size / 1048576).toFixed(1)} MB (+${(wal / 1048576).toFixed(1)} MB WAL) · ${db}`,
    fix: size > 500 * 1024 * 1024 ? tr('The hard cap is exceeded; the daemon switches to aggressive retention.') : undefined,
  };
}

async function checkDaemon(): Promise<Check[]> {
  const info = readRuntimeInfo();
  const port = info?.port ?? DEFAULT_PORT;

  let health: Record<string, unknown> | null = null;
  let foreign = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      // The identity half of this endpoint is open; the diagnostic half is not,
      // and a doctor that could not show it would be reporting on a daemon it
      // was refusing to ask. The token is in the runtime file we just read.
      headers: info ? { 'X-VT-Token': info.token } : {},
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (body?.ok === true && typeof body.daemonId === 'string') health = body;
    else foreign = true;
  } catch {
    /* nothing listening */
  }

  if (health) {
    // The identity half of the answer is open to anyone; the numbers are not.
    // Without them there is nothing to report but the fact that something of
    // ours is there -- printing a formatted line anyway put `{2}` on screen
    // where a count goes, and `up 0 min`, which reads like a measurement.
    if (health.scans === undefined) {
      return [
        {
          id: 'daemon',
          label: 'Daemon',
          status: 'warn',
          detail: t`port ${port} · a VibeTracker daemon that did not accept our token`,
          fix: tr('It is probably running under another profile or data directory; its own `vt doctor` can see it.'),
        },
      ];
    }
    const up = Math.round(Number(health.uptimeMs ?? 0) / 60000);
    const tail = health.transcripts as { openHandles?: number; skipped?: number; reads?: number } | undefined;
    const out: Check[] = [
      {
        id: 'daemon',
        label: 'Daemon',
        status: health.lastError ? 'warn' : 'ok',
        detail:
          t`port ${port} · up ${up} min · ${health.scans} scans · ` +
          t`last ${health.lastScanMs} ms · ${health.rssMb} MB RSS` +
          (health.lastError ? t` · last error: ${health.lastError}` : ''),
      },
    ];

    // Reaching the network is exactly the kind of thing a person runs
    // `vt doctor` to find out about, and exactly the kind of thing a config
    // file set months ago stops reminding them of.
    const bind = typeof health.bind === 'string' ? health.bind : '127.0.0.1';
    if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
      out.push({
        id: 'bind',
        label: tr('Reach'),
        status: 'warn',
        detail: t`listening on ${bind} — anyone on this network can reach the dashboard`,
        fix: tr('for this machine only, set bind = "127.0.0.1" under [server]'),
      });
    }
    if (tail) {
      out.push({
        id: 'tail-cache',
        label: tr('Transcript handles'),
        status: 'ok',
        detail: t`${tail.openHandles} open · ${tail.reads} reads / ${tail.skipped} unchanged`,
      });
    }
    return out;
  }

  return [
    {
      id: 'daemon',
      label: 'Daemon',
      status: foreign ? 'fail' : 'info',
      detail: foreign
        ? t`port ${port} is held by another program`
        : t`not running (port ${port} is free)`,
      fix: foreign
        ? tr("Hook URLs are fixed, so VibeTracker never moves to another port quietly. Stop that program, or move with --port.")
        : tr('Start it with `vt daemon --open`.'),
    },
  ];
}

async function checkAutostart(): Promise<Check> {
  const st = await autostartStatus();
  return {
    id: 'autostart',
    label: tr('Autostart'),
    // "Installed" is not the same as "will start". A systemd unit that was
    // written but never enabled, and a task left pointing at a checkout that
    // has moved, both exist and both start nothing -- and a tick beside either
    // is this file telling the user the opposite of the truth.
    status: !st.supported
      ? 'todo'
      : !st.installed
        ? 'info'
        : st.stale || st.active === false
          ? 'warn'
          : 'ok',
    detail: st.detail,
    fix:
      st.supported && (!st.installed || st.stale || st.active === false)
        ? tr('Install it with `vt autostart install`.')
        : undefined,
  };
}

/**
 * Hooks have four ways to be "installed but doing nothing", and each has a
 * different fix. Reporting them as one line would send people looking in the
 * wrong place:
 *
 * - not installed at all
 * - installed, but the settings file is invalid so the agent ignores all of it
 * - installed, but a policy setting disables hooks
 * - installed and enabled, but nothing has ever fired
 */
async function checkHooks(): Promise<Check[]> {
  const settings = join(claudeDir(), 'settings.json');
  let raw: string | null = null;
  try {
    raw = await readFile(settings, 'utf8');
  } catch {
    /* no settings file yet */
  }

  const out: Check[] = [];
  const installed = raw?.includes('"_vt"') ?? false;

  if (raw && hasComments(raw)) {
    out.push({
      id: 'settings-json',
      label: tr('Settings file'),
      status: 'fail',
      detail: t`${settings} contains comment lines`,
      fix:
        tr('Claude Code reads this file as strict JSON and ignores the whole file when it sees a comment — ') +
        tr('so none of these settings are in force. To verify: claude doctor'),
    });
  }

  // These three settings each silently neutralize hooks. A user who set one
  // months ago will not connect it to "the dashboard never shows permissions".
  for (const [key, label] of [
    ['disableAllHooks', tr('all hooks are disabled')],
    ['allowManagedHooksOnly', tr('only managed hooks are allowed')],
    ['allowedHttpHookUrls', tr('an HTTP hook URL allowlist is present')],
  ] as const) {
    if (raw && new RegExp(`"${key}"`).test(raw)) {
      out.push({
        id: `setting-${key}`,
        label: tr('Hook policy'),
        status: 'warn',
        detail: `${key}: ${label}`,
        fix:
          key === 'allowedHttpHookUrls'
            ? t`If ${hookUrlFor()} is not on the list the agent blocks our hook ("HTTP hook blocked").`
            : tr('While this setting is on, our hooks never run.'),
      });
    }
  }

  if (!installed) {
    out.push({
      id: 'hooks',
      label: tr('Waiting-for-permission detection'),
      status: 'todo',
      detail: tr('no hooks installed — inferred from the process tree and the tool class'),
      fix: tr('`vt hooks install` gives exact detection (permission prompts, turn ends, subagents).'),
    });
    return out;
  }

  // Installed: now ask the daemon whether anything has actually arrived.
  interface HookHealthShape {
    hooks?: { received?: number; dropped?: number; byEvent?: Record<string, number> };
  }
  let health: HookHealthShape | null = null;
  try {
    const info = readRuntimeInfo();
    const res = await fetch(`http://127.0.0.1:${info?.port ?? DEFAULT_PORT}/api/v1/health`, {
      headers: info ? { 'X-VT-Token': info.token } : {},
      signal: AbortSignal.timeout(1500),
    });
    health = (await res.json()) as HookHealthShape;
  } catch {
    /* daemon not running */
  }

  const received = health?.hooks?.received ?? 0;
  out.push({
    id: 'hooks',
    label: tr('Waiting-for-permission detection'),
    status: !health ? 'info' : received > 0 ? 'ok' : 'warn',
    detail: !health
      ? tr('hooks installed; the event stream could not be checked because the daemon is not running')
      : received > 0
        ? t`${received} events received · ${Object.keys(health?.hooks?.byEvent ?? {}).length} distinct types` +
          ((health?.hooks?.dropped ?? 0) > 0 ? t` · ${health?.hooks?.dropped} DROPPED` : '')
        : tr('hooks installed but no event ever arrived'),
    fix:
      health && received === 0
        ? tr('Existing agent sessions read settings at startup — start a new session. ') +
          tr('If it persists: verify the settings file with claude doctor.')
        : undefined,
  });
  return out;
}

function hookUrlFor(): string {
  return `http://127.0.0.1:${DEFAULT_PORT}/h/v1`;
}

/**
 * One row per agent: what it can be read for, and where a capability stops.
 *
 * Deliberately does not collapse to a single line. The whole point of the
 * matrix is that "Codex found" and "Codex found, and its sessions have no pid
 * so liveness is a 90-second window" are different sentences, and only the
 * second one lets a user judge what the board is telling them.
 *
 * The counts come from the adapters themselves rather than from a scan, because
 * `listProjectHints` is the expensive call the poll deliberately never makes —
 * ~200 ms for Codex's 231 rollouts. A diagnostic can afford it; a poll cannot.
 */
async function checkOtherAgents(ctx: ScanContext): Promise<Check[]> {
  const out: Check[] = [];
  const dirs = new Set([
    ...otherAgentDirs().map((a) => a.id),
    ...vscodeUserDirs().map((v) => v.id),
  ]);
  const adapters = allAdapters(() => ctx.tail());
  const results = await Promise.all(
    adapters.map(async (a) => {
      try {
        const detect = await a.detect();
        const hints = detect.installed ? (await a.listProjectHints()).length : 0;
        return { a, detect, hints };
      } catch (err) {
        const detect: DetectResult = { installed: false, hasData: false, lastActivityAt: 0 };
        return { a, detect, hints: 0, error: (err as Error).message };
      }
    }),
  );

  for (const { a, detect, hints, error } of results as Array<
    (typeof results)[number] & { error?: string }
  >) {
    const caps = a.capabilities;
    if (!detect.installed) {
      // Not an error and not a warning: an agent nobody installed is simply not
      // here, and saying so beats omitting the row and leaving the user to
      // wonder whether we looked.
      out.push({
        id: `agent-${a.id}`,
        label: a.displayName,
        status: 'todo',
        detail: tr('not installed'),
      });
      continue;
    }
    const bits: string[] = [];
    bits.push(caps.sessions ? t`folders: ${hints}` : t`folders: ${hints} · sessions not read`);
    if (caps.sessions) {
      bits.push(caps.liveProcess ? tr('liveness: pid') : tr('liveness: last write'));
      if (caps.turnState) bits.push(tr('turn state'));
      if (caps.openTools) bits.push(tr('open tools'));
    }
    if (detect.lastActivityAt > 0) {
      bits.push(t`last ${fmtAge(Date.now() - detect.lastActivityAt)} ago`);
    }
    if (error) bits.push(error);
    // The note goes in the detail, not in `fix`. `fix` renders as an arrow and
    // reads as an instruction, and "installed but never used" is not something
    // the user is supposed to go and do anything about.
    if (detect.note) bits.push(noteText(detect.note));
    out.push({
      id: `agent-${a.id}`,
      label: a.displayName,
      status: error ? 'warn' : detect.hasData ? 'ok' : 'todo',
      detail: bits.join(' · '),
    });
  }

  // Any state directory we found but have no adapter for. The list of agents is
  // open-ended, and silently ignoring one is how a tool starts lying about its
  // coverage.
  const known = new Set(adapters.map((a) => a.id));
  const unknown = [...dirs].filter((d) => !known.has(d));
  if (unknown.length > 0) {
    out.push({
      id: 'agent-unadapted',
      label: tr('Agents with no adapter'),
      status: 'todo',
      detail: unknown.join(', '),
    });
  }
  return out;
}

/**
 * The corner of the screen that answers "is anything waiting for me".
 *
 * Three different things wear that name and a user is entitled to know which
 * one they are going to get. Windows has a painted WinForms panel. Everywhere
 * else `vt mini` opens a Chromium `--app` window that it cannot put on top,
 * because pinning a foreign window is `SetWindowPos` and that is Win32 — and
 * a note that sinks behind the editor is not a note. The desktop app owns its
 * own window and can ask for always-on-top on all three platforms, so on macOS
 * and Linux it is the real answer rather than a consolation.
 *
 * Checked here because the failure is otherwise found at the worst moment: a
 * machine with no Chromium-family browser produces "could not open a window" from a
 * command the user ran expecting a window.
 */
function checkMiniWindow(): Check {
  const browser = findBrowser();
  if (process.platform === 'win32') {
    return {
      id: 'mini',
      label: tr('Sticky-note window'),
      status: 'ok',
      detail: tr('built-in panel · stays on top · vt mini'),
    };
  }
  if (!browser) {
    return {
      id: 'mini',
      label: tr('Sticky-note window'),
      status: 'warn',
      detail: tr('no Chromium-family browser found'),
      fix: tr('Install Chrome/Chromium/Brave/Edge, or use the desktop app.'),
    };
  }
  return {
    id: 'mini',
    label: tr('Sticky-note window'),
    status: 'warn',
    detail: `${browser.family} · ${browser.path} · ${tr('cannot be kept on top')}`,
    fix: tr('For a real sticky note that stays on top, use the desktop app: tray menu → Post-it.'),
  };
}

/**
 * Can the note say a project's name in the interface language?
 *
 * Reported rather than fixed, because the fix is not ours to make: voices are
 * installed in Windows, and a monitoring tool downloading a speech package
 * would be exactly the kind of thing it must never do. What it can do is stop
 * the failure being silent — an English voice reading Turkish is understandable
 * enough that a user may never realise a matching voice was available.
 */
async function checkVoice(): Promise<Check> {
  if (process.platform !== 'win32') {
    return {
      id: 'voice',
      label: tr('Spoken alerts'),
      status: 'todo',
      detail: tr('only the Windows sticky note speaks'),
    };
  }
  const report = await listVoices();
  if (!report.supported) {
    return {
      id: 'voice',
      label: tr('Spoken alerts'),
      status: 'warn',
      detail: report.error
        ? t`speech engine unreadable: ${report.error}`
        : tr('no voices installed — the window stays silent'),
      fix: tr('Add a voice under Settings -> Time & language -> Speech.'),
    };
  }
  const lang = getLang();
  const match = speaksLanguage(report, lang);
  // The gap between the two registries, stated as a number: this is what tells
  // someone that a voice they installed is visible to the engine we use and
  // invisible to the one .NET ships with.
  const engines = t`${report.engine} · WinRT ${report.winrtCount} / SAPI5 ${report.sapiCount} voices`;
  if (match) {
    return {
      id: 'voice',
      label: tr('Spoken alerts'),
      status: 'ok',
      detail: t`${match.name} (${match.lang}) · ${engines}`,
    };
  }
  const alt = lang === 'tr' ? 'en' : 'tr';
  const fallback = speaksLanguage(report, alt);
  return {
    id: 'voice',
    label: tr('Spoken alerts'),
    status: 'warn',
    detail: fallback
      ? t`no ${lang} voice — the line is read in ${alt} by ${fallback.name} · ${engines}`
      : t`no ${lang} voice — read with the system default · ${engines}`,
    fix: t`Add a ${lang} voice under Settings -> Time & language -> Speech.`,
  };
}

function checkWriteSafety(): Check {
  const agent = claudeDir();
  const ours = [dataDir(), configDir()];
  const overlap = ours.some((p) => p.toLowerCase().startsWith(agent.toLowerCase()));
  return {
    id: 'write-safety',
    label: tr('Write safety'),
    status: overlap ? 'fail' : 'ok',
    detail: overlap
      ? tr('VibeTracker data lives INSIDE the agent state directory — it must not')
      : t`agent directory read-only · we write only to ${ours[0]}`,
    fix: overlap ? tr("Move the data directory; the agent transcripts are irreplaceable.") : undefined,
  };
}

// ── render ────────────────────────────────────────────────────────────────

function render(checks: Check[]): string {
  const useColor =
    process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (s: Status, text: string): string => {
    if (!useColor) return text;
    const code = { ok: '32', warn: '33', fail: '31', todo: '2', info: '36' }[s];
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const dim = (t: string): string => (useColor ? `\u001b[2m${t}\u001b[0m` : t);

  const width = Math.max(...checks.map((c) => c.label.length));
  const out: string[] = ['', t` VibeTracker doctor ${dim('·')} ${process.platform}-${process.arch}`, ''];
  for (const c of checks) {
    out.push(` ${paint(c.status, GLYPH[c.status])} ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.fix) out.push(`   ${' '.repeat(width)}  ${dim('→ ' + c.fix)}`);
  }

  const n = (s: Status): number => checks.filter((c) => c.status === s).length;
  out.push('');
  out.push(
    t` ${n('ok')} ok ${dim('·')} ${n('warn')} warnings ${dim('·')} ${n('fail')} errors ` +
      t`${dim('·')} ${n('todo')} not built yet`,
  );
  out.push('');
  return out.join('\n');
}
