/**
 * Which provider choices may arrive over a socket.
 *
 * `provider.ts` answers "what can this tool talk to". This file answers a
 * narrower and more suspicious question: of those, which may be chosen by
 * something that is not a person at a terminal.
 *
 * The dashboard is a page in a browser, authenticated by a token in a URL, on
 * a port every process on the machine can reach. Everything else it can write
 * is a *viewing* decision — which projects to show, which directory to watch.
 * Those settle into a config file and change what a panel displays.
 *
 * `[digest] command` does not. It settles into the same file and then, the
 * next time somebody types `vt digest`, it is executed. A POST that could set
 * it would turn a program whose entire promise is that it only ever reads into
 * a way to run a chosen binary later — which is the one thing this product has
 * said from the first plan it will never be. So `cli` is not selectable here.
 * It stays a config-file answer, written by the hand of whoever owns the
 * machine, which is exactly the audience it was designed for: the people who
 * run something this codebase has never heard of.
 *
 * Nothing is lost from the dashboard by that. `cli` that is *already*
 * configured is still reported, with its command line, and can still be
 * switched away from — moving off an arbitrary command is not the dangerous
 * direction.
 *
 * The remaining choices are checked rather than trusted, for a second reason
 * that has nothing to do with attackers: every value here is written into a
 * TOML file that a human opens in an editor. A stray newline in a model name
 * breaks that file for them, not for us.
 */
import { DEFAULT_BASE, DEFAULT_KEY_ENV, type ProviderId } from './provider.ts';
import { CLI_PRESETS } from './presets.ts';

/**
 * The providers a remote caller may select, in the order a chooser shows them.
 *
 * `off` first because it is the default and the recommendation; the two local
 * or already-signed-in answers next because they cost nothing and need no key;
 * the two that need an account last.
 */
export const SELECTABLE_PROVIDERS: readonly ProviderId[] = [
  'off',
  'ollama',
  // Every preset in the table. Derived rather than listed, so adding an agent
  // CLI reaches the dashboard without a second edit — which is the whole point
  // of the table, and was the thing that made `opencode` unreachable from the
  // window while `codex` beside it was fine.
  ...CLI_PRESETS.map((p) => p.id as ProviderId),
  'openai',
  'anthropic',
];

export function isSelectable(p: string): p is ProviderId {
  return (SELECTABLE_PROVIDERS as readonly string[]).includes(p);
}

/** The four keys a chooser may write. `command` and `args` are not among them. */
export interface ProviderChoice {
  provider: ProviderId;
  /** Empty means the provider's own default. */
  model: string;
  /** Empty means the provider's own address. Only ever set for `openai`/`ollama`. */
  baseUrl: string;
  /** The *name* of the variable holding the key. Never the key. */
  keyEnv: string;
}

/**
 * Why a choice was refused, as a code rather than a sentence.
 *
 * The wording belongs to whichever surface is talking to the person — the
 * dashboard says it in the page's language, and this module has no business
 * knowing which language that is.
 */
export type ChoiceRefusal =
  | 'shape'
  | 'provider'
  | 'cli'
  | 'model'
  | 'base_url'
  | 'base_url_scheme'
  | 'key_env'
  | 'key_env_looks_like_key';

export type ChoiceResult =
  | { ok: true; value: ProviderChoice }
  | { ok: false; reason: ChoiceRefusal };

/** No control characters, no line breaks: this becomes one line of TOML. */
function oneLine(s: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(s);
}

/**
 * Does this look like somebody pasted the key into the box that wants its name?
 *
 * Worth a distinct answer rather than a generic "invalid", because it is the
 * mistake the field invites and the consequence is the one thing this design
 * exists to prevent: a live credential written into a file that gets backed
 * up, screenshotted and attached to bug reports. Every real key format carries
 * a character an environment variable name cannot have, so the name rule
 * already rejects it — this only makes the refusal say why.
 */
function looksLikeSecret(s: string): boolean {
  return /^(sk|pk|xox|gh[pousr]|github_pat|AIza|AKIA|ASIA)[-_]/.test(s) || s.length > 64;
}

/**
 * Validate one choice from an untrusted body.
 *
 * Absent fields are empty, not "leave as they were": a chooser that shows all
 * four boxes and sends three of them means the fourth was cleared. Partial
 * updates would need a shape that says which keys are present, and inventing
 * one for four fields would be more machinery than the thing it configures.
 */
export function validateChoice(input: unknown): ChoiceResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'shape' };
  const b = input as Record<string, unknown>;

  const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
  if (provider === 'cli') return { ok: false, reason: 'cli' };
  if (!isSelectable(provider)) return { ok: false, reason: 'provider' };

  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const model = text(b.model);
  if (model.length > 120 || !oneLine(model)) return { ok: false, reason: 'model' };

  const keyEnv = text(b.api_key_env ?? b.keyEnv);
  if (keyEnv) {
    if (looksLikeSecret(keyEnv)) return { ok: false, reason: 'key_env_looks_like_key' };
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(keyEnv)) return { ok: false, reason: 'key_env' };
  }

  // Only two families have an address worth naming. Anthropic's is fixed, and
  // the CLI and `off` answers have none at all — so rather than store a value
  // that will never be read, they are cleared. A config file that pins an
  // endpoint for a provider that does not use one is a question the next
  // reader has to answer.
  let baseUrl = '';
  if (provider === 'openai' || provider === 'ollama') {
    baseUrl = text(b.base_url ?? b.baseUrl);
    if (baseUrl) {
      if (baseUrl.length > 400 || !oneLine(baseUrl)) return { ok: false, reason: 'base_url' };
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        return { ok: false, reason: 'base_url' };
      }
      // `file:` would make the payload a filename, and the exotic schemes are
      // not things `fetch` speaks. Two are enough.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'base_url_scheme' };
      }
      // Pressing enter on the placeholder should not pin the default into the
      // file — `vt init` normalises the same way, and a config that names the
      // address it would have used anyway ages badly when the default moves.
      if (baseUrl.replace(/\/+$/, '') === DEFAULT_BASE[provider].replace(/\/+$/, '')) baseUrl = '';
    }
  }

  // The same normalisation for the variable name: naming the conventional one
  // is not a decision, and writing it down makes it look like one.
  const conventional = DEFAULT_KEY_ENV[provider];
  return {
    ok: true,
    value: { provider, model, baseUrl, keyEnv: keyEnv === conventional ? '' : keyEnv },
  };
}
