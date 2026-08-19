/**
 * What a socket may and may not choose.
 *
 * These are not shape checks for their own sake. The dashboard writes into the
 * same config file `vt digest` reads later, and one of the seven providers —
 * `cli` — names a program that is then executed. A validator that let that
 * through would turn a tool whose entire promise is that it only reads into a
 * way to have a chosen binary run afterwards, which is the one thing this
 * product has said since its first plan it will not do.
 *
 * The rest of the rules are about a different reader: the human who opens that
 * TOML file in an editor. A newline inside a model name breaks the file for
 * them, not for us.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChoice, SELECTABLE_PROVIDERS } from '../src/digest/select.ts';
import { DEFAULT_BASE } from '../src/digest/provider.ts';

/** The reason, or `null` when the choice was accepted. */
function refusal(input: unknown): string | null {
  const r = validateChoice(input);
  return r.ok ? null : r.reason;
}

test('the provider that runs a command of your choosing is refused, with its own reason', () => {
  // A distinct code rather than a generic "invalid provider": the panel says
  // *why* and points at the config file, and a person who typed `cli` on
  // purpose deserves that sentence rather than "no such provider".
  assert.equal(refusal({ provider: 'cli', command: 'calc.exe' }), 'cli');
  assert.equal(refusal({ provider: 'cli' }), 'cli');
  // And it is refused whatever else rides along — a command is never read out
  // of this body, so there is nothing here that could smuggle one in.
  const r = validateChoice({ provider: 'ollama', command: 'calc.exe', args: ['/c', 'del'] });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value).sort(), ['baseUrl', 'keyEnv', 'model', 'provider']);
});

test('only the six named providers are accepted', () => {
  for (const p of SELECTABLE_PROVIDERS) assert.equal(refusal({ provider: p }), null, p);
  for (const p of ['', 'nope', 'CLI', 42, null, undefined]) {
    assert.equal(refusal({ provider: p }), 'provider', String(p));
  }
  // Surrounding whitespace is trimmed rather than refused. A radio button
  // never sends any; a hand-written curl might, and rejecting it would be
  // strictness with nothing behind it.
  assert.equal(refusal({ provider: '  off  ' }), null);
  assert.equal(refusal('off'), 'shape');
  assert.equal(refusal(null), 'shape');
});

test('an address must be one this codebase can actually open', () => {
  assert.equal(refusal({ provider: 'openai', base_url: 'https://openrouter.ai/api/v1' }), null);
  assert.equal(refusal({ provider: 'ollama', base_url: 'http://127.0.0.1:11434' }), null);
  assert.equal(refusal({ provider: 'openai', base_url: 'file:///etc/passwd' }), 'base_url_scheme');
  assert.equal(refusal({ provider: 'openai', base_url: 'javascript:alert(1)' }), 'base_url_scheme');
  assert.equal(refusal({ provider: 'openai', base_url: 'not a url' }), 'base_url');
  assert.equal(refusal({ provider: 'openai', base_url: 'https://x/' + 'y'.repeat(500) }), 'base_url');
});

test('an address is dropped for the providers that have none', () => {
  // Otherwise the file pins an endpoint for a provider that will never read
  // it, and the next person to open the file has a question to answer.
  for (const p of ['off', 'claude-cli', 'codex-cli', 'anthropic']) {
    const r = validateChoice({ provider: p, base_url: 'https://evil.example' });
    assert.ok(r.ok, p);
    assert.equal(r.value.baseUrl, '', p);
  }
});

test('the default address and the conventional variable name are not written down', () => {
  // Pressing enter on a placeholder is not a decision, and recording it as one
  // means the config keeps pointing at an old default after the default moves.
  const a = validateChoice({ provider: 'ollama', base_url: DEFAULT_BASE.ollama });
  assert.ok(a.ok);
  assert.equal(a.value.baseUrl, '');

  const b = validateChoice({ provider: 'openai', base_url: DEFAULT_BASE.openai + '/' });
  assert.ok(b.ok);
  assert.equal(b.value.baseUrl, '');

  const c = validateChoice({ provider: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY' });
  assert.ok(c.ok);
  assert.equal(c.value.keyEnv, '');

  const d = validateChoice({ provider: 'anthropic', api_key_env: 'WORK_ANTHROPIC_KEY' });
  assert.ok(d.ok);
  assert.equal(d.value.keyEnv, 'WORK_ANTHROPIC_KEY');
});

test('a pasted key is refused as a key, not as a typo', () => {
  // The field asks for the *name* of an environment variable and invites
  // exactly this mistake. Every real key format carries a character a variable
  // name cannot have, so the name rule alone would reject it — this is about
  // the sentence the person reads, because the consequence of getting it wrong
  // is a live credential in a file that is backed up and screenshotted.
  for (const k of ['sk-ant-api03-abcdef', 'sk_live_abcdef', 'ghp_0123456789', 'AIza-abcdefgh']) {
    assert.equal(refusal({ provider: 'anthropic', api_key_env: k }), 'key_env_looks_like_key', k);
  }
  assert.equal(refusal({ provider: 'anthropic', api_key_env: 'a'.repeat(80) }), 'key_env_looks_like_key');
  assert.equal(refusal({ provider: 'anthropic', api_key_env: 'MY KEY' }), 'key_env');
  assert.equal(refusal({ provider: 'anthropic', api_key_env: '1KEY' }), 'key_env');
  assert.equal(refusal({ provider: 'anthropic', api_key_env: 'MY_KEY_2' }), null);
});

test('nothing that would break the file for a human gets in', () => {
  const nl = String.fromCharCode(10);
  assert.equal(refusal({ provider: 'openai', model: 'gpt' + nl + 'evil = 1' }), 'model');
  assert.equal(refusal({ provider: 'openai', model: 'x'.repeat(200) }), 'model');
  // Interior, not trailing: a trailing one is trimmed off like any other
  // stray whitespace, and `new URL` would quietly strip an interior one — so
  // the raw string is what gets checked, because the raw string is what is
  // written to the file.
  assert.equal(refusal({ provider: 'openai', base_url: 'https://a.b/x' + nl + 'y' }), 'base_url');
  assert.equal(refusal({ provider: 'openai', base_url: 'https://a.b/ ' + nl }), null);
  // Quotes and backslashes are fine — `setTomlValues` escapes them — so a
  // model name with punctuation is not treated as an attack.
  assert.equal(refusal({ provider: 'openai', model: 'my "best" model' }), null);
});

test('a missing field means empty, not unchanged', () => {
  // Four fields and no shape saying which are present: a chooser that shows
  // all of them and sends three has cleared the fourth, and guessing
  // "unchanged" would make clearing a box impossible.
  const r = validateChoice({ provider: 'openai' });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { provider: 'openai', model: '', baseUrl: '', keyEnv: '' });
});
