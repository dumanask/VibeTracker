/**
 * Loading translation catalogs from disk.
 *
 * Split from `i18n.ts` so the translator itself stays free of filesystem
 * access: tests set a catalog directly, and the daemon's hot paths never
 * touch `node:fs` by accident.
 *
 * Like `lexicons/`, catalogs are **data, not code**. A translation fix should
 * not require a code release, and a contributor should be able to send a JSON
 * file without touching TypeScript.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setLang, SOURCE_LANG, type Lang } from './i18n.ts';

const LOCALE_DIR = join(import.meta.dirname, '..', 'locales');

export function localeDir(): string {
  return LOCALE_DIR;
}

/**
 * Read a catalog without installing it.
 *
 * Needed because one surface has to speak two languages at once: the note
 * reads a sentence aloud, and no installed voice may speak the interface
 * language. It then says the other language's wording instead — so the words
 * for *both* have to be handed over at launch, while `setLang` can only hold
 * one. Returns an empty object for the source language, whose text is the key.
 */
export function catalogFor(lang: Lang): Record<string, string> {
  if (lang === SOURCE_LANG) return {};
  try {
    const raw = JSON.parse(readFileSync(join(LOCALE_DIR, `${lang}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_') && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Translate one source string into a language that is not the active one.
 *
 * Falls back to the source text, like `tr` does: a missing translation should
 * produce a real sentence, never a key.
 */
export function trInto(lang: Lang, text: string): string {
  if (lang === SOURCE_LANG) return text;
  return catalogFor(lang)[text] ?? text;
}

/**
 * Install the catalog for `lang`. A missing or broken file is not fatal:
 * output falls back to the source language, which is a working sentence.
 * Refusing to start over a translation file would be absurd.
 */
export function loadLang(lang: Lang): { ok: boolean; entries: number; detail?: string } {
  if (lang === SOURCE_LANG) {
    setLang(lang, {});
    return { ok: true, entries: 0 };
  }
  const file = join(LOCALE_DIR, `${lang}.json`);
  if (!existsSync(file)) {
    setLang(SOURCE_LANG, {});
    return { ok: false, entries: 0, detail: `${file} not found` };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      // A key starting with `_` is a note to translators, not a string.
      if (k.startsWith('_')) continue;
      if (typeof v === 'string') entries[k] = v;
    }
    setLang(lang, entries);
    return { ok: true, entries: Object.keys(entries).length };
  } catch (e) {
    setLang(SOURCE_LANG, {});
    return { ok: false, entries: 0, detail: (e as Error).message };
  }
}
