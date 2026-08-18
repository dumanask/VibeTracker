/**
 * The dashboard is a hand-written script inside an HTML file, which means no
 * compiler looks at it. A typo there ships a blank page to everyone, and the
 * daemon is perfectly healthy while it happens — the worst kind of failure
 * this product can have.
 *
 * So the page is loaded here the way a browser would: the script is executed
 * against a stub DOM, and then its own functions are called with fixture data.
 * That catches a syntax error, a reference to something that no longer exists,
 * and — the reason this exists at all — the summary logic silently disagreeing
 * with `summarizeAgents` in core, which is what the terminal renders from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { summarizeAgents, compactRank } from '@vibetracker/core';
import type { ProjectView, SessionView } from '@vibetracker/shared';

const PANEL = join(fileURLToPath(new URL('../public/', import.meta.url)), 'index.html');

/** Just enough DOM for the script to reach the end of its top-level code. */
function loadPanel(hash = ''): Record<string, unknown> {
  const html = readFileSync(PANEL, 'utf8');
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(m, 'panel has a script block');
  const src = m[1]!.replace('"__VT_I18N__"', '({})').replace('__VT_TOKEN__', 'test-token');

  const bodyAttrs: string[] = [];
  const listeners = new Map<string, (e: { data: string }) => void>();
  // One object per id, kept: the page writes its output into `innerHTML`, and
  // a fresh stub on every lookup throws that output away.
  const els = new Map<string, Record<string, unknown>>();
  const element = (id: string): Record<string, unknown> => {
    let e = els.get(id);
    if (!e) {
      e = {
        hidden: false,
        className: '',
        textContent: '',
        innerHTML: '',
        dataset: {},
        style: {},
        setAttribute() {},
        removeAttribute() {},
        closest: () => null,
      };
      els.set(id, e);
    }
    return e;
  };

  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => element(id),
      querySelectorAll: () => [],
      addEventListener() {},
      body: { setAttribute: (k: string) => void bodyAttrs.push(k), removeAttribute() {} },
      title: '',
    },
    location: { hash, pathname: '/', search: '', href: '' },
    // The page opens an SSE stream on load; a stub keeps the test offline —
    // and keeps the handlers, so a fixture can arrive the same way a real
    // report does rather than by reaching past the page into its variables.
    EventSource: class {
      addEventListener(name: string, fn: (e: { data: string }) => void): void {
        listeners.set(name, fn);
      }
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('offline')),
    console,
  };
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  runInContext(src, ctx, { filename: 'index.html' });
  sandbox.__bodyAttrs = bodyAttrs;
  sandbox.__els = els;
  sandbox.__push = (name: string, payload: unknown): void => {
    const fn = listeners.get(name);
    assert.ok(fn, `page never subscribed to "${name}"`);
    fn({ data: JSON.stringify(payload) });
  };
  return sandbox;
}

function session(over: Partial<SessionView>): SessionView {
  return {
    sessionId: 'aaaaaaaa-bbbb',
    pid: 1,
    state: 'BUSY',
    confidence: 0.9,
    evidence: [],
    openTools: [],
    ...over,
  } as SessionView;
}

function project(name: string, sessions: SessionView[]): ProjectView {
  const p: ProjectView = {
    projectId: `git:${name}`,
    identityKind: 'git_root',
    displayName: name,
    workspaces: [],
    sessions,
    flags: [],
    tracked: true,
    summary: { kind: 'none', waiting: 0, running: 0, live: 0, total: 0, urgency: 0 },
  };
  // Exactly what the engine does before the report leaves it.
  p.summary = summarizeAgents(p);
  return p;
}

test('the dashboard script parses and runs to completion', () => {
  const panel = loadPanel();
  assert.equal(typeof panel.summarize, 'function');
  assert.equal(typeof panel.renderList, 'function');
  assert.equal(typeof panel.renderDetail, 'function');
});

/**
 * The number on the sticky note and the number in the terminal have to be the
 * same number, and the way that is guaranteed is that the engine computes it
 * once. This checks the page reads that value rather than quietly recomputing
 * one of its own — the failure it is here to catch is a second implementation
 * appearing, not a wrong number today.
 */
test('the panel renders the summary the engine computed', () => {
  const panel = loadPanel();
  const summarize = panel.summarize as (p: ProjectView) => Record<string, unknown>;
  const rank = panel.rank as (p: ProjectView) => number;

  const cases: ProjectView[] = [
    project('waiting-permission', [
      session({ state: 'WAITING_PERMISSION', pid: 1, stateSince: 1000 }),
      session({ state: 'BUSY', pid: 2 }),
    ]),
    project('busy-only', [session({ state: 'BUSY', pid: 3 })]),
    project('all-dead', [
      session({ state: 'ORPHANED', pid: 4 }),
      session({ state: 'ENDED', pid: 5 }),
    ]),
    project('idle', [session({ state: 'STARTING', pid: 6 })]),
    project('empty', []),
  ];

  for (const p of cases) {
    const mine = summarize(p);
    const theirs = summarizeAgents(p);
    assert.equal(mine.kind, theirs.kind, `${p.displayName}: kind`);
    assert.equal(mine.waiting, theirs.waiting, `${p.displayName}: waiting`);
    assert.equal(mine.running, theirs.running, `${p.displayName}: running`);
    assert.equal(mine.live, theirs.live, `${p.displayName}: live`);
    assert.equal(mine.total, theirs.total, `${p.displayName}: total`);
    assert.equal(rank(p), compactRank(p), `${p.displayName}: rank`);
  }
});

test('waiting always outranks running, and running outranks idle', () => {
  const waiting = project('w', [session({ state: 'WAITING_PERMISSION' })]);
  const running = project('r', [session({ state: 'BUSY' })]);
  const idle = project('i', [session({ state: 'STARTING' })]);
  const dead = project('d', [session({ state: 'ORPHANED' })]);

  assert.ok(compactRank(waiting) > compactRank(running));
  assert.ok(compactRank(running) > compactRank(idle));
  assert.ok(compactRank(idle) > compactRank(dead));
});

/**
 * Mini mode is a view of this page, not a second page. If the markup it needs
 * disappears, the pinned window silently degrades to something unreadable at
 * 360 pixels wide, and nothing else would notice.
 */
test('the markup mini mode depends on is present', () => {
  const html = readFileSync(PANEL, 'utf8');
  for (const needle of ['id="minibar"', 'id="miniCount"', 'data-mini', 'id="listView"', 'id="detailView"']) {
    assert.ok(html.includes(needle), `panel is missing ${needle}`);
  }
});

/**
 * The pinned window is the same page with `#mini` in the URL. If that switch
 * stops flipping, `vt mini` opens a full dashboard in a 360-pixel window and
 * nothing anywhere reports a problem.
 */
test('the mini switch is thrown by the url hash, and only by it', () => {
  // Asserted through the effect rather than the variable: `const MINI` is a
  // lexical binding and never appears on the context object, and testing the
  // attribute is what the CSS actually keys off anyway.
  const mini = loadPanel('#mini');
  assert.deepEqual(mini.__bodyAttrs, ['data-mini']);

  const normal = loadPanel('');
  assert.deepEqual(normal.__bodyAttrs, []);
});

/**
 * The grid has to have a column for every cell the row emits.
 *
 * This is not a style preference. CSS grid does not complain about a
 * seven-cell row in a four-column template — it wraps the overflow onto an
 * implicit second line, so the percentage appeared underneath the project
 * name and the note looked like it had a layout bug rather than a template
 * that had fallen a column behind the markup. Nothing else notices, which is
 * why it survived to a screenshot.
 */
test('every cell in a project row has a column to sit in', () => {
  const html = readFileSync(PANEL, 'utf8');

  const row = /return `<button class="prow[\s\S]*?<\/button>`;/.exec(html);
  assert.ok(row, 'project row template not found');

  // Direct children of the row, one per line of the template. `why` opts out
  // of the grid with its own `grid-column`, so it never needs a track.
  const cells = row[0]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => (l.startsWith('<span') || l.startsWith('${')) && l !== '${why}');

  const full = /\n  \.prow \{[^}]*?grid-template-columns:([^;]+);/s.exec(html);
  const mini = /data-mini\] \.prow \{[^}]*?grid-template-columns:([^;]+);/s.exec(html);
  assert.ok(full && mini, 'both row templates must declare their columns');

  const tracks = (m: RegExpExecArray): number => m[1]!.trim().split(/\s+/).length;
  assert.equal(tracks(full), cells.length, `tam satır: ${full[1]!.trim()}`);

  // Mini drops cells rather than shrinking them: at that width the progress
  // bar and the activity trace are the two things worth losing. A
  // `display:none` grid item claims no track, so mini's template is shorter
  // by exactly the number of cells it hides — counted here rather than
  // written down, so hiding one more does not silently go out of step.
  const hidden = [...html.matchAll(/body\[data-mini\][^{]*\.prow[^{]*\{[^}]*display:none/g)]
    .flatMap((m) => [...m[0].matchAll(/\.prow \.(\w+)/g)].map((x) => x[1]!))
    .filter((c) => c !== 'why');
  assert.ok(hidden.length > 0, 'mini hides nothing: the two templates cannot both be right');
  assert.equal(
    tracks(mini),
    cells.length - new Set(hidden).size,
    `mini satır: ${mini[1]!.trim()} · gizlenen: ${[...new Set(hidden)].join(', ')}`,
  );
});

/**
 * Waiting and running are simultaneous facts, and the row has to show both.
 *
 * The old row named whichever state was dominant and printed `live/total`
 * beside it, so a project with three sessions waiting on the user and one
 * still working announced "3 bekliyor  5/5" and left the reader to work out
 * where the other two had gone.
 */
test('a project doing both shows both counts', () => {
  const panel = loadPanel();
  const els = panel.__els as Map<string, { innerHTML: string }>;

  const push = panel.__push as (name: string, payload: unknown) => void;
  push('overview', {
    generatedAt: Date.now(),
    platform: 'win32',
    probeKind: 'windows-cim',
    probePrecision: 'exact',
    claudeDir: 'C:/x/.claude',
    capabilities: {},
    degraded: [],
    warnings: [],
    counts: {
      untracked: 0, needsYou: 2, live: 3, dead: 0, reused: 0,
      projects: 1, registryEntries: 3, ideWindows: 0,
    },
    projects: [
      project('mixed', [
        session({ state: 'WAITING_PERMISSION', pid: 1, stateSince: 1000 }),
        session({ state: 'WAITING_INPUT', pid: 2, stateSince: 2000 }),
        session({ state: 'BUSY', pid: 3 }),
      ]),
    ],
  });

  const html = els.get('projects')!.innerHTML;
  assert.match(html, /2 bekliyor/);
  assert.match(html, /1 çalışıyor/);
  // And the pair that used to mislead is gone for good.
  assert.ok(!/>3\/3</.test(html), 'the live/total pair is back');
});

/**
 * Which agent produced a row has to be visible, and only when it is not the
 * default one.
 *
 * The failure this catches is subtle and would be invisible on the reference
 * machine most of the time: a project routinely has both Claude Code and Codex
 * in it, and two rows that look identical while meaning different things is
 * exactly the ambiguity the badge exists to remove. The negative half matters
 * as much — badging every session would turn a signal into a column of the same
 * word.
 */
test('a session from another agent is badged, and Claude Code is not', () => {
  const panel = loadPanel();
  // Session rows live in the project card, which the detail view renders.
  const projectCard = panel.projectCard as (p: ProjectView) => string;

  const html = projectCard(
    project('mixed-agents', [
      session({ state: 'BUSY', pid: 1, agentKind: 'claude-code' }),
      session({ state: 'BUSY', pid: 0, agentKind: 'codex' }),
      session({ state: 'BUSY', pid: 0, agentKind: 'opencode' }),
      // Reports written before agents existed carry no `agentKind` at all, and
      // every one of those sessions was Claude Code's.
      session({ state: 'BUSY', pid: 2 }),
    ]),
  );

  const badges = [...html.matchAll(/class="agent"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(badges.sort(), ['codex', 'opencode']);
});
