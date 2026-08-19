/**
 * `vt config` — see what the daemon will actually read.
 *
 * The value of this command is the gap it closes. A user edits `config.toml`,
 * restarts, and nothing changes. Was the key misspelt? Was the section named
 * wrong? Did the value fall outside a range and silently revert? `vt config
 * check` answers that in one line each, without starting a daemon.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { configPath, loadConfig } from '@vibetracker/platform';
import { t, formatIssues, tr } from '@vibetracker/core';

export async function runConfig(sub: string | undefined, json: boolean): Promise<number> {
  switch (sub ?? 'check') {
    case 'path':
      process.stdout.write(`${configPath()}\n`);
      return 0;
    case 'show':
      return show(json);
    case 'check':
      return check(json);
    default:
      process.stderr.write(
        t`Unknown subcommand: ${sub}\nUsage: vt config show|check|path\n`,
      );
      return 2;
  }
}

/** Print the file as written, unmodified. */
async function show(json: boolean): Promise<number> {
  const path = configPath();
  if (!existsSync(path)) {
    process.stdout.write(
      t`No configuration file: ${path}\nRunning on defaults. To create one: vt init\n`,
    );
    return 0;
  }
  if (json) {
    const { config } = await loadConfig(path);
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(await readFile(path, 'utf8'));
  return 0;
}

/**
 * Validate and report. Exits non-zero only on errors — a warning about an
 * unknown key must not break someone's CI.
 */
async function check(json: boolean): Promise<number> {
  const { config, issues, fromFile, path } = await loadConfig();
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warn');

  if (json) {
    process.stdout.write(`${JSON.stringify({ path, fromFile, issues, config }, null, 2)}\n`);
    return errors.length > 0 ? 1 : 0;
  }

  process.stdout.write(`${path}\n`);
  if (!fromFile) {
    process.stdout.write(
      existsSync(path)
        ? tr('  file unreadable — see the error below; defaults will be used\n')
        : tr('  no file — defaults will be used\n'),
    );
  }
  if (issues.length > 0) {
    process.stdout.write('\n');
    for (const line of formatIssues(issues)) process.stdout.write(`  ${line}\n`);
  }

  // The point of the summary is the values in force, not the file contents:
  // a setting that reverted to its default is exactly what the user came to
  // find out.
  process.stdout.write(
    t`\n  Settings in force\n` +
      `    panel        http://${config.server.bind}:${config.server.port}\n` +
      t`    language     ${config.server.lang}\n` +
      t`    scan         ${config.server.interval_ms} ms\n` +
      t`    hooks        ${config.hooks.mode}${config.hooks.high_fidelity ? tr(' + high-fidelity') : ''}\n` +
      t`    LLM digest   ${config.digest.provider}\n` +
      t`    redaction    ${config.privacy.redact ? tr('on') : 'KAPALI'}` +
      `${config.privacy.custom_patterns.length > 0 ? t` (+${config.privacy.custom_patterns.length} custom patterns)` : ''}\n` +
      t`    telemetry    ${config.privacy.telemetry ? tr('on') : tr('off')}\n` +
      t`    per-project  ${Object.keys(config.projects).length}\n`,
  );

  if (errors.length === 0 && warnings.length === 0) {
    process.stdout.write(tr('\n  No problems.\n'));
  } else {
    process.stdout.write(t`\n  ${errors.length} errors · ${warnings.length} warnings\n`);
  }
  return errors.length > 0 ? 1 : 0;
}
