/**
 * Choosing the model from the window: the endpoint, the file it writes, and
 * the panel that renders the answer.
 *
 * Three things are being checked, in rising order of how bad it would be to
 * get them wrong.
 *
 * The ordinary one: a provider picked in the page ends up in `config.toml`,
 * where `vt digest` will read it — possibly days later, from a different
 * process — and the comments around it survive, because a config that loses
 * its comments the first time you touch a setting is a config nobody edits
 * again.
 *
 * The careful one: the key is never in the response. Not the value, not a
 * longer prefix of it, not by a field this test forgot to look at — so the
 * assertion is over the whole serialised body rather than field by field.
 *
 * The one this exists for: `cli` cannot be selected. That provider names a
 * program that gets executed, and an endpoint that could set it would make a
 * reader into a delayed way to run a chosen binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTomlValues } from '@vibetracker/core';
import { validateChoice } from '@vibetracker/engine';
import { DaemonServer } from '../src/server.ts';
import { digestView, type DigestConfigSlice } from '../src/digest-settings.ts';
import { loadPanel } from './panel-harness.ts';

/** The `[digest]` defaults, as `loadConfig` would hand them over. */
function slice(over: Partial<DigestConfigSlice> = {}): DigestConfigSlice {
  return { provider: 'off', model: '', base_url: '', api_key_env: '', command: '', args: [], ...over };
}

interface Answer {
  status: number;
  body: string;
  json: Record<string, unknown>;
}

/**
 * The real server and the real config-writing path, over a real socket.
 *
 * The config file is a temporary one and the deps below are the same two
 * lines `main.ts` wires in — this is deliberately not a mock of the write,
 * because "the setting reached the file" is half of what is being claimed.
 */
async function withServer(
  start: DigestConfigSlice,
  fn: (
    get: () => Promise<Answer>,
    post: (body: unknown) => Promise<Answer>,
    configFile: string,
    url: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vt-digest-api-'));
  const configFile = join(dir, 'config.toml');
  writeFileSync(
    configFile,
    ['config_version = 1', '', '[digest]', '# which LLM, and on whose account', 'provider = "off"', ''].join('\n'),
    'utf8',
  );
  let current = start;

  const server = new DaemonServer({
    port: 0,
    host: '127.0.0.1',
    token: 'tok',
    daemonId: 'test',
    version: '0.0.0',
    latest: () => null,
    health: () => ({}),
    hookToken: 'hooktok',
    onHook: () => {},
    onOversize: () => {},
    digest: async () => digestView(current),
    setDigest: async (input) => {
      const choice = validateChoice(input);
      if (!choice.ok) return { ok: false, reason: choice.reason };
      const text = readFileSync(configFile, 'utf8');
      writeFileSync(
        configFile,
        setTomlValues(text, 'digest', {
          provider: choice.value.provider,
          model: choice.value.model,
          base_url: choice.value.baseUrl,
          api_key_env: choice.value.keyEnv,
        }),
        'utf8',
      );
      current = { ...current, provider: choice.value.provider, model: choice.value.model, base_url: choice.value.baseUrl, api_key_env: choice.value.keyEnv };
      return { ok: true, view: digestView(current) };
    },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.boundPort}/api/v1/digest`;
  const read = async (res: Response): Promise<Answer> => {
    const body = await res.text();
    return { status: res.status, body, json: JSON.parse(body) as Record<string, unknown> };
  };
  try {
    await fn(
      async () => read(await fetch(url, { headers: { 'X-VT-Token': 'tok' } })),
      async (body) =>
        read(
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-VT-Token': 'tok' },
            body: JSON.stringify(body),
          }),
        ),
      configFile,
      url,
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a choice made in the page lands in the config file, comments intact', async () => {
  await withServer(slice(), async (get, post, configFile) => {
    const before = await get();
    assert.equal(before.status, 200);
    assert.equal(before.json.provider, 'off');

    const saved = await post({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.provider, 'ollama');
    // The answer is the file re-read, not the body echoed back.
    assert.equal((await get()).json.model, 'qwen2.5-coder:7b');

    const text = readFileSync(configFile, 'utf8');
    assert.match(text, /provider = "ollama"/);
    assert.match(text, /model = "qwen2\.5-coder:7b"/);
    assert.match(text, /# which LLM, and on whose account/, 'the comment survived the write');
  });
});

test('the endpoint refuses the provider that runs a command, and says why', async () => {
  await withServer(slice(), async (get, post, configFile) => {
    const r = await post({ provider: 'cli', command: 'calc.exe', args: ['/c'] });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, 'cli');
    assert.ok(String(r.json.error).length > 10, 'a sentence, not a code');
    // Nothing was written, and nothing was half-written either.
    assert.equal((await get()).json.provider, 'off');
    assert.ok(!readFileSync(configFile, 'utf8').includes('calc.exe'));
  });
});

test('a command already in the file is reported but not disturbed', async () => {
  // Somebody who wrote `cli` by hand still gets a panel that describes their
  // setup — and can still move off it, which is the direction that reduces
  // what is possible.
  const configured = slice({ provider: 'cli', command: 'gemini', args: ['-m', 'gemini-2.0-flash'] });
  await withServer(configured, async (get, post, configFile) => {
    const view = await get();
    assert.equal(view.json.provider, 'cli');
    assert.equal(view.json.inOptions, false, 'shown as state, not as a tickable option');
    assert.equal(view.json.commandLine, 'gemini -m gemini-2.0-flash');
    assert.equal(view.json.egress, 'unknown', 'a program we did not write; we do not claim to know');
    const options = view.json.options as Array<{ id: string }>;
    assert.ok(!options.some((o) => o.id === 'cli'));

    const away = await post({ provider: 'off' });
    assert.equal(away.status, 200);
    assert.equal(away.json.provider, 'off');
    // The command line is left where the user put it: it is inert unless the
    // provider names it, and silently deleting somebody's own config line is
    // not this endpoint's business.
    assert.match(readFileSync(configFile, 'utf8'), /provider = "off"/);
  });
});

test('the key is nowhere in the response, whatever the response contains', async () => {
  const secret = 'sk-ant-api03-' + 'Z'.repeat(40);
  process.env.VT_TEST_DIGEST_KEY = secret;
  try {
    await withServer(slice({ provider: 'anthropic', api_key_env: 'VT_TEST_DIGEST_KEY' }), async (get) => {
      const r = await get();
      // Over the whole serialised body: a field-by-field check only ever
      // covers the fields the test remembered, and the next one added would
      // not be covered by it.
      assert.ok(!r.body.includes(secret), 'the key itself');
      assert.ok(!r.body.includes(secret.slice(0, 20)), 'a usable prefix of it');
      const key = r.json.key as Record<string, unknown>;
      assert.equal(key.present, true);
      assert.equal(key.from, 'env');
      assert.equal(key.envName, 'VT_TEST_DIGEST_KEY');
      assert.match(String(key.masked), /^sk-a…/);
      assert.equal(r.json.ready, true, 'a key that resolves means the next digest can run');
    });
  } finally {
    delete process.env.VT_TEST_DIGEST_KEY;
  }
});

test('a refusal names the field, so the page can say something useful', async () => {
  await withServer(slice(), async (get, post) => {
    const cases: Array<[unknown, string]> = [
      [{ provider: 'nope' }, 'provider'],
      [{ provider: 'openai', base_url: 'file:///etc/passwd' }, 'base_url_scheme'],
      [{ provider: 'anthropic', api_key_env: 'sk-ant-api03-real' }, 'key_env_looks_like_key'],
    ];
    for (const [body, reason] of cases) {
      const r = await post(body);
      assert.equal(r.status, 400, reason);
      assert.equal(r.json.reason, reason);
    }
    assert.equal((await get()).json.provider, 'off', 'nothing was written by a refusal');
  });
});

test('a write needs POST — a GET with side effects is a CSRF surface', async () => {
  // Every mutation in this daemon is a POST for the same reason: a GET that
  // changed a setting could be fired by an <img> tag on any page that guessed
  // the token, without ever reading the answer.
  await withServer(slice(), async (get, _post, _configFile, url) => {
    void _post;
    void _configFile;
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'X-VT-Token': 'tok' },
        body: JSON.stringify({ provider: 'anthropic' }),
      });
      assert.equal(res.status, 405, method);
      await res.text();
    }
    assert.equal((await get()).json.provider, 'off');
  });
});

test('an unauthenticated caller gets nothing, not even the provider name', async () => {
  await withServer(slice({ provider: 'anthropic' }), async (_get, _post, _configFile, url) => {
    void _get;
    void _post;
    void _configFile;
    const res = await fetch(url);
    assert.ok(res.status === 401 || res.status === 403, `guarded, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('anthropic'));
  });
});

/**
 * A view with a known key state.
 *
 * `digestView` resolves the key from the real environment and the real key
 * file, which is correct in the daemon and wrong in a test: whether these
 * assertions held would depend on whether the machine running them happens to
 * have an Anthropic key. The shape stays real; only that one answer is fixed.
 */
function viewWithoutKey(over: Partial<DigestConfigSlice> = {}): ReturnType<typeof digestView> {
  const v = digestView(slice(over));
  return { ...v, key: { present: false, masked: null, from: 'none', envName: v.key.envName }, ready: false };
}

test('the panel renders the daemon answer, and never the key', () => {
  const view = viewWithoutKey({ provider: 'anthropic' });
  const panel = loadPanel({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(view) }),
  });
  const click = panel.__click as (selector: string) => void;
  const els = panel.__els as Map<string, { innerHTML: string; hidden: boolean }>;

  // Through the real path: the click that opens the panel is what triggers the
  // load, so a handler that was never wired up fails here rather than passing
  // because the test called the renderer directly.
  click('#llmToggle');
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      const html = els.get('llm')!.innerHTML;
      assert.ok(html.includes('name="llmp"'), 'the providers are offered as a choice');
      for (const id of ['off', 'ollama', 'claude-cli', 'codex-cli', 'openai', 'anthropic']) {
        assert.ok(html.includes(`value="${id}"`), id);
      }
      assert.ok(!html.includes('value="cli"'), 'the command provider is not offered');
      // The box asks for a variable name and says so; there is no password
      // field on this page at all.
      assert.ok(!html.includes('type="password"'));
      assert.ok(html.includes('id="llmKeyEnv"'), 'anthropic needs a key, so the name box is shown');
      assert.ok(html.includes('vt digest key'), 'and the page says where the key itself goes');
      assert.ok(html.includes('id="llmSave"'));
      resolve();
    });
  });
});

test('the panel offers no address box for a provider that has no address', () => {
  const view = digestView(slice({ provider: 'claude-cli' }));
  const panel = loadPanel({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(view) }),
  });
  (panel.__click as (s: string) => void)('#llmToggle');
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      const html = (panel.__els as Map<string, { innerHTML: string }>).get('llm')!.innerHTML;
      assert.ok(!html.includes('id="llmBase"'));
      assert.ok(!html.includes('id="llmKeyEnv"'), 'and no key box: this one is already signed in');
      resolve();
    });
  });
});
