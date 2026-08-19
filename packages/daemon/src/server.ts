import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CANDIDATE_LIMIT, HOOK_PATH, type StatusReport } from '@vibetracker/shared';
import { guard, isLoopback, tokenMatches } from './security.ts';
import { catalogEntries, getLang, tr } from '@vibetracker/core';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

export interface ServerDeps {
  port: number;
  host: string;
  token: string;
  daemonId: string;
  version: string;
  /** Latest report, or null before the first scan completes. */
  latest: () => StatusReport | null;
  health: () => Record<string, unknown>;
  /** Stable token for hook deliveries. See `tokens.ts`: so is `token`. */
  hookToken: string;
  /** Called with each raw hook body. Must be O(1); see HookRing. */
  onHook: (raw: string) => void;
  /**
   * Asked to shut down by an authenticated local caller. The daemon owns its
   * own exit — closing the database and the transcript handles — rather than
   * being killed from outside, because a half-written WAL is a worse outcome
   * than a daemon that lives one second longer.
   */
  onShutdown?: () => void;
  /**
   * Persist a new project selection. Returns nothing useful on purpose: the
   * board updates from the next scan, not from an answer invented here.
   */
  setTracking?: (mode: string, selected: string[]) => Promise<void>;
  /**
   * Follow and unfollow named projects, leaving every other choice alone.
   *
   * Returns how many projects are followed afterwards. See the `/tracking`
   * handler for why a delta exists beside a whole-state write.
   */
  changeTracking?: (add: string[], remove: string[]) => Promise<number>;
  /** A payload exceeded the body limit and was discarded. Counted, not hidden. */
  onOversize: () => void;
  /**
   * Phase history for one project: the reconstructed past plus whatever the
   * daemon has watched since. Null when the project is unknown.
   */
  board?: (projectId: string) => Promise<unknown> | unknown;
  /**
   * Every project that could be followed, running or not.
   *
   * Separate from the report because it answers a different question. The
   * report is "what is happening"; this is "what could I choose", and a
   * chooser that only offers what happens to be running right now cannot be
   * used to add the project you closed an hour ago.
   */
  candidates?: () => Array<{
    projectId: string;
    displayName: string;
    lastSeenAt: number;
    /**
     * Whether this project is followed right now.
     *
     * Answered here rather than left for the client to work out, because the
     * answer depends on the tracking *mode* and a client that only sees the
     * board cannot tell "followed because I picked it" from "followed because
     * everything is". A chooser that guesses that wrong un-picks projects the
     * moment you touch it.
     */
    tracked: boolean;
  }>;
  /**
   * Follow a directory the user named.
   *
   * The only route by which a project reaches the board without an agent
   * having opened it. It exists because the chooser can only offer what the
   * transcript directory remembers, and a repository you have not pointed an
   * agent at yet is remembered nowhere.
   *
   * The daemon resolves it, not the client: identity is a git probe and a
   * package read, and a window that worked that out for itself would be a
   * second implementation of the one rule that must never have two.
   */
  addPath?: (path: string) => Promise<
    { ok: true; projectId: string; displayName: string } | { ok: false; reason: 'notdir' | 'failed' }
  >;
  /**
   * The `[digest]` section as a page can show it. Never carries the key.
   *
   * Read fresh from the config file on every call rather than from anything
   * this process is holding, because it is not this process that acts on it —
   * `vt digest` reads the file when somebody types it, possibly days later,
   * and a panel reporting a cached answer would be describing a decision the
   * command will not make.
   */
  digest?: () => Promise<unknown>;
  /**
   * Write a provider choice. Validated in the engine before it arrives here.
   *
   * Returns the same shape `digest()` does, so one round trip both saves and
   * re-reads — the fields that get normalised on the way in (a default address
   * cleared, a conventional variable name dropped) are visibly what they now
   * are rather than what was typed.
   */
  setDigest?: (choice: unknown) => Promise<unknown>;
}

/**
 * Bodies are capped well below anything a sane hook sends. `PostToolUse` can
 * carry a whole file's contents, and buffering that per call would turn the
 * ingest path into a memory amplifier for someone else's `cat`.
 */
const HOOK_BODY_LIMIT = 512 * 1024;

// A project selection is a short list of ids. Anything larger is not one, and
// buffering it would make a settings endpoint into a memory amplifier.
const TRACKING_BODY_LIMIT = 64 * 1024;

/**
 * Read a request body up to `limit`, rejecting anything larger.
 *
 * Deliberately not shared with the hook path: that one must answer in under a
 * millisecond and never awaits, while this one is a rare click and can afford
 * to be ordinary code.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface Client {
  id: number;
  res: ServerResponse;
}

export class DaemonServer {
  #server: Server;
  #clients = new Map<number, Client>();
  #nextClientId = 1;
  #eventId = 0;
  /** Small replay buffer so a reconnecting client can catch up without a full reload. */
  #recent: Array<{ id: number; frame: string }> = [];
  #deps: ServerDeps;

  constructor(deps: ServerDeps) {
    this.#deps = deps;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    // Hook deliveries reuse connections; keep them warm but bounded.
    this.#server.keepAliveTimeout = 65_000;
    this.#server.requestTimeout = 30_000;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#deps.port, this.#deps.host, () => {
        this.#server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * The port actually bound, which is not always the one asked for: tests bind
   * port 0 and let the OS choose, so that a suite can run beside a real daemon
   * already holding 47823.
   */
  get boundPort(): number {
    const a = this.#server.address();
    return a && typeof a === 'object' ? a.port : this.#deps.port;
  }

  async close(): Promise<void> {
    for (const c of this.#clients.values()) c.res.end();
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Push a named event to every connected dashboard. */
  broadcast(event: string, data: unknown): void {
    const id = ++this.#eventId;
    const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.#recent.push({ id, frame });
    if (this.#recent.length > 200) this.#recent.shift();
    for (const c of this.#clients.values()) {
      // Ignore backpressure: a stalled dashboard must never stall the daemon.
      c.res.write(frame);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;

    // `/api/v1/health` answers without a token so a second instance can ask
    // "is that you?" before deciding to exit — it cannot know the running
    // daemon's token, and a single-instance check that needed one would let two
    // daemons share a port.
    //
    // But it used to spread `health()` into that unauthenticated answer while
    // the comment above it said "only an id and version". It was neither: the
    // body carried the database path, the last error, resident memory, hook
    // counters and transcript statistics to anything that could reach loopback,
    // and every call ran three `COUNT(*)` and two pragmas with no rate limit.
    //
    // So the identity half stays open and the diagnostic half moves behind the
    // guard, on the same path. `vt doctor` reads the runtime file anyway and
    // now sends the token it finds there; anything that cannot is answered with
    // exactly what the comment always promised.
    if (path === '/api/v1/health') {
      const known = guard(req, url, this.boundPort, this.#deps.token, this.#deps.host);
      const id = { ok: true, daemonId: this.#deps.daemonId, version: this.#deps.version };
      return json(res, 200, known.ok ? { ...id, ...this.#deps.health() } : id);
    }

    // Hook ingest is handled before the dashboard guard, with its own rules:
    // no Origin (the agent is not a browser), its own long-lived token, and a
    // 204 that costs nothing. Everything about this path is shaped by the fact
    // that Claude Code *waits* for the response before continuing the turn.
    if (path === HOOK_PATH) return this.#ingest(req, res);

    // The bound port, not the configured one. They are the same in production;
    // they differ when a test binds port 0 and lets the OS choose, and a guard
    // that checked the configured port would reject every request in exactly
    // the setup that exercises it.
    const g = guard(req, url, this.boundPort, this.#deps.token, this.#deps.host);
    if (!g.ok) return json(res, g.status ?? 403, { error: g.reason });

    if (path === '/' || path === '/index.html') {
      let html: string;
      try {
        html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
      } catch {
        return json(res, 500, { error: tr('interface file not found') });
      }
      // The page needs the token to open its own SSE stream; it is same-origin
      // and already authenticated to be reading this response at all.
      // Function replacers throughout. In a *string* replacement `$&`, `$'`,
      // ``$` `` and `$$` are substitution patterns, so a catalog entry that
      // happened to contain one would splice a piece of the page into itself —
      // silently, and differently in each language. A function replacement has
      // no such syntax.
      html = html.replace('__VT_TOKEN__', () => this.#deps.token);
      // The dashboard cannot read locales/ from a browser, so the catalog
      // travels with the page. One JSON file still drives both surfaces.
      const catalog = JSON.stringify(catalogEntries());
      html = html.replace('"__VT_I18N__"', () => catalog).replace('__VT_LANG__', () => getLang());
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // The page is one file: its script and style are inline and it fetches
        // nothing but its own origin. Saying so costs a header and turns a
        // whole class of injection into a console error. `frame-ancestors` is
        // the one that matters most here — it stops any page from framing a
        // dashboard that is authenticated by a query parameter.
        'content-security-policy': [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          "img-src data:",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      return void res.end(html);
    }

    if (path === '/api/v1/overview') {
      const latest = this.#deps.latest();
      return json(res, latest ? 200 : 503, latest ?? { error: tr('the first scan has not finished yet') });
    }

    if (path === '/api/v1/stream') {
      return this.#stream(req, res);
    }

    // Choosing which projects to follow is the one setting the dashboard can
    // change, because it is a viewing decision and walking to a terminal to
    // hide a project defeats a window pinned over your work.
    if (path === '/api/v1/tracking') {
      if (req.method !== 'POST') return json(res, 405, { error: tr('POST required') });
      if (!this.#deps.setTracking) return json(res, 501, { error: tr('not available in this version') });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, TRACKING_BODY_LIMIT));
      } catch {
        return json(res, 400, { error: tr('could not read the body') });
      }
      const b = body as { mode?: unknown; selected?: unknown; add?: unknown; remove?: unknown };
      // Validated rather than trusted: this ends up in a config file the user
      // edits by hand, and a stray object in that array would break the file
      // for a human, not just for us.
      const ids = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(0, 500)
          : [];

      // Two forms, and the difference matters.
      //
      // `{mode, selected}` states the whole selection, and is right for a
      // client that shows the user the whole list and an explicit save.
      //
      // `{add, remove}` states a change. A client with a *partial* view — a
      // 340-pixel window listing what it had room for, a chooser capped at
      // sixty rows — must use this one: sending its visible set as the whole
      // truth silently un-follows every project it did not happen to show.
      if (b.add !== undefined || b.remove !== undefined) {
        if (!this.#deps.changeTracking) return json(res, 501, { error: tr('not available in this version') });
        const add = ids(b.add);
        const remove = ids(b.remove);
        try {
          const count = await this.#deps.changeTracking(add, remove);
          return json(res, 200, { ok: true, mode: 'selected', count });
        } catch {
          return json(res, 500, { error: tr('could not write the configuration') });
        }
      }

      const mode = b.mode === 'selected' ? 'selected' : 'all';
      const selected = ids(b.selected);
      try {
        await this.#deps.setTracking(mode, selected);
      } catch {
        return json(res, 500, { error: tr('could not write the configuration') });
      }
      return json(res, 200, { ok: true, mode, count: selected.length });
    }

    // Naming a directory, as opposed to picking one off the list. A path is
    // not a project id, so it gets its own endpoint rather than a magic value
    // in `add`: the failure modes are different and the answers are different.
    if (path === '/api/v1/projects/path') {
      if (req.method !== 'POST') return json(res, 405, { error: tr('POST required') });
      if (!this.#deps.addPath) return json(res, 501, { error: tr('not available in this version') });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, TRACKING_BODY_LIMIT));
      } catch {
        return json(res, 400, { error: tr('could not read the body') });
      }
      const raw = (body as { path?: unknown }).path;
      // Length-capped before it reaches the filesystem: this string becomes a
      // `realpath` call and then a line in a config file a human edits.
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
        return json(res, 400, { error: tr('a directory path is required') });
      }
      const added = await this.#deps.addPath(raw);
      if (!added.ok) {
        // 404 for "that is not a directory" and 500 for "we could not write
        // it": telling them apart is the difference between the user fixing a
        // typo and the user filing a bug.
        return added.reason === 'notdir'
          ? json(res, 404, { error: tr('no such directory') })
          : json(res, 500, { error: tr('could not write the configuration') });
      }
      return json(res, 200, { ok: true, projectId: added.projectId, displayName: added.displayName });
    }

    if (path === '/api/v1/candidates') {
      if (!this.#deps.candidates) return json(res, 501, { error: tr('not available in this version') });
      const candidates = this.#deps.candidates();
      // Said out loud, because a client that does not know the list is capped
      // will treat it as the whole truth. Exactly-at-the-cap reads as
      // truncated, which is one project's worth of over-caution in exchange
      // for never claiming completeness we cannot check.
      return json(res, 200, { candidates, truncated: candidates.length >= CANDIDATE_LIMIT });
    }

    // Stopping is a mutation, so it is POST: a GET would let any page that
    // guessed the token kill the daemon through an <img> tag.
    if (path === '/api/v1/shutdown') {
      if (req.method !== 'POST') return json(res, 405, { error: tr('POST required') });
      if (!this.#deps.onShutdown) return json(res, 501, { error: tr('not available in this version') });
      // Answer first, exit after: the caller should learn it worked rather
      // than see a dropped connection and have to guess.
      json(res, 200, { ok: true, stopping: true });
      setTimeout(() => this.#deps.onShutdown?.(), 50).unref();
      return;
    }

    // Which LLM writes the summary, from the window rather than from a text
    // editor. The one setting in this product that decides whether anything
    // leaves the machine, and until now the only way to change it was to find
    // a TOML file — so it stayed at its default, which is the safe answer but
    // not always the wanted one.
    if (path === '/api/v1/digest') {
      if (req.method === 'GET') {
        if (!this.#deps.digest) return json(res, 501, { error: tr('not available in this version') });
        return json(res, 200, await this.#deps.digest());
      }
      if (req.method !== 'POST') return json(res, 405, { error: tr('POST required') });
      if (!this.#deps.setDigest) return json(res, 501, { error: tr('not available in this version') });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, TRACKING_BODY_LIMIT));
      } catch {
        return json(res, 400, { error: tr('could not read the body') });
      }
      // The refusal codes come back from the engine; the sentences are made
      // here, because this is the layer that knows a person is reading them.
      const saved = (await this.#deps.setDigest(body)) as
        | { ok: true; view: unknown }
        | { ok: false; reason: string };
      if (saved.ok === false) {
        const why: Record<string, string> = {
          cli: tr('The option that runs a command of your own cannot be set from here — write it in the config file.'),
          provider: tr('No such provider.'),
          model: tr('Invalid model name.'),
          base_url: tr('Invalid address.'),
          base_url_scheme: tr('The address must be http:// or https://.'),
          key_env: tr('Invalid environment variable name.'),
          key_env_looks_like_key: tr('This field takes the name of the environment variable holding the key, not the key itself.'),
          shape: tr('could not read the body'),
          failed: tr('could not write the configuration'),
        };
        const message = why[saved.reason] ?? tr('could not read the body');
        return json(res, saved.reason === 'failed' ? 500 : 400, {
          error: message,
          reason: saved.reason,
        });
      }
      return json(res, 200, saved.view);
    }

    if (path === '/api/v1/board') {
      const id = url.searchParams.get('project');
      if (!id) return json(res, 400, { error: tr('the project parameter is required') });
      if (!this.#deps.board) return json(res, 501, { error: tr('the phase board is not available in this build') });
      const data = await this.#deps.board(id);
      return json(res, data ? 200 : 404, data ?? { error: tr('project not found') });
    }

    return json(res, 404, { error: 'not found' });
  }

  /**
   * The hook endpoint. Everything here is measured against one number: how long
   * the agent is stopped. Validate two headers, buffer the body, push, 204.
   * No parsing, no database, no filesystem, no await on anything but the socket.
   *
   * Even the rejections are cheap and silent-ish — an attacker who guessed the
   * path learns nothing from the response, and a misconfigured hook gets a
   * clear status rather than a hang.
   */
  #ingest(req: IncomingMessage, res: ServerResponse): void {
    const done = (status: number): void => {
      res.writeHead(status, { 'cache-control': 'no-store' });
      res.end();
    };
    if (req.method !== 'POST') return done(405);
    if (!isLoopback(req)) return done(403);
    const provided = req.headers['x-vt-token'];
    if (!tokenMatches(typeof provided === 'string' ? provided : undefined, this.#deps.hookToken)) {
      return done(401);
    }

    let size = 0;
    let over = false;
    let chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (over) return; // Keep draining, keep nothing.
      size += c.length;
      if (size > HOOK_BODY_LIMIT) {
        // Oversized payloads are discarded rather than buffered — a
        // `PostToolUse` carrying a whole file must not become a memory
        // amplifier. But we deliberately do NOT destroy the socket: measured,
        // that surfaces to the caller as "fetch failed", and a hook that
        // *errors* is worse for the user than one that quietly drops an event.
        // They are trying to work; our diagnostics are not their problem.
        over = true;
        chunks = [];
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over && chunks.length > 0) this.#deps.onHook(Buffer.concat(chunks).toString('utf8'));
      if (over) this.#deps.onOversize();
      done(204);
    });
    req.on('error', () => done(204));
  }

  #stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const id = this.#nextClientId++;
    this.#clients.set(id, { id, res });

    // Replay anything missed across a reconnect; the browser supplies the id.
    const lastId = Number(req.headers['last-event-id'] ?? 0);
    if (Number.isFinite(lastId) && lastId > 0) {
      for (const r of this.#recent) if (r.id > lastId) res.write(r.frame);
    }

    const latest = this.#deps.latest();
    if (latest) {
      res.write(`event: overview\ndata: ${JSON.stringify(latest)}\n\n`);
    }

    // Comment frames keep sleeping laptops and intermediaries honest.
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.#clients.delete(id);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // No CORS headers, ever: a cross-origin page must not be able to read this.
  });
  res.end(payload);
}
