import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessDrift,
  deadPaths,
  dialectFor,
  knownEntryTypes,
  satisfies,
  DIALECT_DRIFT_MIN_LINES,
} from '../src/dialect.ts';

/**
 * Dialects describe files we do not own, so these tests are mostly about what
 * happens when the format moves: the parser must degrade, report, and keep
 * working — never throw, and never quietly show less.
 */

test('version ranges match the two forms the dialect files use', () => {
  assert.ok(satisfies('2.1.206', '>=2.0.0 <3.0.0'));
  assert.ok(!satisfies('3.0.0', '>=2.0.0 <3.0.0'));
  assert.ok(!satisfies('1.9.9', '>=2.0.0 <3.0.0'));
  assert.ok(satisfies('2.1.206', '*'));
  // An unreadable or absent version is not a reason to refuse to parse.
  assert.ok(satisfies(undefined, '>=2.0.0 <3.0.0'));
  assert.ok(satisfies('not-a-version', '>=2.0.0 <3.0.0'));
});

test('a version past every declared range still gets a parser', () => {
  // Refusing here would break the tool on exactly the day the agent updates,
  // which is the worst possible timing. The drift warning covers the risk.
  const d = dialectFor('claude-code', '99.0.0');
  assert.ok(knownEntryTypes(d).has('assistant'));
});

test('an unknown agent falls back rather than returning nothing', () => {
  const d = dialectFor('some-future-agent');
  assert.ok(knownEntryTypes(d).size > 0);
});

test('the shipped dialect covers the entry types the tail reader depends on', () => {
  const d = dialectFor('claude-code', '2.1.206');
  const types = knownEntryTypes(d);
  for (const required of ['user', 'assistant', 'ai-title', 'last-prompt']) {
    assert.ok(types.has(required), `${required} eksik`);
  }
  assert.equal(d.entryTypes['user'], 'message');
  assert.equal(d.entryTypes['ai-title'], 'meta.title');
  assert.equal(d.entryTypes['queue-operation'], 'ignore');
});

test('dead sources are named so nothing reads them by accident', () => {
  // `history.jsonl` and `stats-cache.json` stopped being written weeks before
  // this was measured. Reading them would show a stale week as current.
  const dead = deadPaths(dialectFor('claude-code'));
  assert.ok(dead.includes('history.jsonl'));
  assert.ok(dead.includes('stats-cache.json'));
});

test('drift is a rate, not a single surprise', () => {
  // One unrecognised type in a long file is normal; agents add entry types.
  assert.equal(assessDrift(10_000, ['new-thing'], 3).drifted, false);
  // A tenth of every line means this build no longer reads the format.
  assert.equal(assessDrift(1000, ['a', 'b'], 100).drifted, true);
});

test('drift stays silent on a sample too small to mean anything', () => {
  const tiny = assessDrift(DIALECT_DRIFT_MIN_LINES - 1, ['x'], 50);
  assert.equal(tiny.drifted, false);
  assert.ok(tiny.ratio > 0.05, 'oran yüksek ama örneklem küçük');
});

test('the shipped dialect file is well-formed data', () => {
  const file = join(import.meta.dirname, '..', 'dialects', 'claude-code.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(raw.agent, 'claude-code');
  assert.equal(typeof raw.appliesTo, 'string');
  assert.equal(typeof raw.dialectVersion, 'number');
  // Every entry type must map to a role the reader knows how to act on.
  const roles = new Set(['message', 'meta.title', 'meta.lastPrompt', 'ignore']);
  for (const [k, v] of Object.entries(raw.entryTypes as Record<string, string>)) {
    assert.ok(roles.has(v), `${k} → ${v} bilinmeyen rol`);
  }
});
