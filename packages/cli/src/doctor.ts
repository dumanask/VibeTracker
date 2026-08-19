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
    label: tr('Node sürümü'),
    status: ok ? 'ok' : 'fail',
    detail: t`${process.version} (gereken ≥ v${MIN_NODE[0]}.${MIN_NODE[1]})`,
    fix: ok
      ? undefined
      : tr("node:sqlite ve TypeScript'in derlemesiz çalışması bu sürümü gerektiriyor."),
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
      label: tr('Süreç sondası'),
      status: err ? 'fail' : seen > 0 ? 'ok' : 'warn',
      detail: err
        ? `${probe.kind}: ${err}`
        : t`${probe.kind} · ilk cevap ${ms} ms · kendi PID'imiz ${seen > 0 ? tr('görüldü') : tr('GÖRÜLMEDİ')}`,
      fix: err ? tr('Canlılık tespiti "PID var mı" seviyesine düşer.') : undefined,
    },
  ];

  const precision = probe.precision;
  out.push({
    id: 'pid-reuse',
    label: tr('PID-reuse koruması'),
    status: precision === 'exact' ? 'ok' : precision === 'second' ? 'warn' : 'fail',
    detail:
      precision === 'exact'
        ? tr('tam (başlangıç zamanı bit-birebir karşılaştırılabiliyor)')
        : precision === 'second'
          ? tr('saniye çözünürlüklü — aynı saniyede geri dönüşen PID kaçabilir')
          : tr('yok — bu platformda başlangıç zamanı okunamıyor'),
    fix: precision === 'exact' ? undefined : tr('Platform sınırı; kullanıcı tarafında yapılacak bir şey yok.'),
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
      label: tr('Ajan durum dizini'),
      status: 'fail',
      detail: t`${dir} bulunamadı`,
      fix: tr('Claude Code kurulu mu? Farklı bir yerdeyse $CLAUDE_CONFIG_DIR ile göster.'),
    });
    return out;
  }
  out.push({
    id: 'agent-dir',
    label: tr('Ajan durum dizini'),
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
    label: tr('Oturum kaydı'),
    status: sessions > 0 ? 'ok' : virgin ? 'todo' : sessions === 0 ? 'warn' : 'fail',
    detail: virgin
      ? tr('henüz hiç oturum yok — bu dizin yeni')
      : sessions >= 0
        ? t`sessions/ içinde ${sessions} kayıt`
        : tr('sessions/ okunamadı'),
    fix: virgin
      ? tr('Bir kez `claude` çalıştır; panel bir sonraki açılışta dolu başlar.')
      : sessions === 0
        ? tr('Hiç oturum kaydı yok. Bir kez `claude` çalıştırdıktan sonra tekrar bak.')
        : sessions < 0
          ? tr('Bu dosya belgelenmemiş; Claude Code sürümün onu artık yazmıyor olabilir.')
          : undefined,
  });
  out.push({
    id: 'ide-locks',
    label: tr('IDE pencereleri'),
    status: locks > 0 ? 'ok' : 'info',
    detail: locks >= 0 ? t`ide/ içinde ${locks} kilit` : tr('ide/ okunamadı'),
    fix: locks === 0 ? tr('Açık IDE penceresi yok; pencere gruplama devre dışı.') : undefined,
  });

  // Not a capability check — a standing reminder of what lives next to the data
  // we read, and why the diagnostics bundle is allowlist-based (M4).
  const cred = join(dir, '.credentials.json');
  if (existsSync(cred)) {
    out.push({
      id: 'credentials',
      label: tr('Kimlik dosyası'),
      status: 'info',
      detail: t`${cred} mevcut — VibeTracker bu dosyayı hiç açmaz`,
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
      label: tr('Transcript okuma'),
      status: 'warn',
      detail: tr('projects/ okunamadı'),
    };
  }
  if (!biggest) {
    return {
      id: 'transcript-read',
      label: tr('Transcript okuma'),
      status: 'info',
      detail: tr('henüz transcript yok'),
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
    label: tr('Transcript okuma'),
    status: slow ? 'warn' : 'ok',
    detail:
      t`en büyük dosya ${mb} MB · 256 KB kuyruk açılışı ` +
      t`${first.toFixed(0)} ms → ${second.toFixed(0)} ms`,
    fix: slow
      ? tr('Açılış maliyeti yüksek (muhtemelen antivirüs taraması). Daemon tanıtıcıları ') +
        tr('açık tuttuğu için bunu bir kez öder; tek seferlik `vt status` her seferinde öder.')
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
      label: tr('Tam tarama'),
      status: 'ok',
      detail:
        t`${ms} ms · ${c.registryEntries} kayıt → ${c.live} canlı / ${c.dead} ölü / ` +
        t`${c.reused} PID-yeniden-kullanım · ${c.projects} proje`,
    },
  ];

  const guard = report.capabilities.pidReuseGuard;
  if (guard && !guard.ok) {
    out.push({
      id: 'pid-reuse-data',
      label: tr('PID-reuse verisi'),
      status: 'warn',
      detail: guard.detail ?? tr('koruma uygulanamadı'),
      fix: tr('Ajan karşılaştırılabilir bir başlangıç zamanı yazmıyor ya da formatı değişmiş. Oturumlar canlı sayıldı.'),
    });
  }
  for (const w of report.warnings) {
    out.push({ id: 'warning', label: tr('Tarama uyarısı'), status: 'warn', detail: w });
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
      detail: tr('bulunamadı'),
      fix:
        tr('Proje kimliği kök commit yerine paket adına ya da yola düşer: aynı projenin iki ') +
        tr('kopyası ayrı kartlar olarak görünebilir. Dal ve kirli dosya sayısı gösterilmez.'),
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
    return { id: 'digest', label: tr('LLM özeti'), status: 'info', detail: tr('yapılandırma okunamadı') };
  }
  const d = cfg.digest;
  if (d.provider === 'off') {
    return {
      id: 'digest',
      label: tr('LLM özeti'),
      status: 'info',
      detail: tr('kapalı — her sayı yerel hesaplanıyor, hiçbir şey gönderilmiyor'),
      fix: tr('Açmak istersen seçenekler için: vt digest providers'),
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
      ? tr('veri makineden çıkar')
      : out === 'no'
        ? tr('veri makineden çıkmaz')
        : tr('veri çıkar mı bilinmiyor');

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
        label: tr('LLM özeti'),
        status: 'warn',
        detail: `${d.provider} · ${tr('komut yazılmamış')}`,
        fix: tr('Config dosyasında [digest] command ayarla, ya da: vt digest providers'),
      };
    }
    if (!path) {
      return {
        id: 'digest',
        label: tr('LLM özeti'),
        status: 'warn',
        detail: `${d.provider} · "${exe}" ${tr("PATH'te bulunamadı")}`,
        fix: tr('Kur, ya da başka bir sağlayıcı seç: vt digest providers'),
      };
    }
    return {
      id: 'digest',
      label: tr('LLM özeti'),
      status: 'ok',
      detail: `${d.provider} · ${path}${model ? ' · ' + model : ''} · ${where}`,
    };
  }

  if (wants(d.provider, d.base_url) && key.key === null) {
    return {
      id: 'digest',
      label: tr('LLM özeti'),
      status: 'warn',
      detail: `${d.provider} · ${model} · ${tr('anahtar yok')}`,
      fix: t`${key.envName ?? tr('ortam değişkeni')} ayarla, ya da: vt digest key <anahtar>`,
    };
  }
  return {
    id: 'digest',
    label: tr('LLM özeti'),
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
      label: tr('Veritabanı'),
      status: 'info',
      detail: t`${db} henüz yok (ilk \`vt daemon\` ile oluşur)`,
    };
  }
  const size = statSync(db).size;
  const wal = existsSync(db + '-wal') ? statSync(db + '-wal').size : 0;
  return {
    id: 'db',
    label: tr('Veritabanı'),
    status: size > 500 * 1024 * 1024 ? 'warn' : 'ok',
    detail: t`${(size / 1048576).toFixed(1)} MB (+${(wal / 1048576).toFixed(1)} MB WAL) · ${db}`,
    fix: size > 500 * 1024 * 1024 ? tr('Sert tavan aşıldı; daemon agresif saklamaya geçer.') : undefined,
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
    const up = Math.round(Number(health.uptimeMs ?? 0) / 60000);
    const tail = health.transcripts as { openHandles?: number; skipped?: number; reads?: number } | undefined;
    const out: Check[] = [
      {
        id: 'daemon',
        label: 'Daemon',
        status: health.lastError ? 'warn' : 'ok',
        detail:
          t`port ${port} · ${up} dk çalışıyor · ${health.scans} tarama · ` +
          t`son ${health.lastScanMs} ms · ${health.rssMb} MB RSS` +
          (health.lastError ? t` · son hata: ${health.lastError}` : ''),
      },
    ];
    if (tail) {
      out.push({
        id: 'tail-cache',
        label: tr('Transcript tanıtıcıları'),
        status: 'ok',
        detail: t`${tail.openHandles} açık · ${tail.reads} okuma / ${tail.skipped} değişmemiş`,
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
        ? t`port ${port} başka bir program tarafından kullanılıyor`
        : t`çalışmıyor (port ${port} boş)`,
      fix: foreign
        ? tr("Hook URL'leri sabit olduğu için VibeTracker sessizce başka porta geçmez. O programı durdur ya da --port ile taşı.")
        : tr('`vt daemon --open` ile başlat.'),
    },
  ];
}

async function checkAutostart(): Promise<Check> {
  const st = await autostartStatus();
  return {
    id: 'autostart',
    label: tr('Otomatik başlatma'),
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
        ? tr('`vt autostart install` ile kur.')
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
      label: tr('Ayar dosyası'),
      status: 'fail',
      detail: t`${settings} yorum satırı içeriyor`,
      fix:
        tr('Claude Code bu dosyayı katı JSON okuyor ve yorum gördüğünde tamamını yok sayıyor — ') +
        tr('buradaki hiçbir ayar geçerli değil. Doğrulamak için: claude doctor'),
    });
  }

  // These three settings each silently neutralize hooks. A user who set one
  // months ago will not connect it to "the dashboard never shows permissions".
  for (const [key, label] of [
    ['disableAllHooks', tr('tüm hooklar kapatılmış')],
    ['allowManagedHooksOnly', tr('yalnızca yönetilen hooklara izin var')],
    ['allowedHttpHookUrls', tr('HTTP hook URL beyaz listesi var')],
  ] as const) {
    if (raw && new RegExp(`"${key}"`).test(raw)) {
      out.push({
        id: `setting-${key}`,
        label: tr('Hook politikası'),
        status: 'warn',
        detail: `${key}: ${label}`,
        fix:
          key === 'allowedHttpHookUrls'
            ? t`Listede ${hookUrlFor()} yoksa ajan bizim hookumuzu engeller ("HTTP hook blocked").`
            : tr('Bu ayar açıkken hooklarımız hiç çalışmaz.'),
      });
    }
  }

  if (!installed) {
    out.push({
      id: 'hooks',
      label: tr('İzin-bekliyor tespiti'),
      status: 'todo',
      detail: tr('hook kurulu değil — süreç ağacı ve araç sınıfından çıkarım yapılıyor'),
      fix: tr('`vt hooks install` kesin tespit sağlar (izin istemi, tur sonu, alt-ajanlar).'),
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
    label: tr('İzin-bekliyor tespiti'),
    status: !health ? 'info' : received > 0 ? 'ok' : 'warn',
    detail: !health
      ? tr('hook kurulu; daemon çalışmadığı için olay akışı kontrol edilemedi')
      : received > 0
        ? t`${received} olay alındı · ${Object.keys(health?.hooks?.byEvent ?? {}).length} farklı tip` +
          ((health?.hooks?.dropped ?? 0) > 0 ? t` · ${health?.hooks?.dropped} DÜŞTÜ` : '')
        : tr('hook kurulu ama hiç olay gelmedi'),
    fix:
      health && received === 0
        ? tr('Mevcut ajan oturumları ayarları başlangıçta okur — yeni bir oturum başlat. ') +
          tr('Sürerse: claude doctor ile ayar dosyasını doğrula.')
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
        detail: tr('kurulu değil'),
      });
      continue;
    }
    const bits: string[] = [];
    bits.push(caps.sessions ? t`${hints} klasör` : t`${hints} klasör · oturum okunmuyor`);
    if (caps.sessions) {
      bits.push(caps.liveProcess ? tr('canlılık: pid') : tr('canlılık: son yazma'));
      if (caps.turnState) bits.push(tr('tur durumu'));
      if (caps.openTools) bits.push(tr('açık araç'));
    }
    if (detect.lastActivityAt > 0) {
      bits.push(t`son ${fmtAge(Date.now() - detect.lastActivityAt)} önce`);
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
      label: tr('Adaptörü olmayan ajanlar'),
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
 * machine with no Chromium-family browser produces "pencere açılamadı" from a
 * command the user ran expecting a window.
 */
function checkMiniWindow(): Check {
  const browser = findBrowser();
  if (process.platform === 'win32') {
    return {
      id: 'mini',
      label: tr('Post-it penceresi'),
      status: 'ok',
      detail: tr('yerleşik panel · üstte kalır · vt mini'),
    };
  }
  if (!browser) {
    return {
      id: 'mini',
      label: tr('Post-it penceresi'),
      status: 'warn',
      detail: tr('Chromium ailesinden tarayıcı bulunamadı'),
      fix: tr('Chrome/Chromium/Brave/Edge kur, ya da masaüstü uygulamasını kullan.'),
    };
  }
  return {
    id: 'mini',
    label: tr('Post-it penceresi'),
    status: 'warn',
    detail: `${browser.family} · ${browser.path} · ${tr('üstte tutulamaz')}`,
    fix: tr('Üstte kalan gerçek bir post-it için masaüstü uygulaması: tepsi menüsü → Post-it.'),
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
      label: tr('Sesli haber'),
      status: 'todo',
      detail: tr('yalnızca Windows post-it penceresi konuşur'),
    };
  }
  const report = await listVoices();
  if (!report.supported) {
    return {
      id: 'voice',
      label: tr('Sesli haber'),
      status: 'warn',
      detail: report.error
        ? t`ses motoru okunamadı: ${report.error}`
        : tr('kurulu ses yok — pencere sessiz kalır'),
      fix: tr('Ayarlar → Saat ve dil → Konuşma üzerinden bir ses ekle.'),
    };
  }
  const lang = getLang();
  const match = speaksLanguage(report, lang);
  // The gap between the two registries, stated as a number: this is what tells
  // someone that a voice they installed is visible to the engine we use and
  // invisible to the one .NET ships with.
  const engines = t`${report.engine} · WinRT ${report.winrtCount} / SAPI5 ${report.sapiCount} ses`;
  if (match) {
    return {
      id: 'voice',
      label: tr('Sesli haber'),
      status: 'ok',
      detail: t`${match.name} (${match.lang}) · ${engines}`,
    };
  }
  const alt = lang === 'tr' ? 'en' : 'tr';
  const fallback = speaksLanguage(report, alt);
  return {
    id: 'voice',
    label: tr('Sesli haber'),
    status: 'warn',
    detail: fallback
      ? t`${lang} sesi yok — cümle ${alt} olarak ${fallback.name} ile okunuyor · ${engines}`
      : t`${lang} sesi yok — sistem varsayılanıyla okunuyor · ${engines}`,
    fix: t`Ayarlar → Saat ve dil → Konuşma üzerinden ${lang} sesi ekle.`,
  };
}

function checkWriteSafety(): Check {
  const agent = claudeDir();
  const ours = [dataDir(), configDir()];
  const overlap = ours.some((p) => p.toLowerCase().startsWith(agent.toLowerCase()));
  return {
    id: 'write-safety',
    label: tr('Yazma güvenliği'),
    status: overlap ? 'fail' : 'ok',
    detail: overlap
      ? tr('VibeTracker verisi ajan durum dizininin İÇİNDE — bu olmamalı')
      : t`ajan dizini salt-okunur · yazdıklarımız yalnızca ${ours[0]}`,
    fix: overlap ? tr("Veri dizinini taşı; ajanın transcript'leri yeri doldurulamaz.") : undefined,
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
    t` ${n('ok')} tamam ${dim('·')} ${n('warn')} uyarı ${dim('·')} ${n('fail')} hata ` +
      t`${dim('·')} ${n('todo')} henüz yok`,
  );
  out.push('');
  return out.join('\n');
}
