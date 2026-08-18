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
    return { present: true, lines: [t`(okunamadı: ${(e as Error).message})`] };
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;
    const m = /^\s*([A-Za-z0-9_."-]+)\s*=/.exec(line);
    if (m && SECRET_CONFIG_KEYS.test(m[1]!.replace(/["']/g, ''))) {
      out.push(t`${m[1]} = «gizlendi»`);
      continue;
    }
    out.push(redact(line));
  }
  return { present: true, lines: out };
}

function tailLines(path: string | null, count: number): { path: string | null; lines: string[] } {
  if (!path || !existsSync(path)) return { path: path ? tr('«var değil»') : null, lines: [] };
  try {
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-count);
    // The log already refuses prompts and file contents, but a diagnostic
    // bundle is exactly the wrong place to trust that.
    return { path: tr('«günlük»'), lines: lines.map((l) => redact(l)) };
  } catch (e) {
    return { path: tr('«günlük»'), lines: [t`(okunamadı: ${(e as Error).message})`] };
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
    ],
    log: tailLines(logFilePath(), LOG_LINES),
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
    t`sürüm ve platform bilgisi          ${b.tool.version} · ${b.machine.platform} ${b.machine.release} · ${b.machine.locale}`,
    t`yetenek matrisi                    ${b.capabilities.length} kontrol sonucu`,
    t`yapılandırma                       ${b.config.present ? t`${b.config.lines.length} satır (yorumlar atıldı, sır benzeri değerler gizlendi)` : 'yok'}`,
    t`proje yolları                      ${b.paths.length} adet — YALNIZCA şekil: derinlik, ASCII dışı karakter, depolama türü`,
    t`veri dosyası boyutları             ${b.data.length} sayı`,
    t`günlük kuyruğu                     ${b.log.lines.length} satır (redaksiyondan geçti)`,
  ];
}

export async function writeBundle(
  args: BundleArgs,
  checks: Check[],
  projectPaths: string[],
): Promise<number> {
  const bundle = buildBundle(checks, projectPaths);

  process.stdout.write(t`\nTeşhis paketi içeriği (dosya HENÜZ yazılmadı):\n\n`);
  for (const line of manifest(bundle)) process.stdout.write(`  • ${line}\n`);
  process.stdout.write(
    tr('\nPakete ASLA girmeyenler:\n') +
      tr('  · .credentials.json      · transcript metni      · prompt metni\n') +
      tr('  · kaynak kod             · dosya içerikleri      · gerçek proje adları/yolları\n'),
  );

  if (!args.yes) {
    if (!isInteractive()) {
      process.stderr.write(tr('\nOnay istenemiyor (terminal yok). --yes ekle.\n'));
      return 2;
    }
    if (!(await confirm(t`\n${args.out} yazılsın mı?`, false))) {
      process.stdout.write(tr('İptal edildi. Dosya yazılmadı.\n'));
      return 0;
    }
  }

  const text = JSON.stringify(bundle, null, 2);
  try {
    writeFileSync(args.out, text, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    process.stderr.write(t`Yazılamadı: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(
    t`\nYazıldı: ${args.out}  (${(text.length / 1024).toFixed(1)} KB)\n` +
      tr('Göndermeden önce bir kez kendin oku — bu senin makinenden çıkan tek dosya.\n'),
  );
  return 0;
}
