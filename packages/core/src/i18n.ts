/**
 * Translation, with the source language as the key.
 *
 * The usual design — `t('doctor.node.label')` plus a catalog — was rejected
 * for two measured reasons.
 *
 * 1. **A missing key must not produce garbage.** With opaque ids, an
 *    untranslated string renders as `doctor.node.label` and the line becomes
 *    unreadable. Here the English text *is* the key, so a missing translation
 *    falls back to a real sentence. Partial coverage stays usable, which
 *    matters because coverage will always be partial for a while.
 *
 * 2. **Invented keys drift from the text.** Someone edits the sentence,
 *    forgets the catalog, and the id now names something else. When the text
 *    is the key, editing the sentence invalidates the translation by
 *    construction and `missingKeys()` reports it.
 *
 * Interpolations are stripped out of the key, so
 * `t\`${n} records found\`` keys on `"{0} records found"` and the same
 * translation serves every value.
 */

export type Lang = 'tr' | 'en';

/** Source language. Strings in the code are written in this language. */
export const SOURCE_LANG: Lang = 'en';

type Catalog = Record<string, string>;

let current: Lang = SOURCE_LANG;
let catalog: Catalog = {};
const missing = new Set<string>();

/**
 * Build the lookup key: literal parts joined by `{0}`, `{1}`… Whitespace is
 * preserved, because leading indentation is part of how these lines line up
 * in a terminal and a translation has to reproduce it.
 */
export function keyOf(strings: readonly string[]): string {
  let out = strings[0] ?? '';
  for (let i = 1; i < strings.length; i++) out += `{${i - 1}}${strings[i] ?? ''}`;
  return out;
}

function fill(template: string, values: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (whole, d: string) => {
    const v = values[Number(d)];
    return v === undefined ? whole : String(v);
  });
}

/**
 * Tagged template translator. Falls back to the source text — never to a key,
 * never to an empty string.
 */
export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  const key = keyOf(strings);
  if (current === SOURCE_LANG) return fill(key, values);
  const hit = catalog[key];
  if (hit === undefined) {
    missing.add(key);
    return fill(key, values);
  }
  return fill(hit, values);
}

/** Same lookup for a string that is not a template literal. */
export function tr(text: string): string {
  if (current === SOURCE_LANG) return text;
  const hit = catalog[text];
  if (hit === undefined) {
    missing.add(text);
    return text;
  }
  return hit;
}

export function setLang(lang: Lang, entries: Catalog): void {
  current = lang;
  catalog = entries;
  missing.clear();
}

export function getLang(): Lang {
  return current;
}

/**
 * The active catalog, for handing to another runtime.
 *
 * The dashboard runs in a browser and cannot read `locales/`, so the daemon
 * inlines the catalog into the page. Serving it rather than duplicating the
 * strings in the HTML keeps one source of truth: a translator edits one JSON
 * file and both the terminal and the browser change.
 */
export function catalogEntries(): Record<string, string> {
  return { ...catalog };
}

/**
 * Every key that was asked for and not found, in encounter order. This is what
 * makes coverage measurable rather than a matter of opinion — `vt lang
 * --missing` runs the commands and prints exactly what is left.
 */
export function missingKeys(): string[] {
  return [...missing];
}

/**
 * Resolve the language from, in order: an explicit argument, `VT_LANG`, the
 * config, then the OS locale. The OS comes last on purpose — someone running
 * a Turkish Windows install may still want English output, and the config is
 * where they say so.
 */
export function resolveLang(explicit?: string, fromConfig?: string): Lang {
  const candidates = [explicit, process.env.VT_LANG, fromConfig, osLocale()];
  for (const c of candidates) {
    if (!c) continue;
    const short = c.trim().slice(0, 2).toLowerCase();
    if (short === 'tr' || short === 'en') return short;
  }
  return SOURCE_LANG;
}

function osLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
