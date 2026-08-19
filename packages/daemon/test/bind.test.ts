/**
 * `[server] bind` used to be a key that did nothing.
 *
 * It was parsed, validated, warned about -- "everyone on the network can reach
 * it" -- and then read by no one. The daemon always listened on 127.0.0.1. A
 * key that does nothing is worse than a missing one, because a missing one
 * sends you looking for the real setting.
 *
 * Implementing it means letting go of the check every other check rests on, so
 * these tests are mostly about what does *not* change: a default install must
 * behave exactly as it did, and the DNS-rebinding defence has to survive the
 * one change most likely to have quietly removed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { guard, hostAllowed, isLoopbackAddress, machineNames, bindWarning } from '../src/security.ts';

const PORT = 47823;
const TOKEN = 'vt_test_token_value_0123456789';

/** The parts of a request these checks actually read. */
function req(opts: { host?: string; origin?: string; from?: string }): IncomingMessage {
  return {
    headers: {
      ...(opts.host === undefined ? {} : { host: opts.host }),
      ...(opts.origin === undefined ? {} : { origin: opts.origin }),
      'x-vt-token': TOKEN,
    },
    socket: { remoteAddress: opts.from ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const url = new URL('http://127.0.0.1/api/v1/overview');

test('a default install behaves exactly as before', () => {
  assert.equal(guard(req({ host: `127.0.0.1:${PORT}` }), url, PORT, TOKEN).ok, true);
  assert.equal(guard(req({ host: `localhost:${PORT}` }), url, PORT, TOKEN).ok, true);
  // The rebinding case: the socket is loopback because the browser made the
  // request, and the header is the only thing that gives the attacker away.
  assert.equal(guard(req({ host: 'evil.example.com' }), url, PORT, TOKEN).ok, false);
  // And a request that did not come from this machine at all.
  assert.equal(
    guard(req({ host: `127.0.0.1:${PORT}`, from: '192.168.1.50' }), url, PORT, TOKEN).ok,
    false,
  );
});

test('binding wider accepts the network, and still only this machine by name', () => {
  const wide = '0.0.0.0';
  const mine = [...machineNames()].find((n) => n !== '127.0.0.1' && n !== 'localhost' && !n.startsWith('['));
  assert.ok(mine, 'this machine has no external address to test with');

  // The socket check is the layer the user gave up, deliberately.
  assert.equal(
    guard(req({ host: `${mine}:${PORT}`, from: '192.168.1.50' }), url, PORT, TOKEN, wide).ok,
    true,
  );
  // Everything else stands. An attacker's domain resolving here is still the
  // attack, and is still refused.
  assert.equal(
    guard(req({ host: 'evil.example.com', from: '192.168.1.50' }), url, PORT, TOKEN, wide).ok,
    false,
  );
  // Right host, wrong port is a different service.
  assert.equal(hostAllowed(req({ host: `${mine}:${PORT + 1}` }), PORT, wide), false);
  // Loopback keeps working when bound wide -- it is still this machine.
  assert.equal(guard(req({ host: `localhost:${PORT}` }), url, PORT, TOKEN, wide).ok, true);
});

test('the token is still required however it is bound', () => {
  const anon = { headers: { host: `127.0.0.1:${PORT}` }, socket: { remoteAddress: '127.0.0.1' } };
  for (const bind of ['127.0.0.1', '0.0.0.0']) {
    const g = guard(anon as unknown as IncomingMessage, url, PORT, TOKEN, bind);
    assert.equal(g.ok, false);
    assert.equal(g.status, 401);
  }
});

test('the machine knows its own names', () => {
  const names = machineNames();
  assert.ok(names.has('127.0.0.1'));
  assert.ok(names.has('localhost'));
  assert.ok(names.has(hostname().toLowerCase()));
});

test('every spelling of "this machine only" counts as one', () => {
  for (const n of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackAddress(n), true);
  for (const n of ['0.0.0.0', '192.168.1.10', '::']) assert.equal(isLoopbackAddress(n), false);
});

test('a wider bind earns a warning, a loopback one earns silence', () => {
  assert.equal(bindWarning('127.0.0.1', PORT), null);
  assert.match(String(bindWarning('0.0.0.0', PORT)), /0\.0\.0\.0/);
});
