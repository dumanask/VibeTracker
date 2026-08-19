/**
 * The dashboard is a hand-written script inside an HTML file, which means no
 * compiler looks at it. A typo there ships a blank page to everyone, and the
 * daemon is perfectly healthy while it happens — the worst kind of failure
 * this product can have.
 *
 * So the page is loaded the way a browser would — see `panel-harness.ts` —
 * and its own functions are called with fixture data. That catches a syntax
 * error, a reference to something that no longer exists, and — the reason this
 * exists at all — the summary logic silently disagreeing with
 * `summarizeAgents` in core, which is what the terminal renders from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAgents, compactRank } from '@vibetracker/core';
import { readFileSync } from 'node:fs';
import { loadPanel, PANEL } from './panel-harness.ts';
import type { ProjectView, SessionView } from '@vibetracker/shared';

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

  // Every declaration, not the two that happened to sit at the top level.
  //
  // These were two hand-written regexes, and a third `.prow` template later
  // appeared inside a `@media` block for narrow windows — where the test could
  // not see it, which is precisely where a wrong column count is least likely
  // to be caught by eye. Collected by scanning now, so the next breakpoint is
  // covered the moment it is written.
  const NARROW = html.search(/@media \(max-width/);
  const scopeAt = (selector: string, at: number): 'base' | 'mini' | 'narrow' =>
    /data-mini/.test(selector) ? 'mini' : NARROW >= 0 && at > NARROW ? 'narrow' : 'base';

  const templates = [...html.matchAll(/([^{}]*\.prow\b[^{}]*)\{([^}]*)\}/g)]
    .filter((m) => /grid-template-columns:/.test(m[2]!))
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]!, at: m.index! }));
  assert.ok(templates.length >= 3, `row templates found: ${templates.length}`);

  const tracksOf = (body: string): number =>
    /grid-template-columns:([^;]+);/.exec(body)![1]!.trim().split(/\s+/).length;

  /**
   * Cells hidden in a given context. A `display:none` grid item claims no
   * track, so a template is shorter by exactly the number of cells its own
   * context hides — counted rather than written down, so hiding one more does
   * not silently put the two out of step.
   */
  const hiddenIn = (scope: 'base' | 'mini' | 'narrow'): Set<string> => {
    const out = new Set<string>();
    for (const m of html.matchAll(/([^{}]*\.prow \.\w+[^{}]*)\{([^}]*display:none[^}]*)\}/g)) {
      if (scopeAt(m[1]!, m.index!) !== scope) continue;
      for (const c of m[1]!.matchAll(/\.prow \.(\w+)/g)) {
        if (c[1] !== 'why') out.add(c[1]!);
      }
    }
    return out;
  };

  for (const tpl of templates) {
    const scope = scopeAt(tpl.selector, tpl.at);
    const hidden = hiddenIn(scope);
    const declared = /grid-template-columns:([^;]+);/.exec(tpl.body)![1]!.trim();
    assert.equal(
      tracksOf(tpl.body),
      cells.length - hidden.size,
      `${scope} row: ${declared} · hidden: ${[...hidden].join(', ') || '(none)'}`,
    );
  }
});

/**
 * Waiting and running are simultaneous facts, and the row has to show both.
 *
 * The old row named whichever state was dominant and printed `live/total`
 * beside it, so a project with three sessions waiting on the user and one
 * still working announced "3 waiting  5/5" and left the reader to work out
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
  assert.match(html, /2 waiting/);
  assert.match(html, /1 running/);
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

/**
 * The one-second tick must not rebuild the page.
 *
 * It used to call the whole of `render()`, which reassigns `innerHTML` for the
 * counters, the waiting strip and the project list — so keyboard focus was
 * dropped, any text selection cleared and anything open closed, once a second,
 * for as long as the page was up. The only thing that actually changes between
 * server pushes is an elapsed time, so every node showing one carries the
 * timestamp it is measured from and the tick writes text into those and
 * nothing else.
 */
test('the timer advances clocks instead of rebuilding the list', () => {
  const html = readFileSync(PANEL, 'utf8');

  assert.match(html, /setInterval\(tickClocks, 1000\)/, 'the one-second tick still calls render');
  assert.doesNotMatch(
    html,
    /setInterval\(\(\) => \{ if \(report\) render\(\); \}/,
    'a full redraw is still on the timer',
  );

  // Every elapsed-time cell has to carry its own reference point, or the tick
  // has nothing to recompute from and the clocks quietly stop.
  const dwellCells = [...html.matchAll(/<span class="(dwell|xy)"([^>]*)>/g)];
  assert.ok(dwellCells.length >= 3, `no dwell cell found: ${dwellCells.length}`);
  for (const [, cls, attrs] of dwellCells) {
    assert.match(attrs!, /data-since=/, `the ${cls} cell carries no reference time`);
  }

  // And the tick reads exactly that attribute.
  assert.match(html, /querySelectorAll\('\[data-since\]'\)/);
});

/**
 * The chooser must never be able to unfollow something it did not show.
 *
 * `/api/v1/candidates` is capped, and when it fails the page falls back to the
 * board — which holds only projects with something running, so it is smaller
 * again. Both lists are partial, and the page used to save its ticked boxes as
 * the complete selection, which turned "I unticked one project" into "forget
 * every project not currently on my screen". Nothing said it had happened; the
 * projects were simply gone from the board the next time the user looked.
 */
test('saving the chooser sends a change, not a whole selection', async () => {
  const panel = loadPanel();
  const doc = panel.document as Record<string, unknown>;

  // Three known projects, two of them followed — delivered the way the real
  // ones are, because the list the delta compares against is the one the page
  // fetched and not one a test reached in and planted.
  panel.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [
            { projectId: 'git:a', displayName: 'a', tracked: true },
            { projectId: 'git:b', displayName: 'b', tracked: true },
            { projectId: 'git:c', displayName: 'c', tracked: false },
          ],
          truncated: false,
        }),
    });
  await (panel.loadCandidates as () => Promise<void>)();

  // The user unticks `b` and ticks `c`. `a` is left alone.
  const box = (id: string, checked: boolean): Record<string, unknown> => ({
    checked,
    dataset: { track: id },
  });
  doc.querySelectorAll = (sel: string): unknown[] =>
    sel.includes('data-track')
      ? [box('git:a', true), box('git:b', false), box('git:c', true)]
      : [];

  // Copied out of the sandbox's realm: its arrays have a different `Array`,
  // and a strict deep-equal compares prototypes before contents.
  const raw = (panel.pickDelta as () => { add: string[]; remove: string[] })();
  const delta = { add: [...raw.add], remove: [...raw.remove] };
  assert.deepEqual(delta.add, ['git:c']);
  assert.deepEqual(delta.remove, ['git:b']);
  // `a` was ticked before and is ticked now: an untouched box says nothing.
  assert.ok(!delta.add.includes('git:a') && !delta.remove.includes('git:a'));

  // And the wire form itself: the save path must not carry the other shape,
  // which is the one that states a complete selection.
  const html = readFileSync(PANEL, 'utf8');
  assert.doesNotMatch(
    html,
    /saveTracking\(\{\s*mode:\s*'selected'/,
    'seçim hâlâ bütün olarak gönderiliyor',
  );
  // "hepsi" is the one button that legitimately states a whole mode.
  assert.match(html, /saveTracking\(\{ mode: 'all', selected: \[\] \}\)/);
});

/**
 * A list that could not be fetched is not an empty list.
 *
 * The note window said "proje bulunamadı" — an assertion about the user's
 * disk — whenever its own request failed, which after any daemon restart was
 * every request it made. The page has the same two states and has to keep them
 * apart too: it falls back to the board, and it has to say that what it is
 * showing is not everything.
 */
test('a partial chooser says so', () => {
  const html = readFileSync(PANEL, 'utf8');
  assert.match(html, /candidatesPartial = !!body\.truncated/);
  assert.match(html, /candidatesPartial = true/, 'the fallback list is not marked partial');
  assert.match(html, /candidatesPartial \?/, 'the screen does not say the list is partial');
});

/**
 * The LLM summary has to be legible as a *claim*, not as a measurement.
 *
 * Everything else on the page is counted or read off the disk. This one thing
 * was produced by a system that can be confidently wrong, and it is the only
 * thing there that cost the user money or quota — so it says which model, when,
 * and it never borrows the progress bar that counted numbers use.
 */
test('the digest is drawn as a claim, with its model and its age on it', () => {
  const panel = loadPanel();
  const card = panel.projectCard as (p: ProjectView) => string;
  const p = project('withDigest', []);
  (p as ProjectView).digest = {
    provider: 'openai',
    model: 'sahte-1',
    atMs: Date.now() - 3_600_000,
    phaseKind: 'harden',
    phaseLabelRaw: 'Denetim',
    phaseIndex: 4,
    phaseTotal: 5,
    phaseStatus: 'in_progress',
    percentEstimate: 70,
    percentBasis: 'commits',
    confidence: 'medium',
    nextAction: 'run CI',
    blocker: 'depo itilmedi',
    stallReason: null,
    riskFlags: ['unsigned'],
    evidence: [{ kind: 'commit', ref: 'abc' }],
    conflicts: [],
    unchanged: false,
    summary: 'Özet cümlesi.',
  };
  const html = card(p);

  assert.match(html, /class="digest"/);
  assert.match(html, /Denetim/);
  assert.match(html, /Özet cümlesi\./);
  assert.match(html, /run CI/);
  assert.match(html, /depo itilmedi/);
  // Which model said it, and how long ago — both, always.
  assert.match(html, /openai/);
  assert.match(html, /sahte-1/);
  // The estimate is marked as one, and is not rendered through the counted
  // bar: `.bar` belongs to numbers that were counted.
  assert.match(html, /~%70/);
  const afterDigest = html.slice(html.indexOf('class="digest"'));
  assert.doesNotMatch(afterDigest.slice(0, afterDigest.indexOf('</div>\n  </div>')), /class="bar/);

  // And a project without one shows nothing at all rather than an empty frame.
  const plain = card(project('noDigest', []));
  assert.doesNotMatch(plain, /class="digest"/);
});
