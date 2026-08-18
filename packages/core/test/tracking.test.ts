/**
 * Choosing which projects to follow is a small feature with one sharp edge:
 * the first `rm` while following everything has to mean "keep the rest", not
 * "select nothing". Getting that backwards empties the board on the user's
 * first use of the feature, which reads as the tool breaking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTracked,
  isTracked,
  matchProject,
  removeTracked,
  trackAll,
  type TrackableProject,
} from '../src/tracking.ts';
import { defaultConfig, validateConfig } from '../src/config.ts';
import { parseToml } from '../src/toml.ts';

const PROJECTS: TrackableProject[] = [
  { projectId: 'git:aaa', displayName: 'VRTwin' },
  { projectId: 'git:bbb', displayName: 'AgentWorld' },
  { projectId: 'git:ccc', displayName: 'Masaüstü' },
  { projectId: 'pkg:ddd', displayName: 'VibeTracker' },
];

test('following everything is the default', () => {
  const c = defaultConfig();
  assert.equal(c.tracking.mode, 'all');
  assert.ok(isTracked(c.tracking, 'git:anything'));
});

test('removing the first project keeps the others rather than emptying the board', () => {
  const change = removeTracked(trackAll(), ['git:aaa'], PROJECTS);
  assert.equal(change.next.mode, 'selected');
  assert.deepEqual(change.next.selected, ['git:bbb', 'git:ccc', 'pkg:ddd']);
  assert.ok(change.switchedToSelected, 'the caller must be able to say this happened');
  assert.ok(!isTracked(change.next, 'git:aaa'));
  assert.ok(isTracked(change.next, 'git:bbb'));
});

test('adding from "everything" narrows to exactly what was named', () => {
  const change = addTracked(trackAll(), ['git:aaa']);
  assert.deepEqual(change.next.selected, ['git:aaa']);
  assert.ok(change.switchedToSelected);
  assert.ok(!isTracked(change.next, 'git:bbb'));
});

test('adding again is idempotent and says nothing changed', () => {
  const first = addTracked(trackAll(), ['git:aaa']);
  const second = addTracked(first.next, ['git:aaa']);
  assert.deepEqual(second.next.selected, ['git:aaa']);
  assert.equal(second.added.length, 0);
  assert.ok(!second.switchedToSelected);
});

test('a name is matched through the locale-safe fold, not raw lowercase', () => {
  // The Turkish dotted/dotless I is exactly where `toLowerCase()` fails.
  const m = matchProject('masaustu', PROJECTS);
  assert.equal(m.kind, 'one');
  assert.equal(m.kind === 'one' && m.project.projectId, 'git:ccc');
});

test('an id matches exactly', () => {
  const m = matchProject('pkg:ddd', PROJECTS);
  assert.equal(m.kind === 'one' && m.project.displayName, 'VibeTracker');
});

test('an ambiguous name is reported, never resolved by picking the first', () => {
  const twins: TrackableProject[] = [
    { projectId: 'git:1', displayName: 'AITool' },
    { projectId: 'path:2', displayName: 'AITool' },
  ];
  const m = matchProject('AITool', twins);
  assert.equal(m.kind, 'many');
  assert.equal(m.kind === 'many' && m.candidates.length, 2);
});

test('a prefix resolves only while it stays unique', () => {
  assert.equal(matchProject('VR', PROJECTS).kind, 'one');
  assert.equal(matchProject('zzz', PROJECTS).kind, 'none');
  const ambiguous: TrackableProject[] = [
    { projectId: 'git:1', displayName: 'Vibe' },
    { projectId: 'git:2', displayName: 'VibeTracker' },
  ];
  assert.equal(matchProject('Vib', ambiguous).kind, 'many');
});

/**
 * A selection that selects nothing would render an empty board with no
 * explanation. Falling back to everything, loudly, is the recoverable reading.
 */
test('an empty selection falls back to everything with a warning', () => {
  const raw = parseToml('[tracking]\nmode = "selected"\nselected = []\n');
  const { config, issues } = validateConfig(raw as never);
  assert.equal(config.tracking.mode, 'all');
  assert.ok(issues.some((i) => i.key === 'tracking.selected' && i.severity === 'warn'));
});

test('an unknown key under [tracking] is a warning, not a fatal error', () => {
  const raw = parseToml('[tracking]\nmode = "all"\nmodee = "all"\n');
  const { config, issues } = validateConfig(raw as never);
  assert.equal(config.tracking.mode, 'all');
  assert.ok(issues.some((i) => i.severity === 'warn'));
  assert.ok(!issues.some((i) => i.severity === 'error'));
});
