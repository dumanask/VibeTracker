import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { tr } from '@vibetracker/core';

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
 */

export function generateToken(): string {
  return 'vt_' + randomBytes(24).toString('base64url');
}

export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin navigations and curl send no Origin.
  const o = origin.toLowerCase();
  return (
    o === `http://127.0.0.1:${port}` ||
    o === `http://localhost:${port}` ||
    o === `http://[::1]:${port}`
  );
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

export function guard(req: IncomingMessage, url: URL, port: number, token: string): GuardResult {
  if (!isLoopback(req)) return { ok: false, status: 403, reason: tr('loopback dışı') };
  if (!hostAllowed(req, port)) return { ok: false, status: 403, reason: tr('Host başlığı reddedildi') };
  if (!originAllowed(req, port)) return { ok: false, status: 403, reason: 'Origin reddedildi' };
  if (!tokenMatches(extractToken(req, url), token)) {
    return { ok: false, status: 401, reason: tr('token geçersiz') };
  }
  return { ok: true };
}
