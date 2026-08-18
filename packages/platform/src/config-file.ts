/**
 * Reading and writing `config.toml` on disk.
 *
 * The template below is authored as text rather than serialized from an
 * object. That is deliberate: the reason for choosing TOML was comments, and
 * a round-trip through a serializer destroys them. When `vt init` writes a
 * config it writes this text with a few values substituted, so the file the
 * user opens explains itself.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultConfig,
  loadConfigText,
  tomlValue,
  CONFIG_VERSION,
  type Config,
  type LoadedConfig,
} from '@vibetracker/core';
import { configDir } from './dirs.ts';

export function configPath(): string {
  return join(configDir(), 'config.toml');
}

/**
 * Load config from disk. A missing file is not an issue — it is the normal
 * state before `vt init`, and the defaults are the documented behaviour.
 */
export async function loadConfig(path = configPath()): Promise<LoadedConfig & { path: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { config: defaultConfig(), issues: [], fromFile: false, path };
  }
  return { ...loadConfigText(text), path };
}

export function configExists(path = configPath()): boolean {
  return existsSync(path);
}

interface TemplateChoices {
  lang: 'tr' | 'en';
  port: number;
  bind: string;
  hooksMode: 'http' | 'command' | 'off';
  digestProvider: Config['digest']['provider'];
  agents: string[];
}

/**
 * The commented starter file. Every setting a first-time user is likely to
 * want is present and explained; everything else is documented as available
 * rather than written out, so the file stays short enough to read.
 */
export function configTemplate(c: TemplateChoices): string {
  const d = defaultConfig();
  return `# VibeTracker yapılandırması
# Bu dosya elle düzenlenebilir. Değişiklik sonrası: vt daemon --restart
# Geçersiz bir ayar daemon'ı durdurmaz — varsayılana düşer ve panelde uyarı çıkar.

config_version = ${CONFIG_VERSION}

[server]
# Port sabittir: hook URL'leri settings.json içinde düz metin durur ve
# çalışma anında değiştirilemez. Değiştirirsen "vt hooks install" ile
# hook'ları da yeniden yaz.
port = ${c.port}

# "127.0.0.1" = yalnızca bu bilgisayar. Başka bir değer paneli ağa açar.
bind = ${tomlValue(c.bind)}

lang = ${tomlValue(c.lang)}          # tr | en
interval_ms = ${d.server.interval_ms}   # tarama aralığı

[agents]
enabled = ${tomlValue(c.agents)}
# Boş = $CLAUDE_CONFIG_DIR, o da yoksa ~/.claude
claude_dir = ''

[hooks]
# http    : izin istemlerini kesin olarak görür (önerilen)
# command : ajan başına ~100 ms süreç açar, karşılığında hiç bloklamaz
# off     : yalnızca pasif tespit; "izin bekliyor" görünmez
mode = ${tomlValue(c.hooksMode)}
# PreToolUse/PostToolUse de bağlansın mı. Çok yüksek hacim, araç detayı
# zaten transcript'ten geliyor.
high_fidelity = false

[digest]
# LLM özeti varsayılan KAPALI. Açarsan plan belgelerinin özeti modele gider.
# off | claude-cli | api | ollama
provider = ${tomlValue(c.digestProvider)}
model = ''
daily_usd_cap = ${d.digest.daily_usd_cap}
per_project_min_interval_min = ${d.digest.per_project_min_interval_min}
max_per_project_per_day = ${d.digest.max_per_project_per_day}
preview_before_send = true   # gönderilecek yükü önce göster

[privacy]
# DİKKAT: bu bölümde bilinmeyen bir anahtar hata sayılır. Yazım hatası
# yüzünden kapalı sandığın bir korumanın açık kalmasını istemiyoruz.
redact = true
custom_patterns = []          # kendi sır desenlerin (düzenli ifade)
telemetry = false             # kapalı; açman gerekmez
diagnostics_allowlist_only = true

[progress]
# Faz/ilerleme kaynakları. Sıra önceliktir.
default_providers = ${tomlValue(d.progress.default_providers)}
# Plan belgelerinin arandığı ek klasör adları (docs, plans, plan zaten dahil)
extra_doc_dirs = []

[thresholds]
# Bir aracın "takıldı" sayılması için geçmesi gereken süre (saniye).
stall_bash_sec = ${d.thresholds.stall_bash_sec}       # test/build gerçekten dakikalar sürer
stall_fs_sec = ${d.thresholds.stall_fs_sec}          # yerel dosya işlemleri sürmez
stall_thinking_sec = ${d.thresholds.stall_thinking_sec}

[tracking]
# Hangi projeleri izliyorsun.
#   all      — hepsi (varsayılan)
#   selected — yalnızca aşağıdaki liste
# Bu dosyayı elle düzenlemene gerek yok: "vt projects add/rm <proje>" ya da
# paneldeki "izlenecekleri seç" aynı yeri yazar ve yorumlarını korur.
mode = "all"
selected = []

# Proje bazlı ayarlar — proje kimliğiyle. Kimlikleri "vt status --json"
# çıktısında bulabilirsin. Hiçbir şey projenin kendi klasörüne yazılmaz.
#
# [projects."git:c02462b9c30c8d9f"]
# display_name = 'AITool'
# providers = ['plans-md', 'todowrite']
# archived = false
`;
}

/**
 * Write the config atomically. A half-written config is the one file that
 * would break the next start, so it is never written in place.
 */
export async function writeConfig(text: string, path = configPath()): Promise<void> {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}
