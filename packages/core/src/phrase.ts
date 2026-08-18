/**
 * Sentences the engine builds but does not write.
 *
 * The phase engine produces explanations — "6/20 madde · docs/33_plan.md ·
 * dün" — and the first attempt built them as strings. That worked until
 * translation, where it failed for a structural reason worth recording: a
 * finished sentence containing a file name and a count is a *unique* string
 * per project, so every project would mint its own catalog key and no
 * translator could ever finish. The missing-key report, whose whole value is
 * being an actionable list, would fill with entries nobody can act on.
 *
 * So the engine emits a key plus its arguments and the renderer does the
 * writing. One catalog entry — `'{0}/{1} madde · {2} · {3}'` — then covers
 * every project forever.
 *
 * The same shape is what the HTTP API should have been serving all along: a
 * client that receives `{key, args}` can render it, style the parts
 * differently, or link the file name. A client that receives a sentence can
 * only print it.
 */
import type { Phrase } from '@vibetracker/shared';
import { tr } from './i18n.ts';

export type { Phrase };

export function ph(key: string, ...args: Array<string | number | Phrase>): Phrase {
  return { key, args };
}

export function isPhrase(v: unknown): v is Phrase {
  return typeof v === 'object' && v !== null && typeof (v as Phrase).key === 'string';
}

/** Translate and interpolate, recursively. */
export function say(p: Phrase | string | undefined): string {
  if (p === undefined) return '';
  if (typeof p === 'string') return p;
  const template = tr(p.key);
  return template.replace(/\{(\d+)\}/g, (whole, d: string) => {
    const v = p.args[Number(d)];
    if (v === undefined) return whole;
    return isPhrase(v) ? say(v) : String(v);
  });
}

/**
 * Relative day count, as a phrase. Days rather than hours on purpose: these
 * are planning documents, and "3 hours ago" implies a precision the mtime of
 * a markdown file does not have.
 */
export function agoPhrase(ms: number): Phrase {
  const d = Math.round(ms / 86_400_000);
  if (d < 1) return ph('bugün');
  if (d === 1) return ph('dün');
  return ph('{0} gün önce', d);
}
