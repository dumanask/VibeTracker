/**
 * `vt lang` — how complete is the translation, exactly?
 *
 * Translation coverage is usually a matter of opinion ("mostly done"). It
 * does not have to be. Because the source text is the lookup key, the set of
 * strings a command actually asked for is observable at runtime: run the
 * rendering paths, then read `missingKeys()`. What comes back is the precise,
 * copy-pasteable list of what a translator has left to do.
 *
 * `--missing` prints it as a JSON fragment ready to paste into `tr.json`, so
 * finishing a language is a mechanical job rather than a hunt through source.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { t, getLang, keyOf, type Lang, localeDir, missingKeys, tr, SOURCE_LANG } from '@vibetracker/core';

const LANGS: Lang[] = ['en', 'tr'];

export async function runLang(sub: string | undefined): Promise<number> {
  if (sub === 'missing') return reportMissing();
  return status();
}

function catalogOf(lang: Lang): Record<string, string> | null {
  const file = join(localeDir(), `${lang}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_') && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (e) {
    process.stderr.write(`${file}: ${(e as Error).message}\n`);
    return null;
  }
}

function status(): number {
  process.stdout.write(t`\nActive language: ${getLang()}   (source language: ${SOURCE_LANG})\n`);
  process.stdout.write(t`Catalogs: ${localeDir()}\n\n`);
  for (const lang of LANGS) {
    if (lang === SOURCE_LANG) {
      process.stdout.write(t`  ${lang}   source language — no catalog needed\n`);
      continue;
    }
    const cat = catalogOf(lang);
    process.stdout.write(
      cat === null
        ? t`  ${lang}   no catalog\n`
        : t`  ${lang}   ${Object.keys(cat).length} translations\n`,
    );
  }
  // Coverage is per-command, and a command can only observe its own process.
  // So the reporter is an environment variable wrapped around a real run,
  // not a subcommand that guesses which paths you care about.
  process.stdout.write(
    tr('\nTo see a command\'s untranslated strings, run that command:\n') +
      tr('  VT_I18N_REPORT=missing.json vt --lang tr status\n') +
      tr('The JSON it prints can be pasted straight into locales/tr.json.\n'),
  );
  return 0;
}

/**
 * Print keys that were requested and not found. The command renders the help
 * text first so there is always something to report even on a bare run — the
 * point is the format, and a longer list comes from wiring this into whatever
 * command you are translating.
 */
function reportMissing(): number {
  const keys = missingKeys();
  if (keys.length === 0) {
    process.stdout.write(
      getLang() === SOURCE_LANG
        ? tr('\nYou are in the source language; nothing was looked up. Try: vt --lang tr lang missing\n')
        : tr('\nNothing was left untranslated in this run.\n'),
    );
    return 0;
  }
  process.stdout.write(t`\n${keys.length} untranslated strings:\n\n`);
  for (const k of keys) {
    process.stdout.write(`  ${JSON.stringify(k)}: ${JSON.stringify(k)},\n`);
  }
  process.stdout.write(t`\nPaste these into ${join(localeDir(), `${getLang()}.json`)}.\n`);
  return 0;
}

/** Exposed for tests: the key a template literal would produce. */
export { keyOf };
