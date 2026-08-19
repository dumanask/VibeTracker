/**
 * Configuration: shape, defaults, validation, migration.
 *
 * Three rules shape this file.
 *
 * 1. **An invalid config must not lock the user out.** A daemon that refuses
 *    to start because of one bad line is a daemon someone has to fix by
 *    reading source code. So parse errors and bad values degrade to defaults
 *    and are reported — loudly, in the panel and in `vt doctor` — rather than
 *    thrown.
 *
 * 2. **Unknown keys are a warning, except where they are dangerous.** Forward
 *    compatibility means an older build must tolerate a newer file. But under
 *    `[privacy]` an unknown key is almost always a typo, and a typo there
 *    silently leaves the user on a default they believed they had changed.
 *    `redcation = "strict"` must be an error, not a shrug.
 *
 * 3. **Every validation failure names the key, the value and the fix.**
 */

import { parseToml, TomlError, type TomlTable, type TomlValue } from './toml.ts';

export const CONFIG_VERSION = 1;

export interface ProjectConfig {
  /**
   * Where the project is, for one that no agent has ever opened.
   *
   * Everything else here is discovered: a project exists because a session ran
   * in it, and its path came from that session. This is the one way to name a
   * directory the agent has never seen — a repository you want on the board
   * for its plan and its phase before you have pointed an agent at it.
   *
   * Written by `vt projects add <yol>`. Never scanned for: the plan is
   * explicit that a user's disk is not walked looking for projects.
   */
  path?: string;
  display_name?: string;
  providers?: string[];
  digest?: 'inherit' | 'off';
  archived?: boolean;
}

/**
 * Which projects the dashboard is for.
 *
 * One mode and one list, deliberately — a `selected` plus a `hidden` list
 * reads like two switches for one decision, and the two disagree the moment a
 * project appears in both. Removing a project while in `all` mode is expressed
 * as "select the rest", which is the same thing said in one vocabulary.
 */
export interface TrackingConfig {
  mode: 'all' | 'selected';
  /** Project ids. Names are resolved to ids before they are written here. */
  selected: string[];
}

export interface Config {
  config_version: number;
  server: {
    port: number;
    bind: string;
    lang: 'tr' | 'en';
    /** Poll interval in ms. */
    interval_ms: number;
  };
  agents: {
    /**
     * Which agents to read. `claude-code` is always read and needs no entry;
     * the rest are adapter ids — `codex`, `opencode`, `kilo`, `cline`, `gemini`,
     * and one per installed editor (`code`, `cursor`, `antigravity`, `trae`, …).
     *
     * `all` means every agent whose state directory exists, which is the
     * default: someone who has Codex and VibeTracker on the same machine did
     * not install both hoping to configure something. Listing ids narrows it;
     * an empty list turns every other agent off.
     */
    enabled: string[];
    claude_dir: string;
  };
  hooks: {
    mode: 'http' | 'command' | 'off';
    high_fidelity: boolean;
  };
  digest: {
    /**
     * Which model writes the summary — and, more to the point, whose.
     *
     * The first version of this offered "your Claude subscription" or "an API
     * key", which quietly assumed everybody using the tool is an Anthropic
     * customer. Most are not, and the ones who are may not want this
     * particular job billed there.
     *
     * So the list is the shape of the market rather than one vendor's product
     * line, and `openai` is deliberately not "OpenAI": it is the wire format
     * that OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, LM Studio,
     * vLLM, llama.cpp and Gemini's compatibility endpoint all speak. Pointing
     * `base_url` at one of those is the whole configuration.
     */
    provider: 'off' | 'claude-cli' | 'anthropic' | 'openai' | 'ollama';
    model: string;
    /** Empty means the provider's own default. Set it to reach anything else. */
    base_url: string;
    /**
     * The **name** of an environment variable holding the key, never the key.
     *
     * A config file is plain text a person edits, keeps in a backup and pastes
     * into an issue, and `vt doctor --bundle` reads it. A secret has no
     * business in any of those. Empty falls back to the provider's usual
     * variable, and then to the 0600 key file `vt digest key` writes.
     */
    api_key_env: string;
    daily_usd_cap: number;
    per_project_min_interval_min: number;
    max_per_project_per_day: number;
    preview_before_send: boolean;
  };
  privacy: {
    redact: boolean;
    custom_patterns: string[];
    telemetry: boolean;
    diagnostics_allowlist_only: boolean;
  };
  progress: {
    default_providers: string[];
    /** Extra directory names to search for planning documents. */
    extra_doc_dirs: string[];
  };
  thresholds: {
    stall_bash_sec: number;
    stall_fs_sec: number;
    stall_thinking_sec: number;
    /**
     * How long a session from an agent that records no pid may be quiet and
     * still count as live.
     *
     * Codex and opencode publish no process id anywhere, so for them "live" is
     * this window rather than a fact about a process. It sits next to the stall
     * thresholds because it is the same kind of number: one the product had to
     * choose, and the user is entitled to change. Wider suits an agent that
     * thinks for minutes between writes; narrower makes the board go quiet
     * sooner after a terminal is closed.
     */
    agent_recency_sec: number;
  };
  tracking: TrackingConfig;
  projects: Record<string, ProjectConfig>;
}

/**
 * Directories the user named by hand, from `[projects."<id>"] path`.
 *
 * The only projects on the board that no session produced. Archived ones are
 * left out: an archived project is one the user said they were done with, and
 * paying a git probe to keep it visible would be the opposite of that.
 */
export function configuredRoots(config: Config): Array<{ projectId: string; path: string }> {
  const out: Array<{ projectId: string; path: string }> = [];
  for (const [projectId, p] of Object.entries(config.projects)) {
    if (!p.path || p.archived) continue;
    out.push({ projectId, path: p.path });
  }
  return out;
}

export function defaultConfig(): Config {
  return {
    config_version: CONFIG_VERSION,
    server: { port: 47823, bind: '127.0.0.1', lang: 'tr', interval_ms: 3000 },
    agents: { enabled: ['claude-code', 'all'], claude_dir: '' },
    hooks: { mode: 'http', high_fidelity: false },
    digest: {
      provider: 'off',
      base_url: '',
      api_key_env: '',
      model: '',
      daily_usd_cap: 1.5,
      per_project_min_interval_min: 360,
      max_per_project_per_day: 4,
      preview_before_send: true,
    },
    privacy: {
      redact: true,
      custom_patterns: [],
      telemetry: false,
      diagnostics_allowlist_only: true,
    },
    progress: {
      default_providers: ['todowrite', 'git-branch-phase', 'gfm-checkboxes', 'todo-md'],
      extra_doc_dirs: [],
    },
    thresholds: {
      stall_bash_sec: 900,
      stall_fs_sec: 60,
      stall_thinking_sec: 300,
      agent_recency_sec: 90,
    },
    // Everything, until the user says otherwise: a tracker that shows nothing
    // on first run looks broken rather than tidy.
    tracking: { mode: 'all', selected: [] },
    projects: {},
  };
}

export interface ConfigIssue {
  /** Dotted path of the offending key, e.g. `server.port`. */
  key: string;
  severity: 'error' | 'warn';
  message: string;
  /** What to do about it. */
  fix?: string;
}

export interface LoadedConfig {
  config: Config;
  issues: ConfigIssue[];
  /** False when the file was missing or unparseable — everything is default. */
  fromFile: boolean;
}

/**
 * Sections where an unknown key is fatal rather than forward-compatible.
 * A misspelt privacy switch reads as "off" and nobody finds out.
 */
const STRICT_SECTIONS = new Set(['privacy', 'security']);

const ENUMS = {
  lang: ['tr', 'en'],
  hookMode: ['http', 'command', 'off'],
  digestProvider: ['off', 'claude-cli', 'anthropic', 'openai', 'ollama'],
  projectDigest: ['inherit', 'off'],
  trackingMode: ['all', 'selected'],
} as const;

// ── reading primitives ──────────────────────────────────────────────────

class Reader {
  issues: ConfigIssue[] = [];

  err(key: string, message: string, fix?: string): void {
    this.issues.push({ key, severity: 'error', message, fix });
  }
  warn(key: string, message: string, fix?: string): void {
    this.issues.push({ key, severity: 'warn', message, fix });
  }

  bool(t: TomlTable, section: string, key: string, fallback: boolean): boolean {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    this.err(`${section}.${key}`, `true veya false olmalı, "${show(v)}" verilmiş`);
    return fallback;
  }

  str(t: TomlTable, section: string, key: string, fallback: string): string {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v === 'string') return v;
    this.err(`${section}.${key}`, `metin olmalı, "${show(v)}" verilmiş`);
    return fallback;
  }

  enum<T extends string>(
    t: TomlTable,
    section: string,
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.err(
      `${section}.${key}`,
      `geçersiz değer "${show(v)}"`,
      `şunlardan biri olmalı: ${allowed.join(' | ')}`,
    );
    return fallback;
  }

  num(
    t: TomlTable,
    section: string,
    key: string,
    fallback: number,
    range?: { min?: number; max?: number; integer?: boolean },
  ): number {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(`${section}.${key}`, `sayı olmalı, "${show(v)}" verilmiş`);
      return fallback;
    }
    if (range?.integer && !Number.isInteger(v)) {
      this.err(`${section}.${key}`, `tam sayı olmalı, ${v} verilmiş`);
      return fallback;
    }
    if (range?.min !== undefined && v < range.min) {
      this.err(`${section}.${key}`, `en az ${range.min} olmalı, ${v} verilmiş`);
      return fallback;
    }
    if (range?.max !== undefined && v > range.max) {
      this.err(`${section}.${key}`, `en fazla ${range.max} olabilir, ${v} verilmiş`);
      return fallback;
    }
    return v;
  }

  strings(t: TomlTable, section: string, key: string, fallback: string[]): string[] {
    const v = t[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v)) {
      this.err(`${section}.${key}`, `metin dizisi olmalı, "${show(v)}" verilmiş`);
      return fallback;
    }
    const bad = v.findIndex((x) => typeof x !== 'string');
    if (bad !== -1) {
      this.err(`${section}.${key}[${bad}]`, `metin olmalı, "${show(v[bad])}" verilmiş`);
      return fallback;
    }
    return v as string[];
  }

  table(root: TomlTable, key: string): TomlTable {
    const v = root[key];
    if (v === undefined) return {};
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
    this.err(key, `[${key}] bir bölüm olmalı`, `"${key} = …" yerine "[${key}]" başlığı kullan`);
    return {};
  }

  /** Flag keys we do not know about — fatal in strict sections. */
  unknown(t: TomlTable, section: string, known: readonly string[]): void {
    for (const k of Object.keys(t)) {
      if (known.includes(k)) continue;
      const key = `${section}.${k}`;
      if (STRICT_SECTIONS.has(section)) {
        this.err(key, 'bilinmeyen ayar', `yazım hatası olabilir; bilinenler: ${known.join(', ')}`);
      } else {
        this.warn(key, 'bilinmeyen ayar — yok sayıldı', 'daha yeni bir sürüm için yazılmış olabilir');
      }
    }
  }
}

function show(v: TomlValue | undefined): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (Array.isArray(v)) return `[${v.length} öğe]`;
  if (typeof v === 'object' && v !== null) return '{…}';
  return String(v);
}

// ── validation ──────────────────────────────────────────────────────────

const KNOWN_SECTIONS = [
  'config_version',
  'server',
  'agents',
  'hooks',
  'digest',
  'privacy',
  'progress',
  'thresholds',
  'tracking',
  'projects',
];

/**
 * Turn a parsed TOML table into a Config. Never throws: everything that is
 * wrong comes back as an issue and the corresponding default is kept.
 */
export function validateConfig(raw: TomlTable): { config: Config; issues: ConfigIssue[] } {
  const d = defaultConfig();
  const r = new Reader();

  const version = r.num(raw, '', 'config_version', CONFIG_VERSION, { integer: true, min: 1 });
  if (version > CONFIG_VERSION) {
    r.warn(
      'config_version',
      `config sürümü ${version}, bu VibeTracker ${CONFIG_VERSION} biliyor`,
      'daha yeni bir sürüm için yazılmış — tanımadığı ayarlar yok sayılacak',
    );
  }

  for (const k of Object.keys(raw)) {
    if (!KNOWN_SECTIONS.includes(k)) {
      r.warn(k, 'bilinmeyen bölüm — yok sayıldı');
    }
  }

  const server = r.table(raw, 'server');
  r.unknown(server, 'server', ['port', 'bind', 'lang', 'interval_ms']);
  const bind = r.str(server, 'server', 'bind', d.server.bind);
  if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
    // Not an error: binding wider is a legitimate, deliberate choice. But it
    // is the single setting that turns a local tool into a network service,
    // so it never happens quietly.
    r.warn(
      'server.bind',
      `panel "${bind}" üzerinde dinleyecek — ağdaki herkes erişebilir`,
      'yalnızca bu makine için: bind = "127.0.0.1"',
    );
  }

  const agents = r.table(raw, 'agents');
  r.unknown(agents, 'agents', ['enabled', 'claude_dir']);

  const hooks = r.table(raw, 'hooks');
  r.unknown(hooks, 'hooks', ['mode', 'high_fidelity']);

  const digest = r.table(raw, 'digest');
  r.unknown(digest, 'digest', [
    'provider',
    'model',
    'base_url',
    'api_key_env',
    'daily_usd_cap',
    'per_project_min_interval_min',
    'max_per_project_per_day',
    'preview_before_send',
  ]);
  // `api` was what "bring your own key" was called when Anthropic was the only
  // thing it could reach. Renaming it without accepting the old spelling would
  // turn one `vt init` answer into a config error on the next upgrade, so it is
  // read as what it always meant.
  if (digest['provider'] === 'api') digest['provider'] = 'anthropic';

  const privacy = r.table(raw, 'privacy');
  r.unknown(privacy, 'privacy', [
    'redact',
    'custom_patterns',
    'telemetry',
    'diagnostics_allowlist_only',
  ]);
  const customPatterns = r.strings(privacy, 'privacy', 'custom_patterns', d.privacy.custom_patterns);
  const validPatterns: string[] = [];
  for (const [i, p] of customPatterns.entries()) {
    try {
      new RegExp(p, 'gu');
      validPatterns.push(p);
    } catch (e) {
      // A broken redaction pattern is a hole in the one defence that runs on
      // every write, so it is reported rather than silently skipped.
      r.err(
        `privacy.custom_patterns[${i}]`,
        `geçersiz düzenli ifade: ${(e as Error).message}`,
        'bu desen redaksiyona dahil edilmedi',
      );
    }
  }

  const progress = r.table(raw, 'progress');
  r.unknown(progress, 'progress', ['default_providers', 'extra_doc_dirs']);

  const thresholds = r.table(raw, 'thresholds');
  r.unknown(thresholds, 'thresholds', [
    'stall_bash_sec',
    'stall_fs_sec',
    'stall_thinking_sec',
    'agent_recency_sec',
  ]);

  const tracking = r.table(raw, 'tracking');
  r.unknown(tracking, 'tracking', ['mode', 'selected']);

  const config: Config = {
    config_version: version,
    server: {
      port: r.num(server, 'server', 'port', d.server.port, { integer: true, min: 1, max: 65535 }),
      bind,
      lang: r.enum(server, 'server', 'lang', ENUMS.lang, d.server.lang),
      interval_ms: r.num(server, 'server', 'interval_ms', d.server.interval_ms, {
        integer: true,
        min: 500,
        max: 600_000,
      }),
    },
    agents: {
      enabled: r.strings(agents, 'agents', 'enabled', d.agents.enabled),
      claude_dir: r.str(agents, 'agents', 'claude_dir', d.agents.claude_dir),
    },
    hooks: {
      mode: r.enum(hooks, 'hooks', 'mode', ENUMS.hookMode, d.hooks.mode),
      high_fidelity: r.bool(hooks, 'hooks', 'high_fidelity', d.hooks.high_fidelity),
    },
    digest: {
      provider: r.enum(digest, 'digest', 'provider', ENUMS.digestProvider, d.digest.provider),
      model: r.str(digest, 'digest', 'model', d.digest.model),
      base_url: r.str(digest, 'digest', 'base_url', d.digest.base_url),
      api_key_env: r.str(digest, 'digest', 'api_key_env', d.digest.api_key_env),
      daily_usd_cap: r.num(digest, 'digest', 'daily_usd_cap', d.digest.daily_usd_cap, { min: 0 }),
      per_project_min_interval_min: r.num(
        digest,
        'digest',
        'per_project_min_interval_min',
        d.digest.per_project_min_interval_min,
        { integer: true, min: 0 },
      ),
      max_per_project_per_day: r.num(
        digest,
        'digest',
        'max_per_project_per_day',
        d.digest.max_per_project_per_day,
        { integer: true, min: 0 },
      ),
      preview_before_send: r.bool(
        digest,
        'digest',
        'preview_before_send',
        d.digest.preview_before_send,
      ),
    },
    privacy: {
      redact: r.bool(privacy, 'privacy', 'redact', d.privacy.redact),
      custom_patterns: validPatterns,
      telemetry: r.bool(privacy, 'privacy', 'telemetry', d.privacy.telemetry),
      diagnostics_allowlist_only: r.bool(
        privacy,
        'privacy',
        'diagnostics_allowlist_only',
        d.privacy.diagnostics_allowlist_only,
      ),
    },
    progress: {
      default_providers: r.strings(
        progress,
        'progress',
        'default_providers',
        d.progress.default_providers,
      ),
      extra_doc_dirs: r.strings(progress, 'progress', 'extra_doc_dirs', d.progress.extra_doc_dirs),
    },
    thresholds: {
      stall_bash_sec: r.num(thresholds, 'thresholds', 'stall_bash_sec', d.thresholds.stall_bash_sec, {
        min: 1,
      }),
      stall_fs_sec: r.num(thresholds, 'thresholds', 'stall_fs_sec', d.thresholds.stall_fs_sec, {
        min: 1,
      }),
      stall_thinking_sec: r.num(
        thresholds,
        'thresholds',
        'stall_thinking_sec',
        d.thresholds.stall_thinking_sec,
        { min: 1 },
      ),
      agent_recency_sec: r.num(
        thresholds,
        'thresholds',
        'agent_recency_sec',
        d.thresholds.agent_recency_sec,
        { min: 1, max: 86_400 },
      ),
    },
    tracking: {
      mode: r.enum(tracking, 'tracking', 'mode', ENUMS.trackingMode, d.tracking.mode),
      selected: r.strings(tracking, 'tracking', 'selected', d.tracking.selected),
    },
    projects: {},
  };

  // A selection that selects nothing would show an empty board with no hint
  // as to why. Falling back to everything is the recoverable reading.
  if (config.tracking.mode === 'selected' && config.tracking.selected.length === 0) {
    r.warn(
      'tracking.selected',
      'izlenecek proje seçilmemiş — hepsi gösteriliyor',
      'vt projects add <proje> ile seç, ya da mode = all yaz',
    );
    config.tracking.mode = 'all';
  }

  // Turning redaction off is legitimate on a machine that never leaves the
  // desk, but it disables the only guard on what reaches the database.
  if (!config.privacy.redact) {
    r.warn(
      'privacy.redact',
      'redaksiyon kapalı — hata metinleri ve alıntılar olduğu gibi saklanacak',
      'sırlar transcript metninde geçebiliyor; kapalı tutmayı bilerek seçtiysen sorun yok',
    );
  }

  const projects = r.table(raw, 'projects');
  for (const [id, value] of Object.entries(projects)) {
    const section = `projects."${id}"`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      r.err(section, 'bir bölüm olmalı');
      continue;
    }
    const p = value as TomlTable;
    r.unknown(p, section, ['path', 'display_name', 'providers', 'digest', 'archived']);
    const entry: ProjectConfig = {};
    if (p.path !== undefined) entry.path = r.str(p, section, 'path', '');
    if (p.display_name !== undefined) entry.display_name = r.str(p, section, 'display_name', '');
    if (p.providers !== undefined) entry.providers = r.strings(p, section, 'providers', []);
    if (p.digest !== undefined) {
      entry.digest = r.enum(p, section, 'digest', ENUMS.projectDigest, 'inherit');
    }
    if (p.archived !== undefined) entry.archived = r.bool(p, section, 'archived', false);
    config.projects[id] = entry;
  }

  return { config, issues: r.issues };
}

/**
 * Parse and validate config text. A syntax error yields defaults plus one
 * error naming the line — the daemon still starts, which is the whole point.
 */
export function loadConfigText(text: string): LoadedConfig {
  let raw: TomlTable;
  try {
    raw = parseToml(text);
  } catch (e) {
    const msg = e instanceof TomlError ? e.message : String((e as Error).message ?? e);
    return {
      config: defaultConfig(),
      issues: [
        {
          key: 'config.toml',
          severity: 'error',
          message: `okunamadı: ${msg}`,
          fix: 'varsayılan ayarlarla devam ediliyor — dosyayı düzeltip yeniden başlat',
        },
      ],
      fromFile: false,
    };
  }
  const { config, issues } = validateConfig(raw);
  return { config, issues, fromFile: true };
}

/** Format issues for a terminal. */
export function formatIssues(issues: ConfigIssue[]): string[] {
  return issues.map((i) => {
    const glyph = i.severity === 'error' ? '✖' : '!';
    const head = `${glyph} ${i.key ? `${i.key}: ` : ''}${i.message}`;
    return i.fix ? `${head}\n    → ${i.fix}` : head;
  });
}
