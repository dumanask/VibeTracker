/**
 * The `[digest]` section, as something a window can show and change.
 *
 * `vt digest providers` already answers "which model, and can it work" for a
 * terminal. This is the same answer shaped for a page, and it exists because
 * the terminal was the *only* place the answer could be changed: the choice
 * was made once during `vt init` and after that the instruction was "open the
 * config file". A setting nobody can find is a setting that stays at its
 * default, and for this one the default is `off`.
 *
 * Two things are deliberately not here.
 *
 * The key never is. Not read back, not accepted, not echoed — the response
 * carries whether one exists, four characters of it, and where it came from.
 * The config file holds the *name* of an environment variable for the same
 * reason: that file is backed up, screenshotted and read by `vt doctor
 * --bundle`, and a page that could hand a secret to it would undo the whole
 * arrangement. Writing one stays `vt digest key`, which is a 0600 file and one
 * command.
 *
 * The `cli` command never is either — see `select.ts` for why. It is reported
 * here, with the program it would run and whether that program exists, because
 * hiding a configured provider from its own settings panel would be worse than
 * not offering it.
 */
import {
  DEFAULT_BASE,
  DEFAULT_KEY_ENV,
  DEFAULT_MODEL,
  SELECTABLE_PROVIDERS,
  egress,
  isCliProvider,
  keyFilePath,
  maskKey,
  needsKey,
  resolveKey,
  type Egress,
  type ProviderId,
} from '@vibetracker/engine';
import { whichCommand } from '@vibetracker/platform';

/** The `[digest]` keys this surface reads. A subset of the config's own type. */
export interface DigestConfigSlice {
  provider: ProviderId;
  model: string;
  base_url: string;
  api_key_env: string;
  command: string;
  args: string[];
}

export interface DigestOption {
  id: ProviderId;
  /**
   * Whether the program this option needs is on the PATH.
   *
   * `null` for the options where the question does not apply. A tri-state
   * rather than a false, because "we looked and it is not there" and "there is
   * nothing to look for" render differently and only one of them is a reason
   * not to pick it.
   */
  installed: boolean | null;
  needsKey: boolean;
  egress: Egress;
  /**
   * What this option would use if nothing were typed.
   *
   * Sent so a chooser can show them as placeholders. A form whose model box is
   * empty implies the choice has no model, when in fact leaving it empty is
   * the recommended answer and a real name is behind it.
   */
  modelDefault: string;
  baseUrlDefault: string;
  keyEnvDefault: string | null;
}

export interface DigestView {
  provider: ProviderId;
  /** As written in the file; empty means the provider's own default. */
  model: string;
  baseUrl: string;
  keyEnv: string;
  /** What would actually be used, defaults filled in. */
  modelEffective: string;
  baseUrlEffective: string;
  keyEnvDefault: string | null;
  /** `cli` only. Empty otherwise. */
  command: string;
  commandLine: string;
  commandPath: string | null;
  needsKey: boolean;
  key: {
    present: boolean;
    masked: string | null;
    from: 'env' | 'file' | 'none';
    envName: string | null;
  };
  /** Where `vt digest key` would put one, so the page can name the file. */
  keyFile: string;
  ready: boolean;
  egress: Egress;
  /**
   * Whether the configured provider is one this panel could have set.
   *
   * False exactly while `cli` is configured. Saying so is not the same as
   * saying the panel is read-only — moving *off* an arbitrary command is
   * allowed and is the direction that reduces what is possible. It is there so
   * the page can show the current answer as state rather than as an option
   * that mysteriously will not tick.
   */
  inOptions: boolean;
  options: DigestOption[];
}

/** The program a CLI provider runs, or empty for the ones that open a socket. */
function programOf(d: DigestConfigSlice): string {
  if (d.provider === 'claude-cli') return 'claude';
  if (d.provider === 'codex-cli') return 'codex';
  if (d.provider === 'cli') return d.command.trim();
  return '';
}

/** What a CLI provider will actually run, as one line. Mirrors `vt digest`. */
function commandLineOf(d: DigestConfigSlice): string {
  if (d.provider === 'claude-cli') return 'claude -p';
  if (d.provider === 'codex-cli') return 'codex exec';
  if (d.provider === 'cli') return [d.command, ...d.args].filter(Boolean).join(' ');
  return '';
}

function optionFor(id: ProviderId): DigestOption {
  const program = id === 'claude-cli' ? 'claude' : id === 'codex-cli' ? 'codex' : id === 'ollama' ? 'ollama' : '';
  return {
    id,
    installed: program ? whichCommand(program) !== null : null,
    needsKey: id !== 'off' && needsKey(id, ''),
    // The address a fresh choice would use, since that is what picking it now
    // would mean. An `openai` already pointed at loopback reports `no` in the
    // view above; this list is about what the options are, not what one is.
    egress: egress({ provider: id, model: '', baseUrl: '', apiKey: null }),
    modelDefault: DEFAULT_MODEL[id],
    baseUrlDefault: id === 'openai' || id === 'ollama' ? DEFAULT_BASE[id] : '',
    keyEnvDefault: DEFAULT_KEY_ENV[id],
  };
}

export function digestView(d: DigestConfigSlice): DigestView {
  const key = resolveKey(d.provider, d.api_key_env);
  const program = programOf(d);
  const commandPath = program ? whichCommand(program) : null;
  const wantsKey = d.provider !== 'off' && needsKey(d.provider, d.base_url);
  const baseUrlEffective =
    d.provider === 'off' || isCliProvider(d.provider)
      ? ''
      : d.base_url || DEFAULT_BASE[d.provider];

  // "Ready" means the next `vt digest` would get as far as talking to
  // something. For a CLI provider that is whether the program exists — the
  // failure that otherwise surfaces as a stack trace after a minute of
  // waiting, on the one command that costs the user something.
  const ready =
    d.provider === 'off'
      ? false
      : isCliProvider(d.provider)
        ? program !== '' && commandPath !== null
        : !wantsKey || key.key !== null;

  return {
    provider: d.provider,
    model: d.model,
    baseUrl: d.base_url,
    keyEnv: d.api_key_env,
    modelEffective: d.model || DEFAULT_MODEL[d.provider],
    baseUrlEffective,
    keyEnvDefault: DEFAULT_KEY_ENV[d.provider],
    command: d.provider === 'cli' ? d.command : '',
    commandLine: commandLineOf(d),
    commandPath,
    needsKey: wantsKey,
    key: {
      present: key.key !== null,
      masked: key.key === null ? null : maskKey(key.key),
      from: key.from,
      envName: key.envName ?? null,
    },
    keyFile: keyFilePath(),
    ready,
    egress: egress({
      provider: d.provider,
      model: d.model,
      baseUrl: d.base_url,
      apiKey: null,
    }),
    inOptions: d.provider !== 'cli',
    options: SELECTABLE_PROVIDERS.map(optionFor),
  };
}
