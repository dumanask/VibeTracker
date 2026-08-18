import { fold, foldWords, hasWord } from './fold.ts';
import { lexicon, type FoldedLexicon, type StatusKind } from './lexicon.ts';

/**
 * Status marks: symbols and words that say how far along an item is.
 *
 * Measured across 182 real plan documents on the reference machine, symbols
 * outnumber GFM checkboxes by two orders of magnitude — 1424 ✅ against 81
 * `- [ ]` items in total. Any parser built on checkboxes alone would read this
 * corpus as having no progress information at all. So symbols are the primary
 * vocabulary here and checkboxes are one extractor among several.
 */

export type { StatusKind };

/**
 * Default symbol meanings. Two omissions are deliberate and load-bearing:
 *
 * - `⚠️` appears 588 times in the corpus and is almost always a warning inside
 *   prose, not an item status. Counting it would add hundreds of phantom
 *   items.
 * - `❌` maps to `todo`, not `dropped`. "Not done" and "decided against" are
 *   different facts, and only one of them belongs in a denominator. Real
 *   abandonment is signalled by words, not by a cross.
 */
const DEFAULT_SYMBOLS: Array<[string, StatusKind]> = [
  ['✅', 'done'],
  ['✔️', 'done'],
  ['✔', 'done'],
  ['☑️', 'done'],
  ['☑', 'done'],
  ['🟢', 'done'],
  ['✓', 'done'],
  ['◐', 'partial'],
  ['🟡', 'partial'],
  ['🔶', 'partial'],
  ['⏳', 'partial'],
  ['🚧', 'partial'],
  ['⬜', 'todo'],
  ['⬛', 'todo'],
  ['☐', 'todo'],
  ['⚪', 'todo'],
  ['○', 'todo'],
  ['❌', 'todo'],
  ['✖️', 'todo'],
  ['✖', 'todo'],
  ['🔴', 'blocked'],
  ['⛔', 'blocked'],
  ['🚫', 'blocked'],
];

export type SymbolMap = Map<string, StatusKind>;

export function defaultSymbols(): SymbolMap {
  return new Map(DEFAULT_SYMBOLS);
}

/** Every symbol we might ever treat as a status, for cheap pre-scanning. */
export const ALL_SYMBOLS: string[] = DEFAULT_SYMBOLS.map(([s]) => s);

/**
 * Learn a document's own legend.
 *
 * Plan documents in the wild routinely define their own key — "◐ = kısmen",
 * "🟡 devam ediyor" — and those definitions override ours for that file. This
 * is the cheapest possible form of per-project dialect learning: no model, no
 * configuration, no guessing, just reading the table of contents the author
 * already wrote.
 *
 * Only lines in a legend-ish neighbourhood are considered, because `✅ Faz 3
 * tamamlandı` is a status line, not a legend entry, and treating it as one
 * would redefine ✅ to mean whatever that sentence said.
 */
/**
 * Matched against the *folded* line, never the raw one. `/işaretler/i` does
 * not match `İşaretler`: the dotted capital lowercases to `i` plus a combining
 * dot, so simple case-insensitive matching misses every Turkish heading that
 * starts with it. This is the same trap `fold()` exists to close, and using a
 * raw regex here quietly reintroduced it.
 */
const LEGEND_HEADER =
  /(isaretler|semboller|gosterge|legend|key|durum rozetleri|aciklama|notasyon)/;

export function learnLegend(text: string, lx: FoldedLexicon = lexicon()): SymbolMap {
  const symbols = defaultSymbols();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!LEGEND_HEADER.test(foldWords(lines[i] ?? ''))) continue;
    // A legend is a short block; scan a bounded window after the header.
    for (let j = i; j < Math.min(lines.length, i + 14); j++) {
      const line = lines[j] ?? '';
      // Stop at the next heading — the legend does not span sections.
      if (j > i && /^#{1,6}\s/.test(line)) break;
      for (const [sym, kind] of readLegendPairs(line, lx)) symbols.set(sym, kind);
    }
  }
  return symbols;
}

/** `✅ = tamamlandı`, `◐ : kısmi`, `| 🟡 | devam |` — symbol, separator, word. */
function readLegendPairs(line: string, lx: FoldedLexicon): Array<[string, StatusKind]> {
  const out: Array<[string, StatusKind]> = [];
  const re = /([^\s\p{L}\p{N}|]{1,3})\s*[=:|—–-]\s*([\p{L} ]{3,30})/gu;
  for (const m of line.matchAll(re)) {
    const sym = m[1]!.trim();
    if (!sym || /^[.,;'"`*_#>[\]()]+$/.test(sym)) continue;
    const kind = statusOfWords(m[2]!, lx);
    if (kind) out.push([sym, kind]);
  }
  return out;
}

/**
 * Which status a piece of free text asserts, or null when it asserts none.
 * Longest match wins so "kısmen tamam" is not read as "tamam".
 */
export function statusOfWords(text: string, lx: FoldedLexicon = lexicon()): StatusKind | null {
  const folded = foldWords(text);
  if (!folded) return null;
  for (const { kind, term } of lx.status) {
    if (term.includes(' ') ? folded.includes(term) : hasWord(folded, term)) return kind;
  }
  return null;
}

/** Which status a cell asserts, reading symbols first and then words. */
export function statusOfCell(
  cell: string,
  symbols: SymbolMap,
  lx: FoldedLexicon = lexicon(),
): StatusKind | null {
  for (const [sym, kind] of symbols) {
    if (cell.includes(sym)) return kind;
  }
  // GFM checkbox syntax can appear inside a table cell too.
  if (/\[[xX]\]/.test(cell)) return 'done';
  if (/\[ \]/.test(cell)) return 'todo';
  return statusOfWords(cell, lx);
}

/**
 * Strikethrough with a completion mark: `~~eski madde~~ ✅`.
 * Struck-through text is authored deletion, so it leaves the denominator.
 */
export function isStruckOut(line: string): boolean {
  return /~~[^~]{3,}~~/.test(line);
}

/** Percent literals, accepted in both orders — Turkish writes `%99`. */
export function readPercentLiteral(text: string): number | null {
  const m = /(?:%\s*(\d{1,3})|(\d{1,3})\s*%)/.exec(text);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Effort weights, when a plan bothers to size its items. */
export function readEffortWeight(cell: string): number | null {
  const t = fold(cell).trim();
  if (t === 's') return 1;
  if (t === 'm') return 3;
  if (t === 'l') return 8;
  if (t === 'xl') return 13;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}
