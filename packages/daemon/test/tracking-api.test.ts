/**
 * `POST /api/v1/tracking` takes two forms, and the difference is a data-loss
 * bug waiting to happen.
 *
 * A client that shows the user the whole list and an explicit save can state
 * the whole selection. A client with a *partial* view cannot: the pinned
 * window lists what fits in 340 pixels and the chooser is capped at sixty
 * rows, so sending the visible set as the whole truth silently unfollows every
 * project that was not on screen. Those clients send a delta instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonServer } from '../src/server.ts';

interface Call {
  mode?: string;
  selected?: string[];
  add?: string[];
  remove?: string[];
}

async function withServer(
  fn: (post: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>, calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  // Whatever is followed right now, as the daemon would have it.
  let followed = ['a', 'b', 'c'];
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
    setTracking: async (mode, selected) => {
      calls.push({ mode, selected });
      followed = [...selected];
    },
    changeTracking: async (add, remove) => {
      calls.push({ add, remove });
      followed = [...followed.filter((id) => !remove.includes(id)), ...add.filter((id) => !followed.includes(id))];
      return followed.length;
    },
  });
  await server.listen();
  const port = server.boundPort;
  try {
    await fn(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tracking`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-VT-Token': 'tok' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }, calls);
  } finally {
    await server.close();
  }
}

test('a whole selection is written as a whole selection', async () => {
  await withServer(async (post, calls) => {
    const r = await post({ mode: 'selected', selected: ['x', 'y'] });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [{ mode: 'selected', selected: ['x', 'y'] }]);
  });
});

test('a delta is applied to what is already followed, not instead of it', async () => {
  await withServer(async (post, calls) => {
    const r = await post({ add: ['d'] });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [{ add: ['d'], remove: [] }]);
    // Four now: the three that were followed, plus the one just added — and
    // crucially the client never had to know what the three were.
    assert.equal(r.json.count, 4);
  });
});

test('unfollowing one project leaves the others followed', async () => {
  await withServer(async (post) => {
    const r = await post({ remove: ['b'] });
    assert.equal(r.json.count, 2);
  });
});

test('a delta always lands in selected mode', async () => {
  await withServer(async (post) => {
    const r = await post({ remove: ['b'] });
    // Anything else would re-add whatever the user opens next, quietly
    // undoing the choice they just made.
    assert.equal(r.json.mode, 'selected');
  });
});

test('junk in the arrays is dropped rather than written to a file a human edits', async () => {
  await withServer(async (post, calls) => {
    await post({ add: ['ok', 42, null, { nope: true }, 'x'.repeat(500)] });
    assert.deepEqual(calls[0]!.add, ['ok']);
  });
});

test('an empty delta is still a delta, not a request to clear the list', async () => {
  await withServer(async (post, calls) => {
    const r = await post({ add: [] });
    assert.deepEqual(calls, [{ add: [], remove: [] }]);
    assert.equal(r.json.count, 3);
  });
});
