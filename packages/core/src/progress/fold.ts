/**
 * Locale-safe text folding for lexicon matching.
 *
 * This is NOT the path folding in `platform/paths.ts` — that one answers "are
 * these two paths the same file", this one answers "is this word in my
 * dictionary". They must stay separate: path folding has to be conservative,
 * word folding has to be aggressive.
 *
 * `toLocaleLowerCase()` is banned throughout the codebase. Under a Turkish
 * locale it maps `I` → `ı` and `İ` → `i`, so `İPTAL` and `IPTAL` fold to
 * different strings depending on which machine you run on. The output of this
 * function must not depend on the user's locale, ever.
 *
 * The pipeline is: compatibility-decompose, drop combining marks, apply the
 * few explicit mappings that decomposition cannot express, then invariant
 * lowercase. Decomposition already handles ş→s, ğ→g, ç→c, ö→o, ü→u and the
 * dotted capital İ (which decomposes to I + combining dot). What it cannot
 * handle is dotless ı, which has no decomposition at all, and German ß.
 */

const EXPLICIT: Record<string, string> = {
  ı: 'i',
  ẞ: 'ss',
  ß: 'ss',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
};

const COMBINING = /\p{M}/gu;

export function fold(s: string): string {
  let out = '';
  for (const ch of s) out += EXPLICIT[ch] ?? ch;
  return out.normalize('NFKD').replace(COMBINING, '').toLowerCase();
}

/** Fold and collapse everything that is not a letter or digit into single spaces. */
export function foldWords(s: string): string {
  return fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Does the folded text contain this folded term as a whole word?
 * Substring matching would make "plan" match "planlama" and "explanation".
 */
export function hasWord(foldedText: string, foldedTerm: string): boolean {
  if (!foldedTerm) return false;
  const i = foldedText.indexOf(foldedTerm);
  if (i === -1) return false;
  const before = i === 0 ? ' ' : foldedText[i - 1]!;
  const after = foldedText[i + foldedTerm.length] ?? ' ';
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

/**
 * Does the folded text contain this term as the *stem* of a word?
 *
 * Turkish is agglutinative: `envanter` becomes `envanteri`, `arşiv` becomes
 * `arşivi`, `analiz` becomes `analizi`. Strict word matching misses every one
 * of them, and those are exactly the words that disqualify a document from
 * being counted — so the failure mode is silent and one-directional: an
 * inventory named `envanteri` sails through as a plan.
 *
 * The term must start at a word boundary; only the tail may be inflected. That
 * asymmetry is what keeps `plan` from matching `explanation` while still
 * matching `planlama`. Reserved for role vocabulary, where terms are long
 * nouns — status words stay on exact matching, since `var` and `yok` would
 * match far too much.
 */
const MAX_SUFFIX = 6;

export function hasStem(foldedText: string, foldedTerm: string): boolean {
  if (foldedTerm.length < 4) return hasWord(foldedText, foldedTerm);
  let from = 0;
  for (;;) {
    const i = foldedText.indexOf(foldedTerm, from);
    if (i === -1) return false;
    from = i + 1;
    const before = i === 0 ? ' ' : foldedText[i - 1]!;
    if (/[\p{L}\p{N}]/u.test(before)) continue;
    const rest = foldedText.slice(i + foldedTerm.length);
    const tail = /^[\p{L}]*/u.exec(rest)?.[0] ?? '';
    if (tail.length <= MAX_SUFFIX) return true;
  }
}
