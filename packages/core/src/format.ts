import { getLang, type Lang } from './i18n.ts';

/**
 * Units must be unambiguous: `sn` seconds, `dk` minutes, `sa` hours, `g` days.
 * Using `s` for both seconds and "saat" made "9 hours 36 minutes" render as
 * `9s 36dk`, which reads as nine seconds — the exact opposite of the truth.
 */
const UNITS: Record<Lang, { s: string; m: string; h: string; d: string }> = {
  tr: { s: 'sn', m: 'dk', h: 'sa', d: 'g' },
  en: { s: 's', m: 'm', h: 'h', d: 'd' },
};

/**
 * How far into the future a timestamp may sit before we stop calling it "now".
 *
 * A scan takes seconds and stamps `generatedAt` at the top, so a session that
 * writes while we are still reading lands *after* the instant everything is
 * compared against. That is the busiest agent on the machine — precisely the
 * one the panel most needs to get right — and it would otherwise render `?`.
 *
 * Anything further ahead than a scan could account for is real clock skew: a
 * cloud-synced file carrying another machine's clock, or a wrong system time.
 * That keeps its `?`, because quietly reporting it as "now" would invent a
 * fact, and a clock that is minutes off is worth seeing.
 */
export const FUTURE_TOLERANCE_MS = 90_000;

/**
 * Age of `at` as observed from `now`, with future timestamps inside the
 * tolerance folded to zero. Every age in the product goes through here so the
 * rule is stated once instead of being re-decided per call site.
 */
export function sinceMs(now: number, at: number): number {
  const d = now - at;
  return d < 0 && d > -FUTURE_TOLERANCE_MS ? 0 : d;
}

export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  // Units are looked up rather than translated as whole strings: an age
  // appears on nearly every line, and a catalog entry per duration would be
  // thousands of keys for four words.
  const u = UNITS[getLang()] ?? UNITS.tr;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${u.m} ${s % 60}${u.s}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${u.h} ${m % 60}${u.m}`;
  return `${Math.floor(h / 24)}${u.d} ${h % 24}${u.h}`;
}

export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1) + '…';
}

/**
 * Percent literal, in the order the language writes it.
 *
 * Turkish puts the sign first (`%99`), English puts it last (`99%`). This is
 * one of the few places where a translation cannot be a catalog entry: the
 * number is the message, and the sign moves around it.
 */
export function fmtPercent(value: number, approximate = false): string {
  const tilde = approximate ? '~' : '';
  return getLang() === 'tr' ? `${tilde}%${value}` : `${tilde}${value}%`;
}
