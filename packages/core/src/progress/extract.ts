import { foldWords, hasWord } from './fold.ts';
import { lexicon, type FoldedLexicon } from './lexicon.ts';
import {
  isStruckOut,
  readEffortWeight,
  statusOfCell,
  type StatusKind,
  type SymbolMap,
} from './marks.ts';

/**
 * Pulling countable work items out of a markdown document.
 *
 * Three extractors, in descending trust. Each records where it found the item
 * so the dashboard can link back to the line — a percentage nobody can audit
 * is a percentage nobody should believe.
 */

export interface WorkItem {
  text: string;
  status: StatusKind;
  weight: number;
  line: number;
  extractor: 'checkbox' | 'table' | 'heading';
}

export interface ExtractResult {
  items: WorkItem[];
  /** Census used by the role classifier — see `role.ts` for why it matters. */
  ticksTotal: number;
  ticksOutsideStatusColumn: number;
  tables: number;
  tablesWithStatusColumn: number;
}

const CHECKBOX = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|?\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * A column counts as a status column only if its header *is* a status word.
 *
 * This one predicate is what separates a progress tracker from a lie. Measured
 * across 996 tables in the reference corpus: 992 checkmarks live inside tables,
 * and only 192 of them sit in a status column. The other 800 are competitor
 * matrices, file inventories and audit findings. Counting a table without
 * checking its header turns a market analysis into a 100%-complete project.
 */
function statusColumnIndex(headers: string[], lx: FoldedLexicon): number {
  return headers.findIndex((h) => {
    const f = foldWords(h);
    if (!f) return false;
    return lx.statusLineKeys.some((k) => f === k || hasWord(f, k));
  });
}

function effortColumnIndex(headers: string[]): number {
  return headers.findIndex((h) => /^(efor|effort|boyut|size|agirlik|ağırlık|puan)$/i.test(h.trim()));
}

function splitRow(line: string): string[] {
  const m = TABLE_ROW.exec(line);
  if (!m) return [];
  return m[1]!.split('|').map((c) => c.trim());
}

export function extractItems(
  text: string,
  symbols: SymbolMap,
  lx: FoldedLexicon = lexicon(),
): ExtractResult {
  const lines = text.split('\n');
  const items: WorkItem[] = [];
  let ticksTotal = 0;
  let ticksOutside = 0;
  let tables = 0;
  let tablesWithStatus = 0;

  // Count every tick in the document, so the role classifier can compare where
  // they live against how many there are.
  for (const line of lines) ticksTotal += countTicks(line, symbols);

  // ── E1: GFM checkboxes ──────────────────────────────────────────────────
  // Nested items are the countable unit: a parent with children is a grouping,
  // and counting both double-counts the same work.
  const checkboxIndents: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX.exec(lines[i] ?? '');
    checkboxIndents[i] = m ? m[1]!.replace(/\t/g, '  ').length : -1;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX.exec(lines[i] ?? '');
    if (!m) continue;
    const indent = checkboxIndents[i]!;
    const hasChildren = (checkboxIndents[i + 1] ?? -1) > indent;
    if (hasChildren) continue;

    const body = m[3]!;
    if (isStruckOut(body)) continue;
    const checked = m[2] !== ' ';
    // An explicit mark inside the text overrides the box: `- [x] ... ◐ kısmi`.
    const inner = statusOfCell(body, symbols, lx);
    const status: StatusKind = inner ?? (checked ? 'done' : 'todo');
    items.push({ text: body.trim().slice(0, 200), status, weight: 1, line: i + 1, extractor: 'checkbox' });
  }

  // ── E2: table status columns ────────────────────────────────────────────
  for (let i = 0; i < lines.length - 1; i++) {
    if (!TABLE_ROW.test(lines[i] ?? '') || !TABLE_SEP.test(lines[i + 1] ?? '')) continue;
    tables++;
    const headers = splitRow(lines[i] ?? '');
    const sIdx = statusColumnIndex(headers, lx);
    const eIdx = effortColumnIndex(headers);
    if (sIdx >= 0) tablesWithStatus++;

    let j = i + 2;
    for (; j < lines.length && TABLE_ROW.test(lines[j] ?? ''); j++) {
      const cells = splitRow(lines[j] ?? '');
      cells.forEach((c, idx) => {
        if (idx === sIdx) return;
        ticksOutside += countTicks(c, symbols);
      });
      if (sIdx < 0) continue;

      const status = statusOfCell(cells[sIdx] ?? '', symbols, lx);
      if (!status) continue;
      // The first non-status cell is the item's name; falling back to the
      // status cell would label every row "done".
      const label = cells.find((c, idx) => idx !== sIdx && c.length > 0) ?? '';
      items.push({
        text: label.replace(/[*`]/g, '').trim().slice(0, 200),
        status,
        weight: (eIdx >= 0 ? readEffortWeight(cells[eIdx] ?? '') : null) ?? 1,
        line: j + 1,
        extractor: 'table',
      });
    }
    i = j - 1;
  }

  // ── E3: heading status suffixes ─────────────────────────────────────────
  // Only used for sections that contain no E1/E2 item of their own, otherwise
  // the section heading and its contents would both be counted.
  const covered = new Set(items.map((it) => it.line));
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i] ?? '');
    if (!h) continue;
    const status = statusOfCell(h[2]!, symbols, lx);
    if (!status) continue;
    const end = nextHeadingIndex(lines, i, h[1]!.length);
    let sectionHasItems = false;
    for (const it of items) {
      if (it.line > i + 1 && it.line <= end) {
        sectionHasItems = true;
        break;
      }
    }
    if (sectionHasItems || covered.has(i + 1)) continue;
    items.push({
      text: h[2]!.replace(/[*`]/g, '').trim().slice(0, 200),
      status,
      weight: 1,
      line: i + 1,
      extractor: 'heading',
    });
  }

  return {
    items,
    ticksTotal,
    ticksOutsideStatusColumn: ticksOutside,
    tables,
    tablesWithStatusColumn: tablesWithStatus,
  };
}

function nextHeadingIndex(lines: string[], from: number, depth: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i] ?? '');
    if (h && h[1]!.length <= depth) return i;
  }
  return lines.length;
}

function countTicks(line: string, symbols: SymbolMap): number {
  let n = 0;
  for (const [sym, kind] of symbols) {
    if (kind !== 'done') continue;
    n += line.split(sym).length - 1;
  }
  return n;
}
