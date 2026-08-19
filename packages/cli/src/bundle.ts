/**
 * `vt doctor --bundle` — a diagnostic file safe to paste into a public issue.
 *
 * The naive version of this feature — "zip up the .claude directory" — ships
 * the user's `.credentials.json`, their prompts, and their source code to a
 * stranger. Measured on the reference machine: 25 transcripts carried private
 * key markers and JWTs in their last megabyte alone. So this is built the
 * other way round.
 *
 * **Allowlist, never a directory walk.** Every field in the output is named
 * here, in code. Nothing is included because it happened to be in a folder.
 * A future file added next to the database cannot leak by accident, because
 * nothing enumerates that folder.
 *
 * **Shapes and counts, never content.** A path becomes `<proj-3>` plus the
 * facts that matter for debugging — how deep it was, whether it held non-ASCII
 * characters, whether it sat under a sync folder. Those are the properties
 * that break path handling; the name is not.
 *
 * **Everything passes redaction anyway**, because an allowlist protects
 * against the fields you thought of.
 *
 * **The user sees the manifest before the file exists.** Reviewing a bundle
 * you have already written is reviewing a leak that already happened.
 */
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { platform, release, arch, totalmem, cpus } from 'node:os';
import { claudeDir, configPath, dataDir } from '@vibetracker/platform';
import { t, tr, redact } from '@vibetracker/core';
import { VERSION, logFilePath } from '@vibetracker/daemon';
import type { Check } from './doctor.ts';
import { confirm, isInteractive } from './prompt.ts';

const LOG_LINES = 200;

/** Config keys whose *values* never appear, whatever redaction thinks. */
const SECRET_CONFIG_KEYS = /^(.*_)?(token|key|secret|password|api_key)$/i;

export interface BundleArgs {
  out: string;
  yes: boolean;
}

interface Bundle {
  schema: 1;
  generatedAt: string;
  tool: { version: string; node: string };
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    memGb: number;
    /** Locale matters: the dotted/dotless I bug only reproduces in some. */
    locale: string;
    tz: string;
  };
  capabilities: Array<{ id: string; status: string; detail: string }>;
  config: { present: boolean; lines: string[] };
  paths: Array<{ alias: string; depth: number; nonAscii: boolean; kind: string }>;
  data: Array<{ what: string; bytes: number | null }>;
  log: { path: string | null; lines: string[] };
  /** The tray shell's log. Absent on a machine that never ran the desktop app. */
  desktopLog: { path: string | null; lines: string[] };
}

/**
 * Replace a real path with a shape-preserving alias.
 *
 * Depth, non-ASCII content and storage kind are kept because those are what
 * actually break: a Turkish character in a folder name, a project under
 * OneDrive, a path six levels deep. The name itself has never been the cause
 * of a bug and is always the cause of a leak.
 */
export function aliasPath(path: string, index: number): {
  alias: string;
  depth: number;
  nonAscii: boolean;
  kind: string;
} {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const lower = path.toLowerCase();
  let kind = 'local';
  if (/onedrive|dropbox|google drive|icloud/.test(lower)) kind = 'cloud';
  else if (/[\\/]temp[\\/]|[\\/]tmp[\\/]|scratch/.test(lower)) kind = 'temp';
  else if (path.startsWith('\\\\')) kind = 'network';
  else if (/^\/mnt\/[a-z]\//.test(lower)) kind = 'wsl';
  return {
    alias: `<proj-${index}>`,
    depth: parts.length,
    nonAscii: /[^\x00-\x7f]/.test(path),
    kind,
  };
}

/**
 * Reduce the config to lines, with secret-shaped values struck out. The
 * comments are dropped: they are the user's notes, not diagnostics.
 */
function configLines(): { present: boolean; lines: string[] } {
  const path = configPath();
  if (!existsSync(path)) return { present: false, lines: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { present: true, lines: [t`(unreadable: ${(e as Error).message})`] };
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;
    const m = /^\s*([A-Za-z0-9_."-]+)\s*=/.exec(line);
    if (m && SECRET_CONFIG_KEYS.test(m[1]!.replace(/["']/g, ''))) {
      out.push(t`${m[1]} = «hidden»`);
      continue;
    }
    out.push(redact(line));
  }
  return { present: true, lines: out };
}

function tailLines(path: string | null, count: number): { path: string | null; lines: string[] } {
  if (!path || !existsSync(path)) return { path: path ? tr('«absent»') : null, lines: [] };
  try {
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-count);
    // The log already refuses prompts and file contents, but a diagnostic
    // bundle is exactly the wrong place to trust that.
    return { path: tr('«log»'), lines: lines.map((l) => redact(l)) };
  } catch (e) {
    return { path: tr('«log»'), lines: [t`(unreadable: ${(e as Error).message})`] };
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function buildBundle(checks: Check[], projectPaths: string[]): Bundle {
  const d = dataDir();
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    tool: { version: VERSION, node: process.version },
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      memGb: Math.round(totalmem() / 1024 / 1024 / 1024),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    capabilities: checks.map((c) => ({
      id: c.id,
      status: c.status,
      // A check's detail can quote a path or an error string.
      detail: redact(stripPaths(c.detail)),
    })),
    config: configLines(),
    paths: projectPaths.map((p, i) => aliasPath(p, i + 1)),
    data: [
      { what: 'db', bytes: sizeOf(join(d, 'vibetracker.db')) },
      { what: 'db-wal', bytes: sizeOf(join(d, 'vibetracker.db-wal')) },
      { what: 'log', bytes: sizeOf(join(d, 'daemon.log')) },
      { what: 'desktop-log', bytes: sizeOf(join(d, 'desktop.log')) },
    ],
    log: tailLines(logFilePath(), LOG_LINES),
    // The tray shell's own log. It has no console, no terminal and no window
    // to print into, so this file is the only place it can say that something
    // went wrong — and a bug report about the desktop app that does not carry
    // it is a bug report with the evidence left behind.
    desktopLog: tailLines(join(d, 'desktop.log'), LOG_LINES),
  };
}

/**
 * Remove absolute paths from free text. Home and the agent directory are the
 * two that carry a username; anything else that still looks like a path is
 * reduced to its last segment, which is usually the informative part.
 */
function stripPaths(s: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  // The agent directory is replaced first. It normally lives *under* home, so
  // collapsing home to `~` first would leave `~\.claude` behind and the more
  // specific alias would never match.
  let out = s.split(claudeDir()).join('«ajan-dizini»');
  if (home) out = out.split(home).join('~');
  out = out.replace(/([A-Za-z]:)?([\\/][^\s"']+){2,}/g, (m) => {
    const last = m.split(/[\\/]/).filter(Boolean).pop() ?? '';
    return `…${sep}${last}`;
  });
  return out;
}

/** Human-readable inventory of what the bundle will contain. */
function manifest(b: Bundle): string[] {
  return [
    t`version and platform             ${b.tool.version} · ${b.machine.platform} ${b.machine.release} · ${b.machine.locale}`,
    t`capability matrix                ${b.capabilities.length} check results`,
    t`configuration                    ${b.config.present ? t`${b.config.lines.length} lines (comments dropped, secret-shaped values hidden)` : 'yok'}`,
    t`project paths                    ${b.paths.length} — SHAPE ONLY: depth, non-ASCII characters, storage kind`,
    t`data file sizes                  ${b.data.length} numbers`,
    t`log tail                         ${b.log.lines.length} lines (redacted)`,
  ];
}

export async function writeBundle(
  args: BundleArgs,
  checks: Check[],
  projectPaths: string[],
): Promise<number> {
  const bundle = buildBundle(checks, projectPaths);

  process.stdout.write(t`\nDiagnostic bundle contents (the file has NOT been written yet):\n\n`);
  for (const line of manifest(bundle)) process.stdout.write(`  • ${line}\n`);
  process.stdout.write(
    tr('\nNEVER in the bundle:\n') +
      tr('  · .credentials.json      · transcript text       · prompt text\n') +
      tr('  · source code            · file contents         · real project names/paths\n'),
  );

  if (!args.yes) {
    if (!isInteractive()) {
      process.stderr.write(tr('\nCannot ask for confirmation (no terminal). Add --yes.\n'));
      return 2;
    }
    if (!(await confirm(t`\nWrite ${args.out}?`, false))) {
      process.stdout.write(tr('Cancelled. Nothing was written.\n'));
      return 0;
    }
  }

  const text = JSON.stringify(bundle, null, 2);
  try {
    writeFileSync(args.out, text, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    process.stderr.write(t`Could not write: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(
    t`\nWritten: ${args.out}  (${(text.length / 1024).toFixed(1)} KB)\n` +
      tr('Read it once yourself before sending — this is the only file leaving your machine.\n'),
  );
  return 0;
}
