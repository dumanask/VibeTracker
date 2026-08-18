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
import { ScanContext, scan } from '@vibetracker/engine';
import {
  claudeDir,
  configExists,
  configPath,
  configTemplate,
  dataDir,
  otherAgentDirs,
  writeConfig,
} from '@vibetracker/platform';
import { t, fmtAge, formatIssues, loadConfigText, tr } from '@vibetracker/core';
import { DEFAULT_PORT } from '@vibetracker/daemon';
import type { Config } from '@vibetracker/core';
import { askText, choose, confirm, isInteractive } from './prompt.ts';
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
      tr('vt init etkileşimli çalışır. Terminal yoksa varsayılanları kabul etmek için --yes ekle.\n') +
        tr('Varsayılanlar: hook kurulmaz, otomatik başlatma kurulmaz, LLM özeti kapalı, panel yalnızca bu makine.\n'),
    );
    return 2;
  }

  const path = configPath();
  if (configExists(path) && !args.force) {
    process.stdout.write(
      t`Yapılandırma zaten var: ${path}\n` +
        tr('Baştan kurmak için: vt init --force   ·  Durum için: vt doctor\n'),
    );
    return 0;
  }

  process.stdout.write(
    tr('\nVibeTracker kurulumu\n') +
      tr('Diskin taranmayacak. Projeler, ajanın zaten yazdığı oturum kayıtlarından okunuyor.\n') +
      tr('Hiçbir projene dosya yazılmaz, hiçbir ajanla konuşulmaz, ağa çıkılmaz.\n'),
  );

  // ── 1. which agents are on this machine ───────────────────────────────
  head(1, tr('Ajan tespiti'));
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
      tr('                oturum kaydı yok — henüz hiç çalıştırılmamış olabilir\n') +
        tr('                Bir kez "claude" çalıştırıp buraya dönersen panel dolu başlar.\n'),
    );
  } else {
    const dead = total - live - report.counts.reused;
    process.stdout.write(
      t`                ${total} kayıt · ${live} canlı · ${dead} ölü` +
        (report.counts.reused > 0 ? t` · ${report.counts.reused} PID geri dönüşmüş` : '') +
        '\n',
    );
  }

  const others = otherAgentDirs();
  for (const o of others) {
    process.stdout.write(t`  ${o.id.padEnd(13)} ${o.dir}\n                bulundu — adaptörü M5'te\n`);
  }
  if (others.length === 0) process.stdout.write(tr('  Başka ajan CLI durumu bulunamadı.\n'));

  // ── 2. projects, from what has already been observed ───────────────────
  head(2, tr('Proje keşfi'));
  const projects = report.projects;
  if (projects.length === 0) {
    process.stdout.write(tr('  Henüz gözlenmiş proje yok.\n'));
  } else {
    process.stdout.write(t`  ${projects.length} proje bulundu (disk taranmadı):\n\n`);
    const shown = projects.slice(0, 12);
    for (const p of shown) {
      const last = p.sessions.reduce((m, s) => Math.max(m, s.lastActivityAt ?? 0), 0);
      const when = last > 0 ? fmtAge(Date.now() - last) : '—';
      const flags = p.flags.length > 0 ? `  [${p.flags.join(' ')}]` : '';
      process.stdout.write(
        t`    ${p.displayName.padEnd(22)} ${String(p.sessions.length).padStart(2)} oturum · ${when}${flags}\n`,
      );
    }
    if (projects.length > shown.length) {
      process.stdout.write(t`    … ve ${projects.length - shown.length} tane daha\n`);
    }
    const flagged = projects.filter((p) => p.flags.includes('duplicate-path') || p.flags.includes('subdir-project'));
    if (flagged.length > 0) {
      // Never merged automatically: two similar names can be two genuinely
      // separate efforts, and an unwanted merge rewrites history.
      process.stdout.write(
        t`\n  ${flagged.length} projede çift konum / alt dizin şüphesi var. Otomatik birleştirilmedi —\n` +
          tr('  panelde tek tıkla onaylayabilirsin.\n'),
      );
    }
  }

  // ── 3. the three questions ────────────────────────────────────────────
  head(3, tr('Üç soru'));

  const hooksMode = await choose<'http' | 'off'>(
    tr('Hook kurulsun mu? Bu, "izin bekliyor" durumunu görebilmenin tek yolu.'),
    [
      {
        value: 'http',
        label: tr('Evet, kur (önerilen)'),
        detail: t`${claudeDir()}/settings.json düzenlenir · önce diff gösterilir, onayın alınır, yedek alınır`,
      },
      {
        value: 'off',
        label: tr('Hayır, şimdilik kalsın'),
        detail: tr('panel yine çalışır; izin istemleri görünmez. Sonra: vt hooks install'),
      },
    ],
    args.yes ? 'off' : 'http',
  );

  const digestProvider = await choose<Config['digest']['provider']>(
    tr('LLM özeti (faz adı, blocker, sonraki adım) — varsayılan kapalı.'),
    [
      { value: 'off', label: tr('Kapalı (önerilen)'), detail: tr('yapısal motor tek başına çalışır; hiçbir veri makineden çıkmaz') },
      { value: 'claude-cli', label: tr('Kendi Claude aboneliğim'), detail: tr('claude -p ile; anahtar istemez, kotandan yer') },
      { value: 'api', label: tr('Kendi API anahtarım'), detail: tr('tipik ~$5-7/ay; anahtarı sonra config dosyasına yazarsın') },
      { value: 'ollama', label: tr('Yerel model (Ollama)'), detail: tr('veri makineden çıkmaz; kalite belirgin düşer') },
    ],
    'off',
  );

  const lan = await choose<'local' | 'lan'>(
    tr('Panele başka cihazlardan erişilsin mi?'),
    [
      { value: 'local', label: tr('Hayır, yalnızca bu bilgisayar (önerilen)'), detail: tr('127.0.0.1 — dışarıdan erişilemez') },
      { value: 'lan', label: tr('Evet, yerel ağa aç'), detail: tr('ağdaki herkes paneli görebilir; token zorunlu kalır') },
    ],
    'local',
  );

  let bind = '127.0.0.1';
  if (lan === 'lan') {
    bind = await askText('  Hangi adres dinlensin?', '0.0.0.0');
    process.stdout.write(
      tr('  Uyarı: panel ağa açık olacak. Token yine gerekli, ama ağdaki herkes deneyebilir.\n'),
    );
  }

  const port = args.port;

  // Say what was decided, always. A `--yes` run answers three consequential
  // questions without showing them, and "it installed hooks and I never saw
  // it ask" is the complaint that would follow.
  process.stdout.write(
    t`
  Kararlar
` +
      t`    hook          ${hooksMode === 'http' ? tr('kurulacak (önce diff, sonra onay)') : 'kurulmayacak'}
` +
      t`    LLM özeti     ${digestProvider}
` +
      t`    panel adresi  ${bind}:${port}${bind === '127.0.0.1' ? tr(' (yalnızca bu makine)') : tr('  ← AĞA AÇIK')}
`,
  );

  // ── write the config ──────────────────────────────────────────────────
  const text = configTemplate({
    lang: 'tr',
    port,
    bind,
    hooksMode: hooksMode === 'http' ? 'http' : 'off',
    digestProvider,
    agents: ['claude-code'],
  });

  // The template is validated before it is written: a starter file that fails
  // its own parser would look like a corrupt install.
  const check = loadConfigText(text);
  const errors = check.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    process.stderr.write(t`Yapılandırma şablonu doğrulanamadı:\n${formatIssues(errors).join('\n')}\n`);
    return 70;
  }
  await writeConfig(text, path);
  process.stdout.write(t`\n  Yapılandırma yazıldı: ${path}\n  Veri dizini:          ${dataDir()}\n`);

  if (hooksMode === 'http') {
    process.stdout.write('\n');
    const code = await installHooks({ yes: args.yes, highFidelity: false, port });
    if (code !== 0) {
      process.stdout.write(
        tr('\n  Hook kurulmadı. Panel yine çalışır; sonra "vt hooks install" deneyebilirsin.\n'),
      );
    }
  }

  const auto = await autostartStatus();
  if (auto.supported && !auto.installed) {
    const want = await confirm(
      tr('\nOturum açtığında daemon kendiliğinden başlasın mı? (yönetici gerekmez)'),
      false,
    );
    if (want) await installAutostart();
  }

  // ── 4. verify ─────────────────────────────────────────────────────────
  head(4, tr('Doğrulama'));
  const doctorCode = await runDoctor(false);

  process.stdout.write(
    t`\nHazır. Başlat:  vt daemon --open\n` +
      t`Ayarlar:        ${path}\n` +
      t`Geri al:        vt uninstall\n`,
  );
  return doctorCode === 0 ? 0 : 0; // setup succeeded even if a check is degraded
}

export const INIT_DEFAULT_PORT = DEFAULT_PORT;
