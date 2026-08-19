/**
 * `vt init` — first-run setup.
 *
 * The governing principle is that **the user's disk is never scanned.** Agent
 * state files already list every project the user actually works in, with
 * dates, so project discovery is a read of what has already been observed.
 * A filesystem crawl would be slower, would need permissions we should not
 * want, and would surface directories the user has not touched in a year.
 *
 * The second principle is that setup is allowed to change exactly three
 * things, and asks about each: the config file, the hook entries in the
 * user's `settings.json`, and the autostart registration. Nothing else on the
 * machine is touched, and each answer defaults to the option that changes the
 * least.
 */
import { CLI_PRESETS, ScanContext, scan } from '@vibetracker/engine';
import {
  claudeDir,
  configExists,
  configPath,
  configTemplate,
  dataDir,
  hasCommand,
  otherAgentDirs,
  writeConfig,
} from '@vibetracker/platform';
import { t, fmtAge, formatIssues, loadConfigText, tr } from '@vibetracker/core';
import { DEFAULT_PORT } from '@vibetracker/daemon';
import type { Config } from '@vibetracker/core';
import { askText, choose, confirm, isInteractive } from './prompt.ts';
import { DEFAULT_BASE, DEFAULT_KEY_ENV, DEFAULT_MODEL, needsKey } from '@vibetracker/engine';
import { installHooks } from './hooks.ts';
import { autostartStatus, installAutostart } from './autostart.ts';
import { runDoctor } from './doctor.ts';

export interface InitArgs {
  /** Accept every default without asking. Required when there is no TTY. */
  yes: boolean;
  /** Re-run setup over an existing config. */
  force: boolean;
  port: number;
}

const RULE = '─'.repeat(64);

function head(n: number, title: string): void {
  process.stdout.write(t`\n${RULE}\n${n}/4  ${title}\n${RULE}\n`);
}

export async function runInit(args: InitArgs): Promise<number> {
  if (!isInteractive() && !args.yes) {
    process.stderr.write(
      tr('vt init is interactive. Without a terminal, add --yes to accept the defaults.\n') +
        tr('Defaults: no hooks, no autostart, LLM digest off, dashboard local only.\n'),
    );
    return 2;
  }

  const path = configPath();
  if (configExists(path) && !args.force) {
    process.stdout.write(
      t`A configuration already exists: ${path}\n` +
        tr('To set up from scratch: vt init --force   ·  For status: vt doctor\n'),
    );
    return 0;
  }

  process.stdout.write(
    tr('\nVibeTracker setup\n') +
      tr('Your disk will not be scanned. Projects are read from the session records the agent already writes.\n') +
      tr('Nothing is written to your projects, no agent is contacted, nothing goes online.\n'),
  );

  // ── 1. which agents are on this machine ───────────────────────────────
  head(1, tr('Agent detection'));
  const ctx = new ScanContext();
  let report;
  try {
    report = await scan(
      { tailBytes: 64 * 1024, cpuSample: false, cpuSampleMs: 0, includeDead: false, includeTemp: false },
      ctx,
    );
  } finally {
    await ctx.close();
  }

  const live = report.counts.live;
  const total = report.counts.registryEntries;
  process.stdout.write(t`  Claude Code   ${claudeDir()}\n`);
  if (total === 0) {
    process.stdout.write(
      tr('                no session records — it may never have run\n') +
        tr('                Run "claude" once and come back; the dashboard starts populated.\n'),
    );
  } else {
    const dead = total - live - report.counts.reused;
    process.stdout.write(
      t`                ${total} records · ${live} live · ${dead} dead` +
        (report.counts.reused > 0 ? t` · ${report.counts.reused} PIDs recycled` : '') +
        '\n',
    );
  }

  const others = otherAgentDirs();
  for (const o of others) {
    process.stdout.write(t`  ${o.id.padEnd(13)} ${o.dir}\n                found — adapter lands in M5\n`);
  }
  if (others.length === 0) process.stdout.write(tr('  No other agent CLI state found.\n'));

  // ── 2. projects, from what has already been observed ───────────────────
  head(2, tr('Project discovery'));
  const projects = report.projects;
  if (projects.length === 0) {
    process.stdout.write(tr('  No projects observed yet.\n'));
  } else {
    process.stdout.write(t`  ${projects.length} projects found (no disk scan):\n\n`);
    const shown = projects.slice(0, 12);
    for (const p of shown) {
      const last = p.sessions.reduce((m, s) => Math.max(m, s.lastActivityAt ?? 0), 0);
      const when = last > 0 ? fmtAge(Date.now() - last) : '—';
      const flags = p.flags.length > 0 ? `  [${p.flags.join(' ')}]` : '';
      process.stdout.write(
        t`    ${p.displayName.padEnd(22)} ${String(p.sessions.length).padStart(2)} sessions · ${when}${flags}\n`,
      );
    }
    if (projects.length > shown.length) {
      process.stdout.write(t`    … and ${projects.length - shown.length} more\n`);
    }
    const flagged = projects.filter((p) => p.flags.includes('duplicate-path') || p.flags.includes('subdir-project'));
    if (flagged.length > 0) {
      // Never merged automatically: two similar names can be two genuinely
      // separate efforts, and an unwanted merge rewrites history.
      process.stdout.write(
        t`\n  ${flagged.length} projects look like a duplicate location / subdirectory. Not merged automatically —\n` +
          tr('  you can confirm each with one click in the dashboard.\n'),
      );
    }
  }

  // ── 3. the three questions ────────────────────────────────────────────
  head(3, tr('Three questions'));

  const hooksMode = await choose<'http' | 'off'>(
    tr('Install hooks? This is the only way to see the "waiting for permission" state.'),
    [
      {
        value: 'http',
        label: tr('Yes, install (recommended)'),
        detail: t`edits ${claudeDir()}/settings.json · shows a diff first, asks for your approval, keeps a backup`,
      },
      {
        value: 'off',
        label: tr('No, not for now'),
        detail: tr('the dashboard still works; permission prompts stay invisible. Later: vt hooks install'),
      },
    ],
    args.yes ? 'off' : 'http',
  );

  // Whose model, not whether to use ours.
  //
  // The first version of this question offered "your Claude subscription" or
  // "an API key", which assumed everyone running the tool is an Anthropic
  // customer. Most are not. `openai` here is the wire format rather than the
  // company — one `base_url` reaches OpenRouter, Groq, DeepSeek, Mistral, xAI,
  // Together, LM Studio, vLLM and Gemini's compatibility endpoint — and the
  // CLI answers run whatever agent is already signed in on this machine. The
  // list is the shape of the market instead of one vendor and a fallback.
  //
  // It is filtered by what is actually installed, because an answer of
  // "the tool you already pay for" is only an answer if it names a tool that
  // is there. Everything is still reachable from the config file; this only
  // decides what is worth putting in front of somebody on their first run.
  const hasOllama = hasCommand('ollama');
  const options: Array<{ value: Config['digest']['provider']; label: string; detail: string }> = [
    { value: 'off', label: tr('Off (recommended)'), detail: tr('the structural engine works on its own; no data leaves the machine') },
  ];
  if (hasOllama) {
    options.push({ value: 'ollama', label: tr('A local model (Ollama) — installed'), detail: tr('nothing leaves the machine; no key needed; quality is noticeably lower') });
  }
  // Every agent CLI in the engine's table that is actually on this machine.
  // One template key rather than a label per program: the names are proper
  // nouns, and a list that grows should not grow the translation job with it.
  for (const preset of CLI_PRESETS) {
    if (!hasCommand(preset.program)) continue;
    options.push({
      value: preset.id as Config['digest']['provider'],
      label: t`The ${preset.program} command on my machine — installed`,
      detail: tr('needs no key, eats your own account quota'),
    });
  }
  if (!hasOllama) {
    options.push({ value: 'ollama', label: tr('A local model (Ollama)'), detail: tr('not installed; install it and nothing ever leaves the machine') });
  }
  options.push(
    { value: 'openai', label: tr('An OpenAI-compatible service'), detail: tr('OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio, vLLM… all of them, via base_url') },
    { value: 'anthropic', label: tr('the Anthropic API'), detail: tr('typically ~$5-7/month; you keep the key in an environment variable') },
    { value: 'cli', label: tr('Some other command'), detail: tr('gemini, opencode, aider, your own script… anything that takes text on stdin') },
  );
  const digestProvider = await choose<Config['digest']['provider']>(
    tr('LLM digest (phase name, blocker, next action) — off by default.'),
    options,
    'off',
  );

  // Where, and with what. Only asked when the answer above was one that can
  // point at more than one place — an `off` install should not be interrogated
  // about endpoints it will never call.
  let digestModel = '';
  let digestBaseUrl = '';
  let digestKeyEnv = '';
  let digestCommand = '';
  let digestArgs: string[] = [];
  if (digestProvider === 'cli') {
    digestCommand = await askText(tr('  Which command?'), 'gemini');
    const argLine = await askText(tr('  Arguments (space separated, may be left empty)?'), '');
    digestArgs = argLine.split(/\s+/).filter(Boolean);
    if (!hasCommand(digestCommand)) {
      process.stdout.write(
        t`  Warning: "${digestCommand}" was not found on PATH. It will be written, but it cannot run.\n`,
      );
    }
    process.stdout.write(
      tr('  The text is handed to the command on stdin, never on the command line. If it will not take stdin, put {prompt_file} in the arguments.\n'),
    );
  }
  if (digestProvider === 'openai' || digestProvider === 'ollama' || digestProvider === 'anthropic') {
    digestBaseUrl =
      digestProvider === 'anthropic'
        ? ''
        : await askText(tr('  Address (base_url)?'), DEFAULT_BASE[digestProvider]);
    digestModel = await askText(tr('  Model?'), DEFAULT_MODEL[digestProvider]);
    if (needsKey(digestProvider, digestBaseUrl)) {
      digestKeyEnv = await askText(
        tr('  Which environment variable holds the key?'),
        DEFAULT_KEY_ENV[digestProvider] ?? '',
      );
      process.stdout.write(
        t`  The key itself is never written to the config. Set ${digestKeyEnv}, or put it in a 0600 file with \`vt digest key\`.\n`,
      );
    }
    // The base_url is normalised to the default when the user just pressed
    // enter, so the config file does not pin an address it did not need to.
    if (digestBaseUrl === DEFAULT_BASE[digestProvider as 'openai' | 'ollama']) digestBaseUrl = '';
    if (digestModel === DEFAULT_MODEL[digestProvider]) digestModel = '';
  }

  const lan = await choose<'local' | 'lan'>(
    tr('Should other devices reach the dashboard?'),
    [
      { value: 'local', label: tr('No, this computer only (recommended)'), detail: tr('127.0.0.1 — unreachable from outside') },
      { value: 'lan', label: tr('Yes, open it to the local network'), detail: tr('anyone on the network can see the dashboard; a token is still required') },
    ],
    'local',
  );

  let bind = '127.0.0.1';
  if (lan === 'lan') {
    bind = await askText('  Hangi adres dinlensin?', '0.0.0.0');
    process.stdout.write(
      tr('  Warning: the dashboard will be open to the network. A token is still needed, but anyone on it can try.\n'),
    );
  }

  const port = args.port;

  // Say what was decided, always. A `--yes` run answers three consequential
  // questions without showing them, and "it installed hooks and I never saw
  // it ask" is the complaint that would follow.
  process.stdout.write(
    t`\n  Decisions\n` +
      t`    hooks         ${hooksMode === 'http' ? tr('will be installed (diff first, then approval)') : 'kurulmayacak'}\n` +
      t`    LLM digest    ${digestProvider}\n` +
      t`    dashboard     ${bind}:${port}${bind === '127.0.0.1' ? tr(' (this computer only)') : tr('  ← OPEN TO THE NETWORK')}\n`,
  );

  // ── write the config ──────────────────────────────────────────────────
  const text = configTemplate({
    lang: 'tr',
    port,
    bind,
    hooksMode: hooksMode === 'http' ? 'http' : 'off',
    digestProvider,
    digestModel,
    digestBaseUrl,
    digestKeyEnv,
    digestCommand,
    digestArgs,
    agents: ['claude-code'],
  });

  // The template is validated before it is written: a starter file that fails
  // its own parser would look like a corrupt install.
  const check = loadConfigText(text);
  const errors = check.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    process.stderr.write(t`The configuration template failed validation:\n${formatIssues(errors).join('\n')}\n`);
    return 70;
  }
  await writeConfig(text, path);
  process.stdout.write(t`\n  Configuration written: ${path}\n  Data directory:        ${dataDir()}\n`);

  if (hooksMode === 'http') {
    process.stdout.write('\n');
    const code = await installHooks({ yes: args.yes, highFidelity: false, port });
    if (code !== 0) {
      process.stdout.write(
        tr('\n  Hooks were not installed. The dashboard still works; you can try "vt hooks install" later.\n'),
      );
    }
  }

  const auto = await autostartStatus();
  if (auto.supported && !auto.installed) {
    const want = await confirm(
      tr('\nShould the daemon start on its own when you log in? (no administrator rights needed)'),
      false,
    );
    if (want) await installAutostart();
  }

  // ── 4. verify ─────────────────────────────────────────────────────────
  head(4, tr('Verification'));
  const doctorCode = await runDoctor(false);

  process.stdout.write(
    t`\nReady. Start it:  vt daemon --open\n` +
      t`Settings:         ${path}\n` +
      t`Undo:             vt uninstall\n`,
  );
  return doctorCode === 0 ? 0 : 0; // setup succeeded even if a check is degraded
}

export const INIT_DEFAULT_PORT = DEFAULT_PORT;
