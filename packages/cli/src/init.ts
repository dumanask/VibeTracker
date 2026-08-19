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
  const hasClaude = hasCommand('claude');
  const hasCodex = hasCommand('codex');
  const hasOpencode = hasCommand('opencode');
  const hasGemini = hasCommand('gemini');
  const hasOllama = hasCommand('ollama');
  const options: Array<{ value: Config['digest']['provider']; label: string; detail: string }> = [
    { value: 'off', label: tr('Kapalı (önerilen)'), detail: tr('yapısal motor tek başına çalışır; hiçbir veri makineden çıkmaz') },
  ];
  if (hasOllama) {
    options.push({ value: 'ollama', label: tr('Yerel model (Ollama) — kurulu'), detail: tr('veri makineden çıkmaz; anahtar istemez; kalite belirgin düşer') });
  }
  if (hasClaude) {
    options.push({ value: 'claude-cli', label: tr('Makinemdeki claude komutu — kurulu'), detail: tr('anahtar istemez, mevcut aboneliğinin kotasından yer') });
  }
  if (hasCodex) {
    options.push({ value: 'codex-cli', label: tr('Makinemdeki codex komutu — kurulu'), detail: tr('anahtar istemez, Codex aboneliğinin kotasından yer') });
  }
  if (hasOpencode) {
    options.push({ value: 'opencode-cli', label: tr('Makinemdeki opencode komutu — kurulu'), detail: tr('anahtar istemez, opencode aboneliğinin kotasından yer') });
  }
  if (hasGemini) {
    options.push({ value: 'gemini-cli', label: tr('Makinemdeki gemini komutu — kurulu'), detail: tr('anahtar istemez, Google hesabının kotasından yer') });
  }
  if (!hasOllama) {
    options.push({ value: 'ollama', label: tr('Yerel model (Ollama)'), detail: tr('kurulu değil; kurarsan veri makineden hiç çıkmaz') });
  }
  options.push(
    { value: 'openai', label: tr('OpenAI uyumlu bir servis'), detail: tr('OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio, vLLM… base_url ile hepsi') },
    { value: 'anthropic', label: tr('Anthropic API'), detail: tr('tipik ~$5-7/ay; anahtarı ortam değişkeninde tutarsın') },
    { value: 'cli', label: tr('Başka bir komut'), detail: tr('gemini, opencode, aider, kendi betiğin… metni stdin ile alan her şey') },
  );
  const digestProvider = await choose<Config['digest']['provider']>(
    tr('LLM özeti (faz adı, blocker, sonraki adım) — varsayılan kapalı.'),
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
    digestCommand = await askText(tr('  Hangi komut?'), 'gemini');
    const argLine = await askText(tr('  Argümanlar (boşlukla ayrılmış, boş bırakılabilir)?'), '');
    digestArgs = argLine.split(/\s+/).filter(Boolean);
    if (!hasCommand(digestCommand)) {
      process.stdout.write(
        t`  Uyarı: "${digestCommand}" PATH'te bulunamadı. Yazılacak, ama çalıştırılamaz.\n`,
      );
    }
    process.stdout.write(
      tr('  Metin komuta stdin ile verilir; komut satırına yazılmaz. Kabul etmiyorsa argümanlara {prompt_file} koy.\n'),
    );
  }
  if (digestProvider === 'openai' || digestProvider === 'ollama' || digestProvider === 'anthropic') {
    digestBaseUrl =
      digestProvider === 'anthropic'
        ? ''
        : await askText(tr('  Adres (base_url)?'), DEFAULT_BASE[digestProvider]);
    digestModel = await askText(tr('  Model?'), DEFAULT_MODEL[digestProvider]);
    if (needsKey(digestProvider, digestBaseUrl)) {
      digestKeyEnv = await askText(
        tr('  Anahtarı hangi ortam değişkeni tutuyor?'),
        DEFAULT_KEY_ENV[digestProvider] ?? '',
      );
      process.stdout.write(
        t`  Anahtarın kendisi config'e yazılmaz. ${digestKeyEnv} değişkenini ayarla, ya da \`vt digest key\` ile 0600 bir dosyaya koy.
`,
      );
    }
    // The base_url is normalised to the default when the user just pressed
    // enter, so the config file does not pin an address it did not need to.
    if (digestBaseUrl === DEFAULT_BASE[digestProvider as 'openai' | 'ollama']) digestBaseUrl = '';
    if (digestModel === DEFAULT_MODEL[digestProvider]) digestModel = '';
  }

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
