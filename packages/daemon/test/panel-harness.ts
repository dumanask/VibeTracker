/**
 * The dashboard, run the way a browser would run it.
 *
 * The page is a hand-written script inside an HTML file, so no compiler looks
 * at it: a typo there ships a blank page to everyone while the daemon stays
 * perfectly healthy. Executing it against a stub DOM is the only thing that
 * catches that, and it also lets a fixture arrive the way a real report does —
 * through the handlers the page registered — rather than by reaching past the
 * page into its variables.
 *
 * This lived inside `panel.test.ts` until a second suite needed it. It is a
 * `.ts` file rather than a `.test.ts` one so the runner does not try to run a
 * harness as a test; `engine/test/agents-help.ts` is the same arrangement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

/** The page itself, for the tests that read its markup rather than run it. */
export const PANEL = join(fileURLToPath(new URL('../public/', import.meta.url)), 'index.html');

export interface PanelOptions {
  hash?: string;
  /**
   * What `fetch` answers. The default refuses, which keeps a suite offline and
   * exercises the page's own fallback paths; a suite testing a panel that
   * loads its data over HTTP hands in a stub instead.
   */
  fetch?: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
}

/** A stub element. Kept per id: the page writes into `innerHTML` and reads it back. */
export interface StubElement extends Record<string, unknown> {
  hidden: boolean;
  innerHTML: string;
  textContent: string;
}

/** Just enough DOM for the script to reach the end of its top-level code. */
export function loadPanel(options: string | PanelOptions = {}): Record<string, unknown> {
  const opts: PanelOptions = typeof options === 'string' ? { hash: options } : options;
  const html = readFileSync(PANEL, 'utf8');
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(m, 'panel has a script block');
  const src = m[1]!.replace('"__VT_I18N__"', '({})').replace('__VT_TOKEN__', 'test-token');

  const bodyAttrs: string[] = [];
  const listeners = new Map<string, (e: { data: string }) => void>();
  /**
   * What the page asked to hear about on `document`.
   *
   * Swallowing these was fine while every test drove the page through its SSE
   * stream. A panel that only opens when something is clicked cannot be
   * reached that way at all, so they are kept and a test can deliver a click.
   */
  const dom = new Map<string, Array<(e: unknown) => void>>();
  const els = new Map<string, StubElement>();
  const element = (id: string): StubElement => {
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
      } as StubElement;
      els.set(id, e);
    }
    return e;
  };

  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => element(id),
      querySelectorAll: () => [],
      addEventListener(name: string, fn: (e: unknown) => void) {
        const list = dom.get(name) ?? [];
        list.push(fn);
        dom.set(name, list);
      },
      body: { setAttribute: (k: string) => void bodyAttrs.push(k), removeAttribute() {} },
      title: '',
    },
    location: { hash: opts.hash ?? '', pathname: '/', search: '', href: '' },
    EventSource: class {
      addEventListener(name: string, fn: (e: { data: string }) => void): void {
        listeners.set(name, fn);
      }
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: opts.fetch ?? (() => Promise.reject(new Error('offline'))),
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
  /**
   * Deliver a DOM event to whatever the page registered.
   *
   * `target.closest` answers for exactly one selector, because that is how
   * every handler in the page decides whether an event is theirs.
   */
  sandbox.__fire = (name: string, event: unknown): void => {
    const list = dom.get(name) ?? [];
    assert.ok(list.length, `page never listened for "${name}"`);
    for (const fn of list) fn(event);
  };
  sandbox.__click = (selector: string): void => {
    const target = { closest: (s: string) => (s === selector ? { id: selector.slice(1) } : null) };
    (sandbox.__fire as (n: string, e: unknown) => void)('click', { target });
  };
  return sandbox;
}
