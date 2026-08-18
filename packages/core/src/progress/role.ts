import { fold, foldWords, hasStem } from './fold.ts';
import { lexicon, type FoldedLexicon } from './lexicon.ts';

/**
 * What kind of document is this?
 *
 * This classifier is the whole reason the progress engine can be trusted, and
 * it exists because of two failures measured on real repositories:
 *
 * 1. A file with 100 checked items and 0 unchecked ones is not a project that
 *    is finished. It is a "what we did today" log, and counting it reports
 *    100%.
 * 2. Of 992 checkmarks found inside tables in this corpus, **800 were not in a
 *    status column**. They were competitor comparison matrices, file
 *    inventories and audit findings — `pazar-ve-firsatlar.md` alone holds 272.
 *    Counting those reports a market research document as a nearly finished
 *    project.
 *
 * So: classify the document, then decide whether its marks may enter a
 * denominator at all. Getting this wrong does not produce a slightly wrong
 * percentage, it produces a confidently wrong one.
 */

export type DocRole =
  | 'PLAN'
  | 'STATUS'
  | 'CHANGELOG'
  | 'RESEARCH'
  | 'DESIGN'
  | 'INDEX'
  | 'AMBIGUOUS';

export interface RoleVerdict {
  role: DocRole;
  confidence: number;
  /** Human-readable, shown in the UI. Never invented — each maps to a signal. */
  reasons: string[];
  /** May this document's marks contribute to a percentage? */
  countable: boolean;
}

export interface RoleInput {
  /** File name only, not the full path. */
  fileName: string;
  /** Directory the file sits in, relative to the project root. Optional. */
  dirHint?: string;
  text: string;
  /** Counts already extracted, when available — improves the structural rules. */
  marks?: { done: number; partial: number; todo: number; blocked: number };
  /** Ticks that sit inside tables but outside any status column. */
  ticksOutsideStatusColumn?: number;
  ticksTotal?: number;
  /** How many of the document's tables actually have a status column. */
  tablesWithStatusColumn?: number;
}

/**
 * How much a name is worth as evidence.
 *
 * Not all role words are equally informative. In the reference corpus 98 of
 * 182 files have "plan" somewhere in the name — it is the default, and it
 * means almost nothing. Calling a file `rakip-analizi` or `plan-arsivi` is a
 * deliberate act of description, and those words have to be able to outvote
 * the generic one, or every archive of plans reads as a plan.
 */
const ROLE_WEIGHT: Record<string, number> = {
  research: 4,
  changelog: 4,
  status: 3,
  design: 2,
  plan: 2,
  index: 1,
};

const DATE_HEADING = /^#{1,6}\s.*\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/gm;

/**
 * `**Durum:** PLAN — kod yazılmadı` / `**Durum:** RAPOR — ...`
 * The document telling you what it is beats every heuristic we could invent.
 *
 * Note the `i`. Every regex in this engine that touches author-written prose
 * needs it, and forgetting it fails *silently* — the pattern simply never
 * matches, so the signal disappears rather than misfiring. That cost three
 * separate bugs here: capitalised phase headings, Turkish legend headers, and
 * this line. Where case-insensitivity is not enough (any comparison involving
 * İ/ı), fold first and match against the folded text.
 */
const SELF_DECLARE =
  /^[ \t]*>?[ \t]*\*{0,2}(durum|status)\*{0,2}[ \t]*(?:\([^)]*\))?[ \t]*:?\*{0,2}[ \t]*(.{0,60})/im;

export function classifyRole(input: RoleInput, lx: FoldedLexicon = lexicon()): RoleVerdict {
  const scores: Record<DocRole, number> = {
    PLAN: 0,
    STATUS: 0,
    CHANGELOG: 0,
    RESEARCH: 0,
    DESIGN: 0,
    INDEX: 0,
    AMBIGUOUS: 0,
  };
  const reasons: string[] = [];

  const add = (role: string, points: number, why: string): void => {
    const key = role.toUpperCase() as DocRole;
    if (key in scores) {
      scores[key] += points;
      reasons.push(why);
    }
  };

  // ── 1. the document's own declaration ──────────────────────────────────
  // Real declarations are not always the first word: `**Durum:** AKTİF plan`
  // and `**Durum:** 📋 plan (kod YOK)` both declare a plan, just not in the
  // first token. Scan the opening clause rather than a single word.
  const declared = SELF_DECLARE.exec(input.text);
  if (declared) {
    const opening = foldWords(declared[2] ?? '');
    for (const { role, term } of lx.selfDeclaredRoles) {
      if (hasStem(opening, term)) {
        add(role, 6, `kendi beyanı: "${term}"`);
        break;
      }
    }
  }

  // ── 2. name, title and directory ───────────────────────────────────────
  // Every matching term scores, not just the first: a file called
  // `plan-arsivi` carries evidence for two roles and the stronger word should
  // win rather than whichever happened to be checked first.
  scoreNames(
    foldWords(input.fileName.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ')),
    1.0,
    'dosya adı',
    lx,
    add,
  );
  const h1 = /^#\s+(.+)$/m.exec(input.text)?.[1] ?? '';
  if (h1) scoreNames(foldWords(h1), 0.7, 'başlık', lx, add);
  if (input.dirHint) scoreNames(foldWords(input.dirHint), 0.5, 'klasör', lx, add);

  // ── 3. structural: everything is finished ──────────────────────────────
  const m = input.marks;
  if (m) {
    const total = m.done + m.partial + m.todo + m.blocked;
    if (total >= 10 && m.done / total >= 0.95) {
      add('changelog', 5, `${m.done}/${total} işaretli, bitmemiş madde yok — ilerleme değil kayıt`);
    }
  }

  // ── 4. structural: marks live outside status columns ───────────────────
  // Narrow on purpose. A plan that *also* contains reference tables is still a
  // plan — and the table extractor already ignores everything outside a status
  // column, so those ticks were never going to be counted. The signal only
  // means something when the document has no status column anywhere: then
  // there is nothing to extract properly and the marks are all decorative.
  const outside = input.ticksOutsideStatusColumn ?? 0;
  const totalTicks = input.ticksTotal ?? 0;
  const statusCols = input.tablesWithStatusColumn ?? 0;
  if (statusCols === 0 && totalTicks >= 15 && outside / totalTicks > 0.6) {
    add(
      'research',
      4,
      `${outside}/${totalTicks} ✅ tablolarda ama hiç durum sütunu yok — karşılaştırma/envanter`,
    );
  }

  // ── 5. structural: dated section headings ──────────────────────────────
  const dated = [...input.text.matchAll(DATE_HEADING)].length;
  if (dated >= 3) add('changelog', 3, `${dated} tarihli başlık — günlük`);

  const ranked = (Object.entries(scores) as Array<[DocRole, number]>)
    .filter(([r]) => r !== 'AMBIGUOUS')
    .sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;

  if (topScore === 0) {
    return { role: 'AMBIGUOUS', confidence: 0.3, reasons: ['rol belirlenemedi'], countable: false };
  }

  // A tie is not a decision. Better to say "unsure" than to pick.
  const margin = topScore - runnerUp;
  const role: DocRole = margin === 0 ? 'AMBIGUOUS' : top;
  const confidence = Math.min(0.95, 0.4 + topScore * 0.06 + margin * 0.05);

  return { role, confidence, reasons, countable: isCountable(role) };
}

/** Score every role term present in a name, at most once per role. */
function scoreNames(
  folded: string,
  factor: number,
  label: string,
  lx: FoldedLexicon,
  add: (role: string, points: number, why: string) => void,
): void {
  if (!folded) return;
  const seen = new Set<string>();
  for (const { role, term } of lx.roles) {
    if (seen.has(role)) continue;
    const hit = term.includes(' ') ? folded.includes(term) : hasStem(folded, term);
    if (!hit) continue;
    seen.add(role);
    add(role, (ROLE_WEIGHT[role] ?? 2) * factor, `${label}: "${term}"`);
  }
}

/**
 * Only PLAN documents contribute to a percentage.
 *
 * STATUS documents are mined for the current phase and the next action but
 * never counted — they describe a moment, not a scope. CHANGELOG and RESEARCH
 * are excluded outright: those are the two traps. DESIGN and INDEX describe
 * how something works or where things are, and have no notion of done.
 */
export function isCountable(role: DocRole): boolean {
  return role === 'PLAN';
}
