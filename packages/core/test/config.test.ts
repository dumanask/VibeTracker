import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, tomlValue, TomlError } from '../src/toml.ts';
import { loadConfigText, validateConfig, defaultConfig } from '../src/config.ts';

// ── parser ──────────────────────────────────────────────────────────────

test('parses the shapes the real config file uses', () => {
  const t = parseToml(`
config_version = 1
# a comment

[server]
port = 47823
bind = '127.0.0.1'
lang = "tr"

[agents]
enabled = [
  'claude-code',   # trailing comment inside an array
  'codex',
]

[digest]
daily_usd_cap = 1.50
hex = 0xff

[projects."git:c02462b9"]
display_name = 'AITool'
archived = false
nested = { a = 1, b = [true, false] }
`);
  assert.equal(t.config_version, 1);
  assert.deepEqual(t.server, { port: 47823, bind: '127.0.0.1', lang: 'tr' });
  assert.deepEqual(t.agents, { enabled: ['claude-code', 'codex'] });
  assert.equal((t.digest as Record<string, unknown>).daily_usd_cap, 1.5);
  assert.equal((t.digest as Record<string, unknown>).hex, 255);
  const proj = (t.projects as Record<string, Record<string, unknown>>)['git:c02462b9'];
  assert.equal(proj.display_name, 'AITool');
  assert.deepEqual(proj.nested, { a: 1, b: [true, false] });
});

test('a repeated section is an error, not a silent merge', () => {
  // This is the whole reason the parser tracks table identity: `[server]`
  // twice would otherwise merge and the second block would appear to win,
  // leaving the first block's settings looking like they did nothing.
  assert.throws(() => parseToml('[server]\nport = 1\n[server]\nbind = "x"\n'), TomlError);
});

test('a repeated key is an error', () => {
  assert.throws(() => parseToml('x = 1\nx = 2\n'), TomlError);
});

test('syntax errors carry a line number', () => {
  try {
    parseToml('[server]\nport = 1\nbind =\n');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof TomlError);
    assert.equal(e.line, 3);
    assert.match(e.message, /satır 3/);
  }
});

test('dotted keys, escapes and multi-line strings', () => {
  const t = parseToml(`
a.b.c = 1
s = "tab\\there\\u0041"
m = """
line1
line2"""
lit = 'C:\\dev\\x'
`);
  assert.deepEqual(t.a, { b: { c: 1 } });
  assert.equal(t.s, 'tab\there' + 'A');
  assert.equal(t.m, 'line1\nline2');
  assert.equal(t.lit, 'C:\\dev\\x');
});

test('windows paths round-trip through the writer as literal strings', () => {
  const p = 'C:\\dev\\VibeTracker';
  assert.equal(tomlValue(p), "'C:\\dev\\VibeTracker'");
  assert.equal(parseToml(`p = ${tomlValue(p)}`).p, p);
});

// ── validation ──────────────────────────────────────────────────────────

test('an empty config is the default config with no complaints', () => {
  const { config, issues } = loadConfigText('');
  assert.deepEqual(config, defaultConfig());
  assert.deepEqual(issues, []);
});

test('a syntax error degrades to defaults instead of locking the user out', () => {
  const { config, issues, fromFile } = loadConfigText('[server]\nport = = 1\n');
  // The daemon must still start. A config nobody can load is a config nobody
  // can fix without reading source code.
  assert.equal(config.server.port, 47823);
  assert.equal(fromFile, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.match(issues[0].message, /satır 2/);
});

test('a bad value is reported and the default is kept', () => {
  const { config, issues } = loadConfigText('[server]\nport = 99999\nlang = "de"\n');
  assert.equal(config.server.port, 47823);
  assert.equal(config.server.lang, 'tr');
  const keys = issues.map((i) => i.key);
  assert.deepEqual(keys.sort(), ['server.lang', 'server.port']);
  assert.ok(issues.every((i) => i.severity === 'error'));
  assert.match(issues.find((i) => i.key === 'server.lang')!.fix!, /tr \| en/);
});

test('an unknown key is a warning — except under [privacy], where it is fatal', () => {
  // Forward compatibility versus the typo that silently disarms a guard.
  const loose = loadConfigText('[server]\nfuture_setting = 1\n');
  assert.equal(loose.issues[0].severity, 'warn');

  const strict = loadConfigText('[privacy]\nredcation = "strict"\n');
  assert.equal(strict.issues[0].severity, 'error');
  assert.equal(strict.issues[0].key, 'privacy.redcation');
});

test('binding beyond loopback warns even though it is allowed', () => {
  const { config, issues } = loadConfigText('[server]\nbind = "0.0.0.0"\n');
  assert.equal(config.server.bind, '0.0.0.0');
  const w = issues.find((i) => i.key === 'server.bind');
  assert.equal(w?.severity, 'warn');
  assert.match(w!.message, /ağdaki herkes/);
});

test('turning redaction off is allowed and announced', () => {
  const { config, issues } = loadConfigText('[privacy]\nredact = false\n');
  assert.equal(config.privacy.redact, false);
  assert.ok(issues.some((i) => i.key === 'privacy.redact' && i.severity === 'warn'));
});

test('a broken custom redaction pattern is dropped, not silently kept', () => {
  const { config, issues } = loadConfigText(
    '[privacy]\ncustom_patterns = ["ACME_[0-9]{8}", "unclosed(["]\n',
  );
  assert.deepEqual(config.privacy.custom_patterns, ['ACME_[0-9]{8}']);
  assert.equal(issues[0].key, 'privacy.custom_patterns[1]');
  assert.equal(issues[0].severity, 'error');
});

test('a newer config_version warns but still loads what it understands', () => {
  const { config, issues } = loadConfigText('config_version = 9\n[server]\nport = 5000\n');
  assert.equal(config.server.port, 5000);
  assert.ok(issues.some((i) => i.key === 'config_version' && i.severity === 'warn'));
});

test('per-project sections survive validation', () => {
  const { config, issues } = validateConfig(
    parseToml(`
[projects."git:abc123"]
display_name = 'AITool'
providers = ['plans-md', 'todowrite']
archived = true
`),
  );
  assert.deepEqual(issues, []);
  assert.deepEqual(config.projects['git:abc123'], {
    display_name: 'AITool',
    providers: ['plans-md', 'todowrite'],
    archived: true,
  });
});

test('a section written as a scalar is reported without crashing', () => {
  const { config, issues } = loadConfigText('server = 5\n');
  assert.equal(config.server.port, 47823);
  assert.equal(issues[0].key, 'server');
  assert.equal(issues[0].severity, 'error');
});
