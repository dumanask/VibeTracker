#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scan, type ScanOptions } from '@vibetracker/engine';
import { loadLang, missingKeys, resolveLang, setCustomPatterns, t } from '@vibetracker/core';
import { usage } from './usage.ts';
import { loadConfig } from '@vibetracker/platform';
import { configuredRoots, isTracked } from '@vibetracker/core';
import { renderCompact, renderHtml, renderText } from './render.ts';

// The help text lives in `usage.ts`, as rows: see the note there for why a
// single block was the wrong shape once translation existed.

interface Args {
  command: string;
  /** Second positional word, for commands that take one (`autostart install`). */
  sub?: string;
  /** Positional words after the subcommand, e.g. the project names to add. */
  operands?: string[];
  html?: string;
  json: boolean;
  all: boolean;
  temp: boolean;
  quick: boolean;
  tailKb: number;
  help: boolean;
  signalWaiting: boolean;
  open: boolean;
  yes: boolean;
  /** Build the payload and show it, but never send it. */
  dryRun: boolean;
  highFidelity: boolean;
  port?: number;
  intervalMs?: number;
  bundle: boolean;
  bundleOut?: string;
  lang?: string;
  force: boolean;
  keepData: boolean;
  /** Ignore the tracking selection for this run. */
  every: boolean;
  /** The detailed per-session view instead of one line per project. */
  full: boolean;
  noPin: boolean;
  unpin: boolean;
  browser: boolean;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'status',
    json: false,
    all: false,
    temp: false,
    quick: false,
    tailKb: 256,
    help: false,
    dryRun: false,
    signalWaiting: false,
    open: false,
    yes: false,
    highFidelity: false,
    bundle: false,
    force: false,
    keepData: false,
    every: false,
    full: false,
    noPin: false,
    unpin: false,
    browser: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--every':
        args.every = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--no-pin':
        args.noPin = true;
        break;
      case '--unpin':
        args.unpin = true;
        break;
      case '--browser':
        args.browser = true;
        break;
      case '--size': {
        // `--size 360x260`, one flag because width and height are one decision.
        const m = /^(\d{2,5})[x,](\d{2,5})$/.exec(argv[++i] ?? '');
        if (m) {
          args.width = Number(m[1]);
          args.height = Number(m[2]);
        }
        break;
      }
      case '--at': {
        const m = /^(-?\d{1,5})[,x](-?\d{1,5})$/.exec(argv[++i] ?? '');
        if (m) {
          args.x = Number(m[1]);
          args.y = Number(m[2]);
        }
        break;
      }
      case '--temp':
        args.temp = true;
        break;
      case '--quick':
        args.quick = true;
        break;
      case '--signal-waiting':
        args.signalWaiting = true;
        break;
      case '--open':
        args.open = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '-y':
      case '--yes':
        args.yes = true;
        break;
      case '--high-fidelity':
        args.highFidelity = true;
        break;
      case '--lang':
        args.lang = argv[++i];
        break;
      case '--force':
        args.force = true;
        break;
      case '--keep-data':
        args.keepData = true;
        break;
      case '--bundle': {
        args.bundle = true;
        // The filename is optional: `--bundle` alone must not swallow the
        // next flag as a path.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) args.bundleOut = argv[++i];
        break;
      }
      case '--port': {
        const n = Number(argv[++i]);
        if (Number.isInteger(n) && n > 0 && n < 65536) args.port = n;
        break;
      }
      case '--interval': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n >= 500) args.intervalMs = n;
        break;
      }
      case '--html':
        args.html = argv[++i] ?? 'vibetracker-status.html';
        break;
      case '--tail': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) args.tailKb = n;
        break;
      }
      default:
        if (a.startsWith('-')) {
          process.stderr.write(t`Bilinmeyen seçenek: ${a}\n`);
          process.exit(2);
        }
        rest.push(a);
    }
  }
  if (rest.length > 0) args.command = rest[0]!;
  if (rest.length > 1) args.sub = rest[1];
  if (rest.length > 2) args.operands = rest.slice(2);
  return args;
}

/**
 * Dump the strings this run asked for and could not translate.
 *
 * It lives behind an environment variable rather than a flag because it has
 * to observe a *real* command: coverage is only meaningful for the paths a
 * user actually walks, and those differ per command. `vt lang missing` can
 * only see its own process.
 */
function reportMissingIfAsked(): void {
  const out = process.env.VT_I18N_REPORT;
  if (!out) return;
  const keys = missingKeys();
  const body: Record<string, string> = {};
  for (const k of keys) body[k] = k;
  try {
    writeFileSync(out, `${JSON.stringify(body, null, 2)}
`, 'utf8');
    process.stderr.write(`[i18n] ${keys.length} çevrilmemiş metin → ${out}
`);
  } catch (e) {
    process.stderr.write(t`[i18n] yazılamadı: ${(e as Error).message}
`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Language is resolved before anything prints. The config is read here and
  // only here in the CLI path: a failed read must not stop the tool, so a
  // broken config simply leaves the source language in place.
  let configLang: string | undefined;
  try {
    const { config } = await loadConfig();
    configLang = config.server.lang;
    // The user's own secret shapes, installed before anything can be printed.
    // Every CLI surface redacts through the same module, so this is the one
    // place it has to happen for all of them.
    setCustomPatterns(config.privacy.custom_patterns);
  } catch {
    configLang = undefined;
  }
  loadLang(resolveLang(args.lang, configLang));

  if (args.command === 'lang') {
    const { runLang } = await import('./lang.ts');
    return runLang(args.sub);
  }
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.command === 'daemon') {
    if (args.sub === 'stop') {
      const { stopDaemon } = await import('./daemon-cmd.ts');
      return stopDaemon();
    }
    if (args.sub !== undefined) {
      process.stderr.write(t`Bilinmeyen alt-komut: ${args.sub}
Kullanım: vt daemon [stop]
`);
      return 64;
    }
    const { runDaemon } = await import('./daemon-cmd.ts');
    return runDaemon({ port: args.port, intervalMs: args.intervalMs, open: args.open });
  }
  if (args.command === 'open') {
    const { openDashboard } = await import('./daemon-cmd.ts');
    return openDashboard();
  }
  if (args.command === 'init') {
    const { runInit } = await import('./init.ts');
    return runInit({ yes: args.yes, force: args.force, port: args.port ?? 47823 });
  }
  if (args.command === 'uninstall') {
    const { runUninstall } = await import('./uninstall.ts');
    return runUninstall({ yes: args.yes, keepData: args.keepData, port: args.port ?? 47823 });
  }
  if (args.command === 'demo') {
    const { runDemo } = await import('./demo.ts');
    return runDemo({ huge: args.all, html: args.html, json: args.json });
  }
  if (args.command === 'digest') {
    const { runDigestCmd } = await import('./digest.ts');
    return runDigestCmd({
      sub: args.sub,
      operands: args.operands ?? [],
      json: args.json,
      yes: args.yes,
      dryRun: args.dryRun,
    });
  }
  if (args.command === 'board') {
    const { runBoard } = await import('./board.ts');
    return runBoard({ filter: args.sub, json: args.json });
  }
  if (args.command === 'config') {
    const { runConfig } = await import('./config-cmd.ts');
    return runConfig(args.sub, args.json);
  }
  if (args.command === 'doctor') {
    if (args.bundle) {
      const { collectChecks } = await import('./doctor.ts');
      const { writeBundle } = await import('./bundle.ts');
      const { checks, projectPaths } = await collectChecks();
      return writeBundle(
        { out: args.bundleOut ?? 'vibetracker-teshis.json', yes: args.yes },
        checks,
        projectPaths,
      );
    }
    const { runDoctor } = await import('./doctor.ts');
    return runDoctor(args.json);
  }
  if (args.command === 'hooks') {
    const { installHooks, uninstallHooks, statusHooks } = await import('./hooks.ts');
    const hookArgs = {
      yes: args.yes,
      highFidelity: args.highFidelity,
      port: args.port ?? 47823,
    };
    switch (args.sub) {
      case 'install':
        return installHooks(hookArgs);
      case 'uninstall':
      case 'remove':
        return uninstallHooks(hookArgs);
      case undefined:
      case 'status':
        return statusHooks(hookArgs);
      default:
        process.stderr.write(
          t`Bilinmeyen alt-komut: ${args.sub}\nKullanım: vt hooks install|uninstall|status\n`,
        );
        return 2;
    }
  }
  if (args.command === 'autostart') {
    const { installAutostart, uninstallAutostart, showAutostart } = await import('./autostart.ts');
    switch (args.sub) {
      case 'install':
        return installAutostart();
      case 'uninstall':
      case 'remove':
        return uninstallAutostart();
      case undefined:
      case 'status':
        return showAutostart();
      default:
        process.stderr.write(t`Bilinmeyen alt-komut: ${args.sub}\nKullanım: vt autostart install|uninstall|status\n`);
        return 2;
    }
  }
  if (args.command === 'mini') {
    const { runMini } = await import('./mini.ts');
    return runMini({
      noPin: args.noPin,
      unpin: args.unpin || args.sub === 'unpin',
      browser: args.browser,
      shape:
        args.sub === 'shade'
          ? 'Shade'
          : args.sub === 'badge'
            ? 'Badge'
            : args.sub === 'full'
              ? 'Full'
              : undefined,
      width: args.width,
      height: args.height,
      x: args.x,
      y: args.y,
    });
  }
  if (args.command === 'projects') {
    const { runProjects } = await import('./projects.ts');
    return runProjects({ sub: args.sub, names: args.operands ?? [], json: args.json });
  }
  if (args.command !== 'status') {
    process.stderr.write(t`Bilinmeyen komut: ${args.command}\n\n${usage()}`);
    return 2;
  }

  // `vt status` honours the same selection the dashboard does; `--every`
  // ignores it for the times you want to see what you stopped following.
  const { config } = await loadConfig();

  const opts: ScanOptions = {
    cpuSample: !args.quick,
    cpuSampleMs: 1200,
    includeDead: args.all,
    includeTemp: args.temp,
    tailBytes: args.tailKb * 1024,
    isTracked: args.every ? undefined : (id) => isTracked(config.tracking, id),
    // Only a hand-picked list keeps its closed projects — see `keepClosed`.
    keepClosed:
      args.every || config.tracking.mode !== 'selected'
        ? undefined
        : (id) => isTracked(config.tracking, id),
    extraRoots: configuredRoots(config),
    agents: config.agents.enabled,
    agentRecencyMs: config.thresholds.agent_recency_sec * 1000,
  };

  const report = await scan(opts);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    // Compact by default. The question asked twenty times a day is "is
    // anything stuck", and answering it should not require reading four
    // lines per session. The detailed view is one flag away.
    process.stdout.write((args.full ? renderText(report) : renderCompact(report)) + '\n');
  }

  if (args.html) {
    const target = resolve(args.html);
    await writeFile(target, renderHtml(report), 'utf8');
    process.stdout.write(t`HTML anlık görüntü: ${target}\n`);
  }

  // A successful run exits 0. Reporting "an agent is waiting for you" through a
  // non-zero code breaks every ordinary caller — `set -e` scripts, CI steps and
  // execFile all treat it as a crash. Callers that genuinely want that signal
  // (a shell prompt, a statusline) opt in, and get a distinct code that cannot
  // be confused with a real failure.
  if (args.signalWaiting && report.counts.needsYou > 0) return 10;
  return 0;
}

main().then(
  (code) => {
    reportMissingIfAsked();
    process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`vt: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(70);
  },
);
