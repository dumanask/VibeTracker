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
  /** Only asked about when the provider is one that can point somewhere else. */
  digestModel?: string;
  digestBaseUrl?: string;
  digestKeyEnv?: string;
  /** Only asked about when the provider is `cli`. */
  digestCommand?: string;
  digestArgs?: string[];
  agents: string[];
}

/**
 * The commented starter file. Every setting a first-time user is likely to
 * want is present and explained; everything else is documented as available
 * rather than written out, so the file stays short enough to read.
 */
export function configTemplate(c: TemplateChoices): string {
  const d = defaultConfig();
  return `# VibeTracker configuration
# This file is meant to be edited by hand. After a change: vt daemon --restart
# An invalid setting does not stop the daemon -- it falls back to the default
# and says so on the dashboard.

config_version = ${CONFIG_VERSION}

[server]
# The port is fixed: hook URLs sit in settings.json as plain text and cannot
# be changed at runtime. If you change it here, rewrite the hooks too with
# "vt hooks install".
port = ${c.port}

# "127.0.0.1" = this computer only. Any other value opens the dashboard to
# the network.
bind = ${tomlValue(c.bind)}

lang = ${tomlValue(c.lang)}          # en | tr
interval_ms = ${d.server.interval_ms}   # scan interval

[agents]
enabled = ${tomlValue(c.agents)}
# Empty = $CLAUDE_CONFIG_DIR, and ~/.claude when that is unset too.
claude_dir = ''

[hooks]
# http    : sees permission prompts for certain (recommended)
# command : ~100 ms of process startup per agent, and never blocks
# off     : passive detection only; "waiting for permission" stays invisible
mode = ${tomlValue(c.hooksMode)}
# Whether to wire up PreToolUse/PostToolUse as well. Very high volume, and
# the tool detail already arrives from the transcript.
high_fidelity = false

[digest]
# The LLM summary is OFF by default. Turn it on and a *summary* of your plan
# documents goes to the model -- never the plan files themselves, never the
# transcript, never code or file contents.
# While it is off, every number on the dashboard is computed by the local
# engine and nothing leaves the machine.
#
#   off        : off
#   ollama     : the Ollama on your machine. No key, no data leaves.
#
#   An agent CLI you are already signed in to -- it needs no key and bills
#   that program's own account. To see which are installed:
#   "vt digest providers"
#
#     claude-cli   codex-cli   opencode-cli   gemini-cli   qwen-cli
#     crush-cli    droid-cli   goose-cli      copilot-cli  continue-cli
#     amp-cli      aider-cli   llm-cli
#
#   The prompt is always handed over on stdin (for aider, in a 0600 file);
#   it is never written on a command line, because anyone on the machine can
#   read a command line.
#
#   cli        : any command not in that list -- see "command" and "args"
#                below. It cannot be picked from the dashboard; this file is
#                the only way to set it.
#   anthropic  : the Anthropic API
#   openai     : the OpenAI *shape*. With base_url that covers OpenRouter,
#                Groq, DeepSeek, Mistral, xAI, Together, LM Studio, vLLM,
#                llama.cpp and Gemini's compatibility endpoint.
provider = ${tomlValue(c.digestProvider)}
model = ${tomlValue(c.digestModel ?? '')}                    # empty = the provider's default
base_url = ${tomlValue(c.digestBaseUrl ?? '')}                 # empty = the provider's own address
# The NAME of the environment variable that holds the key, never the key
# itself. This file gets backed up, screenshotted and read by
# "vt doctor --bundle"; a secret does not belong in it. Leave it empty and
# the provider's usual variable is tried, then the 0600 file written by
# "vt digest key".
api_key_env = ${tomlValue(c.digestKeyEnv ?? '')}

# The command to run when provider = "cli". The text arrives on stdin -- it
# is NEVER written on a command line, because a command line is visible to
# everyone in the process table and this text is a summary of your plan
# documents.
# Placeholders: {prompt_file} (0600, deleted afterwards), {output_file}, {model}
#
# A program from the list above needs none of this; these two lines are for
# what is NOT on the list. For example a CLI that wants the prompt as an
# argument:
#
#   command = 'cursor-agent' / args = ['-p', '--output-format', 'text']
#   command = 'my-own-script' / args = ['{prompt_file}', '{output_file}']
command = ${tomlValue(c.digestCommand ?? '')}
args = ${tomlValue(c.digestArgs ?? [])}
daily_usd_cap = ${d.digest.daily_usd_cap}
per_project_min_interval_min = ${d.digest.per_project_min_interval_min}
max_per_project_per_day = ${d.digest.max_per_project_per_day}
preview_before_send = true   # show the payload before sending it

[privacy]
# CAREFUL: an unknown key in this section is an error. We would rather not
# leave a protection on that a typo made you believe was off.
redact = true
custom_patterns = []          # your own secret shapes (regular expressions)
telemetry = false             # off; you do not need to turn it on
diagnostics_allowlist_only = true

[progress]
# Where phase and progress are read from. The order is the priority.
default_providers = ${tomlValue(d.progress.default_providers)}
# Extra folder names to look for plan documents in (docs, plans and plan are
# already included).
extra_doc_dirs = []

[thresholds]
# How long a tool has to be open before it counts as stalled (seconds).
stall_bash_sec = ${d.thresholds.stall_bash_sec}       # a test or build really does take minutes
stall_fs_sec = ${d.thresholds.stall_fs_sec}          # local file work does not
stall_thinking_sec = ${d.thresholds.stall_thinking_sec}

[tracking]
# Which projects you are following.
#   all      -- all of them (the default)
#   selected -- only the list below
# You do not have to edit this by hand: "vt projects add/rm <project>" and
# "choose what to track" on the dashboard write the same place, and keep
# your comments.
mode = "all"
selected = []

# Per-project settings, keyed by project id. You can find the ids in
# "vt status --json". Nothing is ever written into the project's own folder.
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
