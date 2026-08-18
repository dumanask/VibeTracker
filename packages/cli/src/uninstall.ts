/**
 * `vt uninstall` — undo everything, and prove it.
 *
 * A tool that edits a config file it does not own has one obligation above
 * all others: it must be able to put that file back. So uninstall is written
 * as a **manifest** — the complete list of places VibeTracker can ever have
 * touched — and each entry is checked, acted on, and reported with its
 * outcome. The list is exhaustive by construction, not by memory: if a future
 * feature writes somewhere new, it belongs in `TOUCHPOINTS` or it does not
 * ship.
 *
 * The inverse is stated just as plainly. Agent state — transcripts, session
 * registry, `.credentials.json` — is never touched here, because it is not
 * ours and cannot be recreated. Uninstalling a monitor must not cost the user
 * the thing it was monitoring.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeDir,
  configPath,
  dataDir,
  miniProfileDir,
  readMiniState,
  closeMiniWindow,
  noteAlive,
  stopNote,
} from '@vibetracker/platform';
import { DEFAULT_PORT, readRuntimeInfo } from '@vibetracker/daemon';
import { uninstallHooks } from './hooks.ts';
import { autostartStatus, uninstallAutostart } from './autostart.ts';
import { confirm, isInteractive } from './prompt.ts';
import { t, tr } from '@vibetracker/core';

export interface UninstallArgs {
  yes: boolean;
  /** Keep the database, logs and config — only detach from the system. */
  keepData: boolean;
  port: number;
}

type Outcome = 'removed' | 'kept' | 'absent' | 'failed' | 'skipped';

interface Entry {
  what: string;
  where: string;
  outcome: Outcome;
  note?: string;
}

const GLYPH: Record<Outcome, string> = {
  removed: '−',
  kept: '=',
  absent: '·',
  failed: '✖',
  skipped: '·',
};

/**
 * Everything VibeTracker can create, in the order it must be undone: system
 * registration first (so nothing restarts mid-removal), then the foreign file
 * we edited, then our own data.
 */
function touchpoints(): Array<{ id: string; what: string; where: string }> {
  const d = dataDir();
  return [
    { id: 'autostart', what: tr('Oturum açılışı görevi'), where: tr('Zamanlanmış Görev: VibeTracker') },
    { id: 'hooks', what: tr('Hook girdileri'), where: join(claudeDir(), 'settings.json') },
    { id: 'config', what: tr('Yapılandırma'), where: configPath() },
    { id: 'db', what: tr('Veritabanı'), where: join(d, 'vibetracker.db') },
    { id: 'log', what: tr('Günlük'), where: join(d, 'daemon.log') },
    { id: 'runtime', what: tr('Çalışma bilgisi'), where: join(d, 'daemon.json') },
    { id: 'hooktoken', what: tr('Hook anahtarı'), where: join(d, 'hook-token') },
    // Named separately because it is a browser profile — tens of megabytes
    // that a user scanning the manifest deserves to see called out rather
    // than folded silently into "data directory".
    { id: 'miniprofile', what: tr('Post-it penceresi profili'), where: miniProfileDir() },
    { id: 'datadir', what: tr('Veri dizini'), where: d },
  ];
}

export async function runUninstall(args: UninstallArgs): Promise<number> {
  const entries: Entry[] = [];
  const points = touchpoints();

  process.stdout.write(tr('\nVibeTracker kaldırılıyor.\n\nDokunulmuş olabilecek yerler:\n'));
  for (const p of points) {
    const exists = p.id === 'autostart' ? (await autostartStatus()).installed : existsSync(p.where);
    process.stdout.write(`  ${exists ? '•' : '·'} ${p.what.padEnd(24)} ${p.where}\n`);
  }
  process.stdout.write(
    '\nDokunulmayacaklar:\n' +
      t`  · Ajan durumu, transcript'ler, .credentials.json   ${claudeDir()}\n` +
      tr('  · Projelerinin kendi klasörleri (zaten hiç yazılmadı)\n'),
  );
  if (args.keepData) {
    process.stdout.write(tr('\n--keep-data verildi: veritabanı, günlük ve yapılandırma korunacak.\n'));
  }

  if (!args.yes) {
    if (!isInteractive()) {
      process.stderr.write(tr('\nOnay istenemiyor (terminal yok). --yes ekle.\n'));
      return 2;
    }
    if (!(await confirm(tr('\nDevam edilsin mi?'), false))) {
      process.stdout.write(tr('İptal edildi. Hiçbir şeye dokunulmadı.\n'));
      return 0;
    }
  }

  // ── 1. autostart, first: nothing should restart mid-removal ───────────
  const auto = await autostartStatus();
  if (!auto.supported) {
    entries.push({ what: tr('Oturum açılışı görevi'), where: '—', outcome: 'absent', note: tr('bu platformda yok') });
  } else if (!auto.installed) {
    entries.push({ what: tr('Oturum açılışı görevi'), where: tr('Zamanlanmış Görev'), outcome: 'absent' });
  } else {
    const code = await uninstallAutostart();
    entries.push({
      what: tr('Oturum açılışı görevi'),
      where: tr('Zamanlanmış Görev: VibeTracker'),
      outcome: code === 0 ? 'removed' : 'failed',
    });
  }

  // ── 1b. the running daemon ────────────────────────────────────────────
  // Autostart is gone, so stopping it now cannot race a restart. This has to
  // happen before the data directory goes: `daemon.json` holds the token that
  // stopping requires, and deleting it first would leave a live daemon sitting
  // on the port with no way left to ask it to stop.
  const { stopDaemon } = await import('./daemon-cmd.ts');
  // Read it *before* stopping: a clean shutdown removes its own runtime file,
  // so asking afterwards reports the default port instead of the real one, and
  // a manifest that misstates what it touched is worse than no manifest.
  const running = readRuntimeInfo();
  if (!running) {
    entries.push({ what: tr('Çalışan daemon'), where: '—', outcome: 'absent' });
  } else {
    const code = await stopDaemon();
    entries.push({
      what: tr('Çalışan daemon'),
      where: t`port ${running.port} · pid ${running.pid}`,
      outcome: code === 0 ? 'removed' : 'failed',
      note: code === 0 ? undefined : tr('cevap vermedi — süreci elle kapatman gerekebilir'),
    });
  }

  // ── 1c. the pinned window ─────────────────────────────────────────────
  // It holds an open browser profile inside the directory we are about to
  // delete, and Windows will not remove a directory that is in use. Same lock
  // that made stopping the daemon a prerequisite rather than a courtesy.
  // Two shapes of the same window: the native note where it runs, the
  // browser fallback everywhere else. Both hold something in the directory
  // about to be deleted, so both have to go first.
  const note = noteAlive();
  if (note !== null) {
    stopNote(note);
    entries.push({ what: tr('Post-it penceresi'), where: t`pid ${note}`, outcome: 'removed' });
  }
  const mini = readMiniState();
  if (!mini) {
    if (note === null) {
      entries.push({ what: tr('Post-it penceresi'), where: '—', outcome: 'absent' });
    }
  } else {
    const closed = closeMiniWindow(mini.pid);
    entries.push({
      what: tr('Post-it penceresi'),
      where: t`pid ${mini.pid}`,
      outcome: closed ? 'removed' : 'absent',
      note: closed ? undefined : tr('zaten kapalıydı'),
    });
  }

  // ── 2. the file we do not own ─────────────────────────────────────────
  const settings = join(claudeDir(), 'settings.json');
  if (!existsSync(settings)) {
    entries.push({ what: tr('Hook girdileri'), where: settings, outcome: 'absent' });
  } else {
    // uninstallHooks removes only entries carrying our marker and our URL,
    // and leaves a backup. Someone else's hooks in the same file survive.
    //
    // The before/after comparison is what makes the manifest trustworthy:
    // "removed" has to mean something was actually removed, otherwise a
    // successful no-op reads as a change and the report stops being evidence.
    const before = readSafe(settings);
    const code = await uninstallHooks({ yes: true, highFidelity: false, port: args.port });
    const after = readSafe(settings);
    entries.push({
      what: tr('Hook girdileri'),
      where: settings,
      outcome: code !== 0 ? 'failed' : before === after ? 'absent' : 'removed',
      note:
        code !== 0
          ? undefined
          : before === after
            ? tr('bizim girdimiz yoktu; dosya bit-birebir aynı bırakıldı')
            : tr('yalnızca "_vt" işaretli girdiler; yedek bırakıldı'),
    });
  }

  // ── 3. our own data ───────────────────────────────────────────────────
  for (const p of points) {
    if (p.id === 'autostart' || p.id === 'hooks') continue;
    if (!existsSync(p.where)) {
      entries.push({ what: p.what, where: p.where, outcome: 'absent' });
      continue;
    }
    if (args.keepData) {
      entries.push({ what: p.what, where: p.where, outcome: 'kept' });
      continue;
    }
    if (p.id === 'datadir') {
      // Anything still in the data directory is ours by construction, but say
      // what is being removed rather than deleting a directory blind.
      const leftovers = safeList(p.where);
      try {
        removeWithRetry(p.where, true);
        entries.push({
          what: p.what,
          where: p.where,
          outcome: 'removed',
          note: leftovers.length > 0 ? t`içindekiler: ${leftovers.join(', ')}` : undefined,
        });
      } catch (e) {
        entries.push({ what: p.what, where: p.where, outcome: 'failed', note: (e as Error).message });
      }
      continue;
    }
    const size = sizeOf(p.where);
    try {
      // `recursive` because not every touchpoint is a file — the pinned
      // window's browser profile is a directory, and unlinking it fails with
      // EISDIR rather than removing it.
      removeWithRetry(p.where, true);
      entries.push({ what: p.what, where: p.where, outcome: 'removed', note: size });
    } catch (e) {
      entries.push({ what: p.what, where: p.where, outcome: 'failed', note: (e as Error).message });
    }
  }

  // The config directory is separate from the data directory on Windows. If
  // removing our config emptied it, take the directory too — but only if it
  // is empty, because a shared parent may hold someone else's files.
  if (!args.keepData) {
    const cdir = join(configPath(), '..');
    if (existsSync(cdir) && safeList(cdir).length === 0) {
      try {
        rmdirSync(cdir);
        entries.push({ what: tr('Yapılandırma dizini'), where: cdir, outcome: 'removed' });
      } catch {
        entries.push({ what: tr('Yapılandırma dizini'), where: cdir, outcome: 'kept', note: 'silinemedi' });
      }
    }
  }

  // ── 4. optional per-project files ─────────────────────────────────────
  // `.vibe/state.json` is only ever written into a project that already has a
  // `.vibe/` directory, and that feature is not built yet. Reporting the
  // count rather than staying silent is the point: the manifest has to be
  // complete even when the answer is zero.
  entries.push({
    what: tr('Proje içi .vibe/state.json'),
    where: '—',
    outcome: 'absent',
    note: tr('hiç yazılmadı (bu sürüm projelere hiç yazmıyor)'),
  });

  // ── manifest ──────────────────────────────────────────────────────────
  process.stdout.write(`\n${'─'.repeat(64)}\nManifest\n${'─'.repeat(64)}\n`);
  for (const e of entries) {
    process.stdout.write(`  ${GLYPH[e.outcome]} ${label(e.outcome).padEnd(9)} ${e.what}\n`);
    if (e.where !== '—') process.stdout.write(`               ${e.where}\n`);
    if (e.note) process.stdout.write(`               ${e.note}\n`);
  }

  const failed = entries.filter((e) => e.outcome === 'failed');
  if (failed.length > 0) {
    process.stderr.write(
      t`\n${failed.length} öğe kaldırılamadı. Daemon hâlâ çalışıyor olabilir: 'vt daemon stop' deneyip tekrar çalıştır.\n`,
    );
    return 1;
  }

  process.stdout.write(
    args.keepData
      ? tr('\nSistemden ayrıldı. Verin duruyor; yeniden kurmak için: vt init\n')
      : tr('\nTemiz. Ajan durum dizinine hiç dokunulmadı.\n'),
  );
  return 0;
}

function label(o: Outcome): string {
  return { removed: 'silindi', kept: 'korundu', absent: 'yoktu', failed: 'HATA', skipped: tr('atlandı') }[o];
}

function sizeOf(path: string): string | undefined {
  try {
    const bytes = statSync(path).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return undefined;
  }
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Remove a path, allowing for Windows releasing handles a moment late.
 *
 * A process we just stopped can still be holding a file open when the very
 * next line tries to delete it — measured here with the pinned window's
 * browser profile, and with the database before it. Retrying briefly turns a
 * reported failure into the removal the user asked for; failing on the first
 * attempt would tell them their machine is dirty when it is a millisecond
 * away from being clean.
 *
 * Bounded on purpose: something genuinely holding the file forever must still
 * be reported rather than waited on indefinitely.
 */
function removeWithRetry(target: string, recursive: boolean): void {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      rmSync(target, { force: true, recursive });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || Date.now() > deadline) throw e;
      // A short synchronous pause: this path is a one-shot command, and an
      // async sleep here would mean threading a promise through the manifest
      // loop for no benefit.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).slice(0, 12);
  } catch {
    return [];
  }
}

export const UNINSTALL_DEFAULT_PORT = DEFAULT_PORT;
