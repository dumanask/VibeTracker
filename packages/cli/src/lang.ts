/**
 * `vt lang` — how complete is the translation, exactly?
 *
 * Translation coverage is usually a matter of opinion ("mostly done"). It
 * does not have to be. Because the source text is the lookup key, the set of
 * strings a command actually asked for is observable at runtime: run the
 * rendering paths, then read `missingKeys()`. What comes back is the precise,
 * copy-pasteable list of what a translator has left to do.
 *
 * `--missing` prints it as a JSON fragment ready to paste into `en.json`, so
 * finishing a language is a mechanical job rather than a hunt through source.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { t, getLang, keyOf, type Lang, localeDir, missingKeys, tr, SOURCE_LANG } from '@vibetracker/core';

const LANGS: Lang[] = ['tr', 'en'];

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
  process.stdout.write(t`\nEtkin dil: ${getLang()}   (kaynak dil: ${SOURCE_LANG})\n`);
  process.stdout.write(t`Kataloglar: ${localeDir()}\n\n`);
  for (const lang of LANGS) {
    if (lang === SOURCE_LANG) {
      process.stdout.write(t`  ${lang}   kaynak dil — katalog gerekmez\n`);
      continue;
    }
    const cat = catalogOf(lang);
    process.stdout.write(
      cat === null
        ? t`  ${lang}   katalog yok\n`
        : t`  ${lang}   ${Object.keys(cat).length} çeviri\n`,
    );
  }
  // Coverage is per-command, and a command can only observe its own process.
  // So the reporter is an environment variable wrapped around a real run,
  // not a subcommand that guesses which paths you care about.
  process.stdout.write(
    tr('\nBir komutun çevrilmemiş metinlerini görmek için o komutu çalıştır:\n') +
      tr('  VT_I18N_REPORT=eksik.json vt --lang en status\n') +
      tr('Çıkan JSON doğrudan locales/en.json içine yapıştırılabilir.\n'),
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
        ? tr('\nKaynak dildesin; arama yapılmadı. Dene: vt --lang en lang missing\n')
        : tr('\nBu çalıştırmada eksik çeviri istenmedi.\n'),
    );
    return 0;
  }
  process.stdout.write(t`\n${keys.length} çevrilmemiş metin:\n\n`);
  for (const k of keys) {
    process.stdout.write(`  ${JSON.stringify(k)}: ${JSON.stringify(k)},\n`);
  }
  process.stdout.write(t`\nBunları ${join(localeDir(), `${getLang()}.json`)} içine yapıştır.\n`);
  return 0;
}

/** Exposed for tests: the key a template literal would produce. */
export { keyOf };
