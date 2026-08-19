import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { t, tr } from '@vibetracker/core';

/**
 * Localhost is not a security boundary.
 *
 * The attack this file exists to stop is DNS rebinding: an attacker's page
 * resolves their own domain to 127.0.0.1, so the browser happily connects to
 * our port — and because the *browser* made the request, the socket really does
 * come from loopback. Checking `remoteAddress` alone therefore proves nothing.
 * What the attacker cannot forge is the `Host` header, which still carries
 * their domain. So we require Host to be one of ours.
 *
 * Layered: loopback socket, then Host allowlist, then Origin allowlist, then a
 * bearer token. CORS headers are never sent, so a browser cannot read a
 * response cross-origin even if a request slipped through.
 *
 * A user who binds wider than loopback gives up the first layer -- that is what
 * they asked for -- and not one of the others. The Host allowlist grows to this
 * machine's own names and addresses, which an attacker's domain is still not
 * one of, so the rebinding defence survives the change that would most
 * plausibly have quietly removed it.
 */

/** Is this address one of the ways of saying "this machine only"? */
export function isLoopbackAddress(bind: string): boolean {
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1' || bind === '[::1]';
}

/**
 * Every name this machine may legitimately be called by, lowercased.
 *
 * Computed once: interfaces do change, but a daemon that picked up a new
 * address mid-run would be widening its own allowlist without being asked, and
 * restarting to move network is the safer half of that trade.
 */
let hostNames: Set<string> | null = null;
export function machineNames(): Set<string> {
  if (hostNames) return hostNames;
  const names = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  names.add(hostname().toLowerCase());
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.internal) continue;
      // A v6 literal is bracketed in a Host header and bare everywhere else,
      // and a link-local one carries a zone suffix the header will not have.
      names.add(n.family === 'IPv6' ? `[${n.address.split('%')[0]}]` : n.address);
    }
  }
  hostNames = names;
  return names;
}


export function generateToken(): string {
  return 'vt_' + randomBytes(24).toString('base64url');
}

export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** The host:port pairs this daemon answers to, given what it is bound to. */
function allowedHosts(port: number, bind: string): Set<string> {
  const names = isLoopbackAddress(bind)
    ? ['127.0.0.1', 'localhost', '[::1]']
    : [...machineNames()];
  return new Set(names.map((n) => `${n.toLowerCase()}:${port}`));
}

export function hostAllowed(req: IncomingMessage, port: number, bind = '127.0.0.1'): boolean {
  return allowedHosts(port, bind).has((req.headers.host ?? '').toLowerCase());
}

export function originAllowed(req: IncomingMessage, port: number, bind = '127.0.0.1'): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin navigations and curl send no Origin.
  const o = origin.toLowerCase();
  for (const h of allowedHosts(port, bind)) if (o === `http://${h}`) return true;
  return false;
}

/** Constant-time compare so the token cannot be recovered by timing. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers['x-vt-token'];
  if (typeof header === 'string') return header;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  // EventSource cannot set headers, so SSE authenticates via the query string.
  return url.searchParams.get('t') ?? undefined;
}

export interface GuardResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export function guard(
  req: IncomingMessage,
  url: URL,
  port: number,
  token: string,
  bind = '127.0.0.1',
): GuardResult {
  // The socket check is the one layer a wider bind deliberately gives up. It
  // is skipped rather than softened: a half-check that accepts "anything on
  // the local subnet" would read like a boundary and not be one.
  if (isLoopbackAddress(bind) && !isLoopback(req)) {
    return { ok: false, status: 403, reason: tr('not loopback') };
  }
  if (!hostAllowed(req, port, bind)) {
    return { ok: false, status: 403, reason: tr('Host header refused') };
  }
  if (!originAllowed(req, port, bind)) {
    return { ok: false, status: 403, reason: tr('Origin refused') };
  }
  if (!tokenMatches(extractToken(req, url), token)) {
    return { ok: false, status: 401, reason: tr('invalid token') };
  }
  return { ok: true };
}

/** The banner a wider bind earns, shown wherever the daemon describes itself. */
export function bindWarning(bind: string, port: number): string | null {
  if (isLoopbackAddress(bind)) return null;
  return t`the dashboard is listening on ${bind}:${port} — anyone on this network can reach it`;
}
