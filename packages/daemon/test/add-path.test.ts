/**
 * `POST /api/v1/projects/path` — the only way a project reaches the board
 * without an agent ever having opened it.
 *
 * The chooser can only offer what the agent's transcript directory remembers,
 * and a repository you have not pointed an agent at yet is remembered
 * nowhere. It also has to stay the *only* discovery route that exists: the
 * plan rules out walking the user's disk for candidates, so nothing here may
 * ever turn into a search.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonServer } from '../src/server.ts';

type Reply = { status: number; json: Record<string, unknown> };

/** The port the current `withServer` bound, for the few checks that need a raw fetch. */
let portForTest = 0;

async function withServer(
  addPath: ((path: string) => Promise<
    { ok: true; projectId: string; displayName: string } | { ok: false; reason: 'notdir' | 'failed' }
  >) | undefined,
  fn: (post: (body: unknown) => Promise<Reply>, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = new DaemonServer({
    port: 0,
    host: '127.0.0.1',
    token: 'tok',
    daemonId: 'test',
    version: '0.0.0',
    latest: () => null,
    health: () => ({}),
    hookToken: 'hooktok',
    onHook: () => {},
    onOversize: () => {},
    addPath: addPath
      ? async (p) => {
          seen.push(p);
          return addPath(p);
        }
      : undefined,
  });
  await server.listen();
  const port = server.boundPort;
  try {
    portForTest = port;
    await fn(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-VT-Token': 'tok' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }, seen);
  } finally {
    await server.close();
  }
}

const ok = async () => ({ ok: true as const, projectId: 'git:abc', displayName: 'Foo' });

test('a directory comes back identified, because the daemon resolves it and the client does not', () => {
  return withServer(ok, async (post) => {
    const r = await post({ path: 'c:/dev/Foo' });
    assert.equal(r.status, 200);
    // Identity is a git probe and a package read. A window that worked it out
    // for itself would be a second implementation of the one rule that must
    // never have two.
    assert.equal(r.json.projectId, 'git:abc');
    assert.equal(r.json.displayName, 'Foo');
  });
});

/**
 * Telling these apart is the difference between the user fixing a typo and
 * the user filing a bug.
 */
test('a path that is not a directory is 404, a failed write is 500', async () => {
  await withServer(async () => ({ ok: false, reason: 'notdir' }), async (post) => {
    assert.equal((await post({ path: 'c:/nope' })).status, 404);
  });
  await withServer(async () => ({ ok: false, reason: 'failed' }), async (post) => {
    assert.equal((await post({ path: 'c:/dev/Foo' })).status, 500);
  });
});

test('a missing or absurd path never reaches the filesystem', async () => {
  await withServer(ok, async (post, seen) => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ path: 42 })).status, 400);
    assert.equal((await post({ path: '' })).status, 400);
    // This string becomes a realpath call and then a line in a file a human
    // edits by hand.
    assert.equal((await post({ path: 'x'.repeat(5000) })).status, 400);
    assert.deepEqual(seen, []);
  });
});

/**
 * Every mutation is a POST. A GET with a side effect can be fired by any page
 * that guessed the token, through an `<img>` tag it never had to be allowed
 * to read the answer to.
 */
test('GET does nothing: naming a project is a mutation', () => {
  return withServer(ok, async (_post, seen) => {
    const res = await fetch(`http://127.0.0.1:${portForTest}/api/v1/projects/path`, {
      headers: { 'X-VT-Token': 'tok' },
    });
    assert.equal(res.status, 405);
    assert.deepEqual(seen, []);
  });
});

test('a build without the capability says so rather than pretending', () => {
  return withServer(undefined, async (post) => {
    assert.equal((await post({ path: 'c:/dev/Foo' })).status, 501);
  });
});
