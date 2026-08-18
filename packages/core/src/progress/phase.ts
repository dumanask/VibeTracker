import { fold, foldWords, hasWord } from './fold.ts';
import { lexicon, type FoldedLexicon } from './lexicon.ts';
import { statusOfCell, statusOfWords, type StatusKind, type SymbolMap } from './marks.ts';

/**
 * Finding the phase ladder.
 *
 * A "phase" is whatever the project calls its unit of progress — `Faz 3`,
 * `Aşama 1`, `Stage 5`, `Sprint 2`, `M9`, `Slice A`. The label is preserved
 * verbatim because it is the user's own word for their own work; only the
 * ordinal is normalized, so different vocabularies can still be compared.
 *
 * The hard part is not finding phase tokens. It is refusing the ones that are
 * not declarations.
 */

export type PhaseKind =
  | 'scaffold'
  | 'design'
  | 'build'
  | 'integrate'
  | 'harden'
  | 'test'
  | 'release'
  | 'maintain'
  | 'paused'
  | 'unknown';

export interface PhaseRef {
  /** The project's own word, exactly as written: "Faz 3", "Stage 5". */
  labelRaw: string;
  /** Normalized noun, folded: "faz", "stage", "m", "v". */
  unit: string;
  /** Numeric position; letters map A=1, B=2 so `Slice C` sorts after `Slice B`. */
  ordinal: number;
  status?: StatusKind;
  /** Where we saw it, for provenance. */
  line: number;
}

/**
 * A phase noun followed by a number. `M9` and `v1.2` are handled separately
 * because they have no noun.
 *
 * `adim`/`etap` ("step") were in this list and had to come out: they are
 * overwhelmingly procedure steps -- "Adim 1: paketi kur" -- not project
 * phases, and on two real projects they outvoted the genuine ladder and
 * produced a confident "Adim 0 / 8". A word that means "next instruction"
 * cannot also mean "where the project is".
 */
const PHASE_TOKEN =
  /\b(faz|asama|aşama|phase|stage|sprint|slice|dilim|milestone|iter|inc)[\s_\-.]*([0-9]{1,2}(?:\.[0-9]{1,2})?|[A-Ea-e])\b/giu;
const BARE_MILESTONE = /\bM([0-9]{1,2})\b/g;
const VERSION_TOKEN = /\bv([0-9]+(?:\.[0-9]+)*)\b/gi;

/**
 * Turkish attaches case endings with an apostrophe: `Faz 0'a`, `Aşama 1'in`,
 * `Stage 2'nin`. Every one of those is a sentence *about* a phase, not a
 * heading that declares one — "the boundaries of Stage 1", "removed from
 * Stage 1", "will be deleted in Stage 2".
 *
 * Measured on the reference corpus: 15 of 248 phase tokens in headings are
 * inflected this way. Without this rule each one invents a phantom phase, and
 * the phantoms land at the *start* of the ladder (Faz 0, Aşama 1), which is
 * exactly where they do the most damage to "which phase is this project in".
 */
const INFLECTED = /^['’]\p{L}/u;

function ordinalOf(raw: string): number {
  if (/^[A-Ea-e]$/.test(raw)) return raw.toUpperCase().charCodeAt(0) - 64;
  return Number.parseFloat(raw);
}

/**
 * Phase tokens declared in one line of text.
 * `declarationsOnly` drops inflected references; pass false to find mentions.
 */
export function phaseTokens(line: string, declarationsOnly = true): PhaseRef[] {
  const out: PhaseRef[] = [];
  const push = (labelRaw: string, unit: string, ordinal: number, end: number): void => {
    if (declarationsOnly && INFLECTED.test(line.slice(end, end + 3))) return;
    if (!Number.isFinite(ordinal)) return;
    out.push({ labelRaw, unit, ordinal, line: 0 });
  };

  for (const m of line.matchAll(PHASE_TOKEN)) {
    push(m[0], fold(m[1]!), ordinalOf(m[2]!), (m.index ?? 0) + m[0].length);
  }
  for (const m of line.matchAll(BARE_MILESTONE)) {
    push(m[0], 'm', Number(m[1]), (m.index ?? 0) + m[0].length);
  }
  for (const m of line.matchAll(VERSION_TOKEN)) {
    push(m[0], 'v', Number.parseFloat(m[1]!), (m.index ?? 0) + m[0].length);
  }
  return out;
}

export interface StatusLine {
  /** The whole line, for display. */
  raw: string;
  /** Date the author stamped on it, ms since epoch, when present. */
  declaredAt?: number;
  /** Phases named in the line, with whatever status the line asserts. */
  phases: PhaseRef[];
  /** Text after a "Kalan:" / "Remaining:" marker — the honest next action. */
  remaining?: string;
  line: number;
}

const STATUS_LINE =
  /^[ \t]*>?[ \t]*\*{0,2}(durum|status|state|ilerleme|progress)\*{0,2}[ \t]*(\(([^)]*)\))?[ \t]*:[ \t]*(.*)$/i;
const DATE_IN = /(\d{4})-(\d{2})-(\d{2})/;
const REMAINING =
  /\b(kalan|kalanlar|remaining|next|sonraki|siradaki|sıradaki|todo)\b[ \t]*:?[ \t]*(.+)/i;

/**
 * Explicit status lines.
 *
 * These turned out to be the single richest signal in the corpus: 42 of them,
 * and a typical one carries a date, a phase ladder, completion verbs and the
 * remaining work in one sentence:
 * `> **Durum (2026-08-17):** Faz 0 ve Faz 1 tamamlandı, npx tsc 0 hata.`
 *
 * One regex answers "which phase", "as of when" and "what is left".
 */
export function readStatusLines(text: string, lx: FoldedLexicon = lexicon()): StatusLine[] {
  const out: StatusLine[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = STATUS_LINE.exec(lines[i] ?? '');
    if (!m) continue;
    const body = m[4] ?? '';
    const dateSrc = `${m[3] ?? ''} ${body}`;
    const d = DATE_IN.exec(dateSrc);

    const rem = REMAINING.exec(body);
    out.push({
      raw: (lines[i] ?? '').trim(),
      declaredAt: d ? Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : undefined,
      phases: expandRanges(body, lx),
      remaining: rem?.[2]?.trim(),
      line: i + 1,
    });
  }
  return out;
}

/**
 * `Faz 1-5 tamamlandı` names five phases, not two. Ranges are written with
 * every dash character in Unicode depending on the editor, so all of them are
 * accepted.
 */
function expandRanges(body: string, lx: FoldedLexicon): PhaseRef[] {
  const status = statusOfWords(body, lx) ?? impliedByVerb(body, lx);
  const refs = phaseTokens(body);
  const out: PhaseRef[] = [];

  const rangeRe =
    /\b(faz|asama|aşama|phase|stage|sprint|dilim|m)[\s_\-.]*([0-9]{1,2})[\s]*[–—−-][\s]*([0-9]{1,2})\b/giu;
  const covered = new Set<string>();
  for (const m of body.matchAll(rangeRe)) {
    const unit = fold(m[1]!);
    const from = Number(m[2]);
    const to = Number(m[3]);
    if (!(to > from) || to - from > 20) continue;
    for (let n = from; n <= to; n++) {
      out.push({ labelRaw: `${m[1]} ${n}`, unit, ordinal: n, status: status ?? undefined, line: 0 });
      covered.add(`${unit}:${n}`);
    }
  }
  for (const r of refs) {
    if (covered.has(`${r.unit}:${r.ordinal}`)) continue;
    out.push({ ...r, status: status ?? undefined });
  }
  return out;
}

function impliedByVerb(text: string, lx: FoldedLexicon): StatusKind | null {
  const folded = foldWords(text);
  for (const v of lx.completionVerbs) if (hasWord(folded, v)) return 'done';
  return null;
}

export interface HeadingPhase extends PhaseRef {
  headingText: string;
  depth: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
/** A leading section number is scaffolding, not part of the phase label. */
const SECTION_NUMBER = /^\s*(?:§?\s*[A-Z]?\d+(?:\.\d+)*\.?)\s+/;

/**
 * Phases declared by headings.
 *
 * Real headings carry their own status: `## Faz 3 — Yükleme ✅ **UYGULANDI**`.
 * They also sometimes declare two at once (`## Faz 4 + Faz 5 ✅`) and sometimes
 * nest (`### §H98 — Stage 5 Faz 0: lisans kapısı`), which is why this returns
 * every token in the heading rather than the first.
 */
export function headingPhases(
  text: string,
  symbols: SymbolMap,
  lx: FoldedLexicon = lexicon(),
): HeadingPhase[] {
  const out: HeadingPhase[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i] ?? '');
    if (!h) continue;
    const headingText = h[2]!.trim();
    const body = headingText.replace(SECTION_NUMBER, '');
    const status = statusOfCell(body, symbols, lx);
    for (const t of phaseTokens(body)) {
      out.push({ ...t, status: status ?? undefined, headingText, depth: h[1]!.length, line: i + 1 });
    }
  }
  return out;
}

export interface Ladder {
  unit: string;
  entries: Array<{ labelRaw: string; ordinal: number; status: StatusKind }>;
  /** Highest ordinal seen — the ladder's length as the project defines it. */
  total: number;
  /** Highest ordinal marked done, counting only a contiguous run from the start. */
  doneThrough: number | null;
}

/**
 * Collapse many mentions of the same phase into one ladder.
 *
 * A document typically names `Aşama 1` in a dozen subsections. Those are one
 * phase, not twelve, so entries are merged by (unit, ordinal) and the most
 * advanced status wins — a phase mentioned once as done and once with no mark
 * is done.
 */
const STATUS_RANK: Record<StatusKind, number> = {
  todo: 0,
  blocked: 1,
  partial: 2,
  done: 3,
  dropped: 4,
};

export function buildLadder(refs: PhaseRef[]): Ladder[] {
  const byUnit = new Map<string, Map<number, { labelRaw: string; status: StatusKind }>>();
  for (const r of refs) {
    // `Asama 4.3` is a section number that happens to follow a phase noun.
    // Ladders are made of whole rungs.
    if (!Number.isInteger(r.ordinal)) continue;
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, new Map());
    const m = byUnit.get(r.unit)!;
    const prev = m.get(r.ordinal);
    const status = r.status ?? 'todo';
    if (!prev || STATUS_RANK[status] > STATUS_RANK[prev.status]) {
      m.set(r.ordinal, { labelRaw: r.labelRaw, status });
    }
  }

  const out: Ladder[] = [];
  for (const [unit, m] of byUnit) {
    const entries = [...m.entries()]
      .map(([ordinal, v]) => ({ ordinal, ...v }))
      .sort((a, b) => a.ordinal - b.ordinal);
    if (entries.length === 0) continue;
    let doneThrough: number | null = null;
    for (const e of entries) {
      // Only a contiguous prefix counts: phase 5 being done while 3 is not
      // means the ladder is at 2, not at 5.
      if (e.status === 'done' || e.status === 'dropped') doneThrough = e.ordinal;
      else break;
    }
    out.push({ unit, entries, total: entries[entries.length - 1]!.ordinal, doneThrough });
  }
  // The ladder with the most rungs is the project's real spine; `v1.2` style
  // version tokens usually produce a one-entry ladder and should not win.
  return out.sort((a, b) => b.entries.length - a.entries.length);
}

/** Map a free-text phase label onto a normalized kind, for cross-project views. */
const KIND_WORDS: Array<[PhaseKind, RegExp]> = [
  ['scaffold', /(iskelet|kurulum|setup|scaffold|bootstrap|baslangic|başlangıç|hazirlik|hazırlık)/i],
  ['design', /(tasarim|tasarım|mimari|design|architecture|spec|sozlesme|sözleşme)/i],
  ['integrate', /(entegrasyon|integrat|birlestir|birleştir|baglant|bağlant)/i],
  [
    'harden',
    /(sertlestir|sertleştir|harden|guvenlik|güvenlik|performans|optimiz|iyilestir|iyileştir)/i,
  ],
  ['test', /(test|dogrulama|doğrulama|kabul|qa|verify)/i],
  ['release', /(yayin|yayın|release|surum|sürüm|deploy|dagitim|dağıtım|launch)/i],
  ['maintain', /(bakim|bakım|maintain|destek|support)/i],
  ['build', /(gelistir|geliştir|build|uygulama|implement|kod|feature|ozellik|özellik)/i],
];

export function classifyPhaseKind(label: string): PhaseKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(label)) return kind;
  return 'unknown';
}
