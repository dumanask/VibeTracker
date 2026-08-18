import { classifyRole, type DocRole, type RoleVerdict } from './role.ts';
import { extractItems, type WorkItem } from './extract.ts';
import { learnLegend, type SymbolMap } from './marks.ts';
import {
  buildLadder,
  classifyPhaseKind,
  headingPhases,
  readStatusLines,
  type Ladder,
  type PhaseKind,
  type StatusLine,
} from './phase.ts';
import { computePercent, type PercentResult } from './percent.ts';
import { lexicon, type FoldedLexicon } from './lexicon.ts';

/**
 * One document, read end to end.
 *
 * The order here is the design: classify the document *before* believing any of
 * its marks, and let the classifier see the mark census so structural evidence
 * ("everything is ticked", "the ticks are all in comparison tables") can
 * override a promising filename.
 */

export interface DocumentReading {
  fileName: string;
  role: DocRole;
  roleConfidence: number;
  roleReasons: string[];
  countable: boolean;
  items: WorkItem[];
  percent: PercentResult;
  ladders: Ladder[];
  statusLines: StatusLine[];
  /** Newest date the document stamps on itself, ms since epoch. */
  declaredAt?: number;
  /** Verbatim "what is left" text, when the author wrote one. */
  remaining?: string;
  phaseKind: PhaseKind;
  /** Symbols this document redefined for itself. */
  learnedSymbols: string[];
  /**
   * When a project nests its units — `### Stage 5 Faz 1` — the outer unit is
   * the one that answers "which phase is this project in". Detected from
   * headings that name two different units, where the first is the outer.
   */
  hierarchy?: { outer: string; inner: string };
}

export function analyzeDocument(
  fileName: string,
  text: string,
  lx: FoldedLexicon = lexicon(),
  /** Directory relative to the project root — `plans/Docs` is itself a signal. */
  dirHint?: string,
): DocumentReading {
  const symbols: SymbolMap = learnLegend(text, lx);
  const learnedSymbols = diffFromDefault(symbols);

  const extracted = extractItems(text, symbols, lx);

  const marks = countByStatus(extracted.items);
  const role: RoleVerdict = classifyRole(
    {
      fileName,
      dirHint,
      text,
      marks,
      ticksTotal: extracted.ticksTotal,
      ticksOutsideStatusColumn: extracted.ticksOutsideStatusColumn,
      tablesWithStatusColumn: extracted.tablesWithStatusColumn,
    },
    lx,
  );

  const statusLines = readStatusLines(text, lx);
  const headings = headingPhases(text, symbols, lx);

  // A status line is an assertion by the author and outranks a heading mark,
  // so it goes in last and wins the merge in `buildLadder`.
  const ladders = buildLadder([...headings, ...statusLines.flatMap((s) => s.phases)]);

  const dated = statusLines.filter((s) => s.declaredAt !== undefined);
  const newest = dated.length
    ? dated.reduce((a, b) => (a.declaredAt! > b.declaredAt! ? a : b))
    : undefined;

  const hierarchy = detectHierarchy(headings);

  const percent = computePercent({
    items: extracted.items,
    countable: role.countable,
    roleLabel: role.role,
  });

  return {
    fileName,
    role: role.role,
    roleConfidence: role.confidence,
    roleReasons: role.reasons,
    countable: role.countable,
    items: extracted.items,
    percent,
    ladders,
    statusLines,
    declaredAt: newest?.declaredAt,
    remaining: statusLines.find((s) => s.remaining)?.remaining,
    hierarchy,
    phaseKind: classifyPhaseKind(
      ladders[0]?.entries.map((e) => e.labelRaw).join(' ') ?? fileName,
    ),
    learnedSymbols,
  };
}

/**
 * Two different units in one heading means the project nests them, and the
 * left-hand one is the outer. Requires two independent headings to agree, so a
 * single stray `Stage 2 sprint 3` mention does not invent a hierarchy.
 */
function detectHierarchy(
  headings: Array<{ unit: string; line: number }>,
): { outer: string; inner: string } | undefined {
  const byLine = new Map<number, string[]>();
  for (const h of headings) {
    const list = byLine.get(h.line) ?? [];
    if (!list.includes(h.unit)) list.push(h.unit);
    byLine.set(h.line, list);
  }
  const pairs = new Map<string, number>();
  for (const units of byLine.values()) {
    if (units.length < 2) continue;
    pairs.set(`${units[0]}>${units[1]}`, (pairs.get(`${units[0]}>${units[1]}`) ?? 0) + 1);
  }
  for (const [key, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
    if (n < 2) break;
    const [outer, inner] = key.split('>');
    return { outer: outer!, inner: inner! };
  }
  return undefined;
}

function countByStatus(items: WorkItem[]): {
  done: number;
  partial: number;
  todo: number;
  blocked: number;
} {
  const c = { done: 0, partial: 0, todo: 0, blocked: 0 };
  for (const it of items) {
    if (it.status in c) c[it.status as keyof typeof c]++;
  }
  return c;
}

/** Which symbols this document redefined, for the provenance trail. */
function diffFromDefault(symbols: SymbolMap): string[] {
  const base = learnLegend('', lexicon());
  const out: string[] = [];
  for (const [sym, kind] of symbols) {
    if (base.get(sym) !== kind) out.push(`${sym}=${kind}`);
  }
  return out;
}
