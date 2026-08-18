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
