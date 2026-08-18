import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDetailed, redactSnippet, entropy } from '../src/redact.ts';

/**
 * The fixtures below are synthetic but shaped like the real thing. Never put a
 * real credential in a test file — the repository is the one place a secret is
 * guaranteed to outlive the mistake.
 */

const CASES: Array<[string, string, string]> = [
  ['anthropic', 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5), 'anthropic_key'],
  ['openai', 'sk-proj-' + 'Zx9YwVu8TsRq7PoN'.repeat(3), 'openai_key'],
  ['github pat', 'ghp_' + 'aB3dE6gH9jK2mN5p'.repeat(2), 'github_token'],
  ['slack', 'xoxb-' + '1234567890-' + 'ABCDEFGHIJKLMNOP', 'slack_token'],
  ['google', 'AIza' + 'B'.repeat(35), 'google_key'],
  ['aws', 'AKIAIOSFODNN7EXAMPLE', 'aws_key'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'jwt'],
  ['postgres', 'postgres://user:hunter2@db.internal:5432/prod', 'connection_string'],
  ['bearer', 'Bearer aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0z', 'bearer'],
];

for (const [name, secret, detector] of CASES) {
  test(`${name} is removed and labelled`, () => {
    const { text, hits } = redactDetailed(`önce ${secret} sonra`);
    assert.ok(!text.includes(secret), `sızdı: ${text}`);
    assert.ok(hits.includes(detector), `beklenen dedektör ${detector}, gelen ${hits.join(',')}`);
    assert.ok(text.startsWith('önce ') && text.endsWith(' sonra'), 'çevresi korunmalı');
  });
}

test('a private key block is removed whole, not line by line', () => {
  const block =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nabc\n-----END RSA PRIVATE KEY-----';
  const out = redact(`config:\n${block}\ndone`);
  assert.ok(!out.includes('MIIEow'), out);
  assert.ok(out.includes('«redacted:private_key»'));
  assert.ok(out.endsWith('done'));
});

test('env values go, their names stay, and the rule errs toward removing', () => {
  const out = redact('DATABASE_PASSWORD=sup3rs3cr3tvalue\nPATH=/usr/bin\nOK=short');
  assert.ok(out.includes('DATABASE_PASSWORD=«redacted:env_value»'));
  assert.ok(!out.includes('sup3rs3cr3t'));

  // PATH is redacted too, and that is the intended trade rather than a miss:
  // deciding which SCREAMING_CASE names are safe means maintaining a list of
  // everything in the world, and the one time it is wrong it leaks. The name
  // survives, which is all the context an evidence line needs.
  assert.ok(out.includes('PATH=«redacted:env_value»'));

  // Values too short to be a credential are left alone, so `MODE=dev` stays
  // readable.
  assert.ok(out.includes('OK=short'));
});

test('identifiers we produce ourselves are not mangled', () => {
  // Redacting these would make every evidence line unreadable.
  const sha = 'c02462b9c30c8d9f1a2b3c4d5e6f708192a3b4c5';
  const uuid = '9fcaebfa-acb0-43f2-961d-7593dc0453ac';
  const out = redact(`commit ${sha} session ${uuid}`);
  assert.ok(out.includes(sha), 'git sha redakte edilmemeli');
  assert.ok(out.includes(uuid), 'uuid redakte edilmemeli');
});

test('ordinary prose and paths pass through untouched', () => {
  const text =
    'Bash aracı 8dk 12sn açık kaldı — c:/dev/VibeTracker/packages/engine/src/tail.ts okunuyordu';
  assert.equal(redact(text), text);
});

test('high entropy is caught even without a known prefix', () => {
  const { text, hits } = redactDetailed('X-Internal-Token: 7Qk9Zx2Lm4Pv8Rt6Wy1Bd3Nf5Hj0Cg7As');
  assert.ok(hits.includes('high_entropy'));
  assert.ok(text.includes('«redacted:secret»'));
});

test('entropy separates prose from randomness', () => {
  assert.ok(entropy('aaaaaaaaaaaaaaaa') < 1);
  assert.ok(entropy('the quick brown fox jumps') < 4.5);
  assert.ok(entropy('7Qk9Zx2Lm4Pv8Rt6Wy1Bd3Nf5Hj0Cg') > 4.0);
});

test('snippets are redacted before they are shortened', () => {
  const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(6);
  const out = redactSnippet(`hata: ${key} reddedildi`, 60);
  assert.ok(!out.includes('sk-ant-api03'));
  assert.ok(out.length <= 60);
});
