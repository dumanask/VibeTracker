import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigText } from '@vibetracker/core';
import { configTemplate } from '../src/config-file.ts';

const CHOICES = {
  lang: 'tr',
  port: 47823,
  bind: '127.0.0.1',
  hooksMode: 'http',
  digestProvider: 'off',
  agents: ['claude-code'],
} as const;

test('the starter config parses cleanly through our own parser', () => {
  // A template that its own parser rejects would break `vt init` for every
  // first-time user, and the failure would look like a corrupt install.
  const { config, issues, fromFile } = loadConfigText(configTemplate({ ...CHOICES }));
  assert.equal(fromFile, true);
  assert.deepEqual(issues, [], `beklenmedik uyarı: ${JSON.stringify(issues)}`);
  assert.equal(config.server.port, 47823);
  assert.equal(config.server.lang, 'tr');
  assert.equal(config.hooks.mode, 'http');
  assert.equal(config.digest.provider, 'off');
  assert.equal(config.privacy.redact, true);
});

test('the template reflects the choices made during init', () => {
  const text = configTemplate({
    ...CHOICES,
    lang: 'en',
    port: 51000,
    bind: '0.0.0.0',
    hooksMode: 'off',
    digestProvider: 'ollama',
    agents: ['claude-code', 'codex'],
  });
  const { config, issues } = loadConfigText(text);
  assert.equal(config.server.lang, 'en');
  assert.equal(config.server.port, 51000);
  assert.equal(config.hooks.mode, 'off');
  assert.equal(config.digest.provider, 'ollama');
  assert.deepEqual(config.agents.enabled, ['claude-code', 'codex']);
  // The only issue should be the one we want a wide bind to always produce.
  assert.deepEqual(
    issues.map((i) => i.key),
    ['server.bind'],
  );
});

test('the template keeps its comments', () => {
  const text = configTemplate({ ...CHOICES });
  assert.ok(text.includes('# VibeTracker yapılandırması'));
  // The privacy section's strictness is the one rule a user must know before
  // editing, so it is documented in the file itself rather than only here.
  assert.match(text, /\[privacy\][\s\S]*bilinmeyen bir anahtar hata sayılır/);
});

test('a cli provider survives the round trip, arguments and all', () => {
  // The answer to "what LLM, though" for somebody who has neither an API key
  // nor a Claude subscription: a command they already have. Which means the
  // template has to write a string array, and TOML has to read it back — the
  // one place in this file where a wrong quote turns into a config that parses
  // but runs the wrong program.
  const text = configTemplate({
    ...CHOICES,
    digestProvider: 'cli',
    digestCommand: 'gemini',
    digestArgs: ['-m', '{model}', '--in', '{prompt_file}'],
  });
  const { config, issues } = loadConfigText(text);
  assert.deepEqual(issues, [], `beklenmedik uyarı: ${JSON.stringify(issues)}`);
  assert.equal(config.digest.provider, 'cli');
  assert.equal(config.digest.command, 'gemini');
  assert.deepEqual(config.digest.args, ['-m', '{model}', '--in', '{prompt_file}']);

  // And the file says what the placeholders are, because the person editing it
  // is not going to have this source open.
  assert.ok(text.includes('{prompt_file}'));
  assert.ok(text.includes('codex-cli'));
});
