import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  agoPhrase,
  analyzeDocument,
  classifyPhaseKind,
  coarsen,
  type DocumentReading,
  type Ladder,
  MIN_DENOMINATOR,
  type PhaseKind,
  ph,
  type Phrase,
} from '@vibetracker/core';
import { phaseTokens } from '@vibetracker/core';
import type { GitFacts } from '@vibetracker/platform';

/**
 * Project-level progress.
 *
 * Reads a project's plan documents, decides which of them is describing the
 * project rather than one feature of it, and cross-checks the result against
 * git. The output is deliberately allowed to be "we do not know" — see
 * `percent.ts` for why a refused number beats an invented one.
 *
 * Nothing here is written back to the project. Ever.
 */

/** Directories worth reading. Anything else is source code, not planning. */
const DOC_DIRS = ['plans', 'plan', 'docs', 'doc', 'documentation', '.claude'];
const ROOT_DOCS = /^(readme|todo|roadmap|changelog|plan|durum|status)\b/i;

const SKIP_DIR =
  /^(node_modules|\.git|target|dist|build|out|coverage|\.next|\.venv|venv|__pycache__|\.pytest_cache|vendor|third_party)$/i;

/** A single document larger than this is not a plan, it is a data dump. */
const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** Bound the walk: a project with 400 markdown files gets the first 200. */
const MAX_DOCS = 200;
const MAX_DEPTH = 4;

/**
 * D4 fires above this many uncommitted, non-build files. Twenty is high
 * enough that ordinary work-in-progress does not trip it and low enough that
 * an abandoned phase does.
 */
const D4_DIRTY_MIN = 20;
/** D5's window. Three weeks of a frozen ratio is a pattern, not a pause. */
const D5_FROZEN_MS = 21 * 24 * 3600_000;

export interface ProgressSource {
  /** Path relative to the project root, forward-slashed. */
  relPath: string;
  role: string;
  roleConfidence: number;
  countable: boolean;
  itemCount: number;
  percent: number | null;
  suppressedReason?: Phrase;
  mtimeMs: number;
  declaredAt?: number;
  remaining?: string;
  reasons: string[];
}

export interface PhaseView {
  /** The project's own words, e.g. "Faz 3". */
  labelRaw: string;
  unit: string;
  ordinal: number;
  total: number;
  kind: PhaseKind;
  /** Position within the inner unit, when the project nests them. */
  sub?: string;
  /** `git` when the branch overruled the plan. */
  basis: 'plan' | 'status_line' | 'git' | 'none';
  confidence: number;
}

export type DriftCode =
  | 'D1_plan_vs_branch'
  | 'D2_plan_stale'
  | 'D3_status_stale'
  | 'D4_done_but_dirty'
  | 'D5_frozen_ratio'
  | 'D6_branch_phase_unknown';

export interface Drift {
  code: DriftCode;
  severity: 'high' | 'medium';
  /** Structured so the UI can translate and style the parts — see `phrase.ts`. */
  claim: Phrase;
  evidence: Phrase;
}

export interface ProgressReport {
  phase: PhaseView | null;
  percent: number | null;
  /** How the percentage was derived, or why there is none. */
  basis: 'items' | 'milestones' | 'none';
  percentSuppressed?: Phrase;
  /** Why no phase is named, when documents were read but none could speak. */
  phaseSuppressed?: Phrase;
  /** Coarse bucket + `~` prefix when the number is inferred rather than counted. */
  approximate: boolean;
  nextAction?: string;
  /** Newest self-declared date across all sources, ms since epoch. */
  observedAt?: number;
  sources: ProgressSource[];
  /**
   * How many documents were read and how many of them counted.
   *
   * Reported separately from `sources`, which is truncated for display: a
   * project with seventy plans showed "17 plan" beside a provenance line
   * saying "24 plan belgesi", because one number had been through the slice
   * and the other had not.
   */
  sourceCount: number;
  planCount: number;
  drift: Drift[];
  /** Where the number came from, as parts rather than as a sentence. */
  provenance?: Phrase;
  /**
   * The counted weights behind `percent`, so a caller can store them and hand
   * them back as `prior` on the next scan. Null when nothing was countable.
   */
  doneWeight: number | null;
  totalWeight: number | null;
}

interface DocFile {
  abs: string;
  rel: string;
  mtimeMs: number;
  size: number;
}

async function collectDocs(root: string): Promise<DocFile[]> {
  const out: DocFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_DOCS) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_DOCS) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name)) continue;
        // Below the root we only descend inside documentation directories, so
        // a monorepo's hundred package READMEs do not drown the real plans.
        if (depth === 0 && !DOC_DIRS.includes(e.name.toLowerCase())) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      if (depth === 0 && !ROOT_DOCS.test(e.name)) continue;
      try {
        const st = await stat(abs);
        if (st.size > MAX_DOC_BYTES || st.size === 0) continue;
        out.push({
          abs,
          rel: relative(root, abs).split(sep).join('/'),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        /* vanished mid-walk */
      }
    }
  }

  await walk(root, 0);
  return out;
}

/**
 * The last reading this project produced, when the caller kept one.
 *
 * D5 asks whether the numbers have moved, and a single scan cannot know that.
 * Rather than give the engine a database, the caller supplies what it
 * remembers: the daemon reads it from SQLite, and one-shot `vt status` passes
 * nothing — so D5 simply does not fire there, which is the honest outcome
 * rather than a guess.
 */
export interface PriorReading {
  /** When the earlier reading was computed. */
  at: number;
  doneWeight: number | null;
  totalWeight: number | null;
  /** Phase ordinal at that time, for the same comparison on ladders. */
  ordinal: number | null;
}

export interface ProgressOptions {
  git?: GitFacts | null;
  now?: number;
  /** Oldest reading still within the D5 window — see `PriorReading`. */
  prior?: PriorReading | null;
  /** Sessions seen in this project since `prior.at`. Feeds D5's second half. */
  activitySince?: number;
}

export async function readProjectProgress(
  root: string,
  opts: ProgressOptions = {},
): Promise<ProgressReport> {
  const now = opts.now ?? Date.now();
  const files = await collectDocs(root);

  const readings: Array<{ file: DocFile; doc: DocumentReading }> = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    const dirHint = f.rel.split('/').slice(0, -1).join('/');
    readings.push({
      file: f,
      doc: analyzeDocument(f.rel.split('/').pop()!, text, undefined, dirHint),
    });
  }

  const sources: ProgressSource[] = readings.map(({ file, doc }) => ({
    relPath: file.rel,
    role: doc.role,
    roleConfidence: doc.roleConfidence,
    countable: doc.countable,
    itemCount: doc.items.length,
    percent: doc.percent.percent,
    suppressedReason: doc.percent.suppressed?.detail,
    mtimeMs: file.mtimeMs,
    declaredAt: doc.declaredAt,
    remaining: doc.remaining,
    reasons: doc.roleReasons,
  }));

  // ── which ladder, if any, speaks for the project ───────────────────────
  const candidates = spineCandidates(readings);
  const { spine, rivalry } = pickSpine(candidates);

  // Every ladder in every document, for the drift detectors. D4 and D6 ask
  // "does any document claim this?", which is a different question from
  // "where is the project?" and needs no spine.
  const allLadders: Ladder[] = readings.flatMap((r) => r.doc.ladders);

  // ── git's opinion ───────────────────────────────────────────────────────
  const gitPhase = readGitPhase(opts.git);

  const drift: Drift[] = [];
  let phase: PhaseView | null = null;
  let phaseSuppressed: Phrase | undefined = rivalry;

  if (spine) {
    // The phase is the first rung not yet finished. `doneThrough` counts a
    // contiguous prefix only, so on a ladder whose 1 is open and whose 2 is
    // closed it says "we are at 1" — which is right — but it says nothing at
    // all when the run is broken, and the first open rung always does.
    const entry = spine.rungs.find((e) => e.status !== 'done')!;
    phase = {
      labelRaw: entry.labelRaw,
      unit: spine.ladder.unit,
      ordinal: entry.ordinal,
      total: spine.ladder.total,
      kind: classifyPhaseKind(entry.labelRaw),
      basis: 'plan',
      confidence: 0.75,
    };
    // A nested unit only counts when it is nested in *this* document. Taking
    // the hierarchy from whichever file happened to declare one meant a
    // project could be reported as `Stage 5 · faz 0/4` with the stage and the
    // faz coming from two unrelated plans.
    const h = spine.doc.hierarchy;
    if (h && h.outer === spine.ladder.unit) {
      const inner = spine.doc.ladders.find((l) => l.unit === h.inner);
      if (inner) phase.sub = `${h.inner} ${(inner.doneThrough ?? -1) + 1}/${inner.total}`;
    }
  }

  // D1: the branch and the plan disagree about which phase this is.
  if (gitPhase && phase && gitPhase.unit === phase.unit && gitPhase.ordinal !== phase.ordinal) {
    drift.push({
      code: 'D1_plan_vs_branch',
      severity: 'high',
      claim: ph('plan "{0}" diyor, dal "{1}" diyor', phase.labelRaw, gitPhase.labelRaw),
      evidence: ph('dal: {0}', opts.git?.branch ?? '?'),
    });
    // Evidence beats claim: git records what was actually done.
    phase = { ...gitPhase, total: Math.max(phase.total, gitPhase.ordinal), basis: 'git', confidence: 0.7 };
  } else if (!phase && gitPhase) {
    phase = gitPhase;
  }

  // ── the project's whole documented backlog ──────────────────────────────
  // Every countable plan, summed.
  //
  // The rule this replaces was "the most recently touched plan wins", and on
  // the reference machine that made a 72-document repository report the
  // 1-of-12 checklist of one sub-feature as the progress of the whole
  // project — and made the number change when any other file was opened. A
  // sum moves when work moves and holds still when you are only reading.
  //
  // Documents below the per-file denominator floor are included here on
  // purpose: that floor exists so a four-item checklist cannot *alone* speak
  // for a project, and summing twenty of them is exactly the case it was
  // guarding against, not an evasion of it.
  const counted = readings.filter((r) => r.doc.countable && r.doc.percent.totalWeight > 0);
  const aggDone = counted.reduce((n, r) => n + r.doc.percent.doneWeight, 0);
  const aggTotal = counted.reduce((n, r) => n + r.doc.percent.totalWeight, 0);
  const aggOpen = counted.reduce(
    (n, r) =>
      n + r.doc.percent.counts.todo + r.doc.percent.counts.partial + r.doc.percent.counts.blocked,
    0,
  );
  // Hoisted: D5 compares these against the previous scan, and the caller
  // stores them to hand back as `prior`.
  const countedDone = counted.length ? aggDone : null;
  const countedTotal = counted.length ? aggTotal : null;

  // D2: the newest plan predates the newest commit by a wide margin.
  const newestPlanMtime = Math.max(0, ...readings.filter((r) => r.doc.countable).map((r) => r.file.mtimeMs));
  const headAt = opts.git?.headAtMs ?? 0;
  if (newestPlanMtime > 0 && headAt > 0 && headAt - newestPlanMtime > 14 * 24 * 3600_000) {
    drift.push({
      code: 'D2_plan_stale',
      severity: 'medium',
      claim: ph('plan, son commit\'ten çok daha eski'),
      evidence: ph(
        'plan {0} gün önce, commit {1} gün önce',
        days(now - newestPlanMtime),
        days(now - headAt),
      ),
    });
  }

  // D3: the document stamped a date on itself and then was edited long after —
  // or was never touched again. Either way the self-declared status is stale.
  const declared = readings
    .map((r) => r.doc.declaredAt)
    .filter((d): d is number => typeof d === 'number');
  const newestDeclared = declared.length ? Math.max(...declared) : undefined;
  if (newestDeclared && now - newestDeclared > 21 * 24 * 3600_000) {
    drift.push({
      code: 'D3_status_stale',
      severity: 'medium',
      claim: ph('belgedeki "Durum" tarihi eskimiş'),
      evidence: ph('{0} gün önce yazılmış', days(now - newestDeclared)),
    });
  }

  // D4: the plan calls a phase finished while the directories that phase
  // names still hold uncommitted work. Build output is already excluded from
  // `dirtyPaths`, because `target/` churning is not unfinished work.
  const donePhases = allLadders
    .flatMap((l) => l.entries)
    .filter((e) => e.status === 'done')
    .map((e) => e.labelRaw);
  const dirty = opts.git?.dirtyPaths ?? [];
  if (donePhases.length > 0 && dirty.length > D4_DIRTY_MIN) {
    drift.push({
      code: 'D4_done_but_dirty',
      severity: 'medium',
      claim: ph('plan "{0}" tamamlandı diyor ama iş ağacı temiz değil', donePhases.at(-1)!),
      evidence: ph('{0} commitlenmemiş dosya (build çıktısı sayılmadı)', dirty.length),
    });
  }

  // D5: the counted ratio has not moved for weeks while work continued. A
  // frozen number with no activity is just a dormant project and says nothing;
  // a frozen number *with* commits means the plan stopped tracking reality.
  const prior = opts.prior;
  if (
    prior &&
    now - prior.at > D5_FROZEN_MS &&
    prior.doneWeight !== null &&
    countedDone !== null &&
    prior.doneWeight === countedDone &&
    prior.totalWeight === countedTotal &&
    (opts.activitySince ?? 0) > 0
  ) {
    drift.push({
      code: 'D5_frozen_ratio',
      severity: 'medium',
      claim: ph('plandaki sayı {0} gündür değişmedi ama çalışma sürüyor', days(now - prior.at)),
      evidence: ph(
        '{0}/{1} madde sabit · o tarihten beri {2} oturum',
        countedDone,
        countedTotal ?? 0,
        opts.activitySince ?? 0,
      ),
    });
  }

  // D6: the branch names a phase that appears in no plan. Either the plan is
  // missing a rung or the branch is named after something else entirely —
  // both are worth a look, and neither is worth overruling the plan for.
  if (gitPhase && allLadders.length > 0) {
    const known = allLadders.some(
      (l) => l.unit === gitPhase.unit && l.entries.some((e) => e.ordinal === gitPhase.ordinal),
    );
    if (!known) {
      drift.push({
        code: 'D6_branch_phase_unknown',
        severity: 'medium',
        claim: ph('dal "{0}" diyor, hiçbir planda böyle bir basamak yok', gitPhase.labelRaw),
        evidence: ph('dal: {0}', opts.git?.branch ?? '?'),
      });
    }
  }

  // ── the number, or the reason there is none ────────────────────────────
  let percent: number | null = null;
  let basis: ProgressReport['basis'] = 'none';
  let approximate = false;
  let provenance: Phrase | undefined;
  let percentSuppressed: Phrase | undefined;

  const driftSuppresses = drift.some((d) => d.severity === 'high');

  if (driftSuppresses) {
    percentSuppressed = ph('plan ile git çelişiyor — yüzde bastırıldı');
  } else if (spine) {
    // Ladder position first, as the plan's own priority list says. A project
    // that marks "three of seven phases done" has measured itself at the
    // grain of the whole project; a checkbox count has measured one document.
    // The coarse measurement of the right thing beats the precise measurement
    // of the wrong one — and `coarsen` keeps it from pretending otherwise.
    percent = coarsen((spine.doneRungs / spine.rungs.length) * 100);
    basis = 'milestones';
    approximate = true;
    provenance = ph(
      'sıra konumu · {0}/{1} basamak · {2}',
      spine.doneRungs,
      spine.rungs.length,
      spine.file.rel,
    );
  } else if (aggTotal >= MIN_DENOMINATOR && aggOpen > 0) {
    percent = Math.round((aggDone / aggTotal) * 100);
    basis = 'items';
    // The numerator is the *weighted* one, the same number the percentage was
    // divided from. Printing the plain count of finished items beside a
    // percentage computed with half credit for partial work produced
    // "1/12 madde · %25" on screen, which reads as a bug in the arithmetic
    // and is in fact a bug in the sentence.
    provenance =
      counted.length === 1
        ? ph(
            '{0}/{1} madde · {2} · {3}',
            weight(aggDone),
            weight(aggTotal),
            counted[0]!.file.rel,
            agoPhrase(now - counted[0]!.file.mtimeMs),
          )
        : ph('{0}/{1} madde · {2} plan belgesi', weight(aggDone), weight(aggTotal), counted.length);
  } else if (counted.length === 0) {
    percentSuppressed =
      sources.length === 0
        ? ph('plan belgesi bulunamadı')
        : (sources.find((s) => s.suppressedReason)?.suppressedReason ?? ph('sayılabilir plan yok'));
  } else if (aggOpen === 0) {
    percentSuppressed = ph(
      '{0} maddenin tamamı işaretli, bitmemiş madde yok — bu bir kayıt belgesi',
      weight(aggTotal),
    );
  } else {
    percentSuppressed = ph('sayılabilir madde {0} < {1}', weight(aggTotal), MIN_DENOMINATOR);
  }

  const nextAction = readings
    .map((r) => r.doc.remaining)
    .find((r): r is string => typeof r === 'string' && r.length > 3);

  return {
    phase,
    percent,
    basis,
    percentSuppressed,
    phaseSuppressed,
    approximate,
    nextAction: nextAction?.slice(0, 200),
    observedAt: newestDeclared,
    sources: [...sources].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 40),
    sourceCount: sources.length,
    planCount: counted.length,
    drift,
    provenance,
    doneWeight: countedDone,
    totalWeight: countedTotal,
  };
}

/** Rungs a ladder needs before it can speak for a project: two is a pair. */
const SPINE_MIN_RUNGS = 3;

/** A ladder that could be the project's spine, and the document it came from. */
interface SpineCandidate {
  file: DocFile;
  doc: DocumentReading;
  ladder: Ladder;
  /**
   * The ladder's rungs with descoped ones removed.
   *
   * A dropped phase left both sides of the fraction everywhere else in this
   * engine, and it has to here too: counting `Aşama 6 — iptal` as a rung
   * *achieved* made a project's own i18n plan report the whole repository as
   * one seventh done.
   */
  rungs: Ladder['entries'];
  /** Rungs marked done — the count, not the contiguous prefix. */
  doneRungs: number;
}

/**
 * Ladders that locate a project rather than merely list rungs.
 *
 * Three rules, each written against a measured failure on the reference
 * machine:
 *
 * **One document.** Ladders are never merged across files. Merging every
 * `Faz N` in a repository treats unrelated feature plans as one sequence: on
 * a real 72-document project that produced `Faz 0 / 7` out of a water-module
 * plan whose seven phases were all finished and a monitoring plan whose seven
 * had not started. Two documents saying "Faz 1" are not describing the same
 * rung unless they are the same plan.
 *
 * **Part done.** A ladder with nothing marked is a table of contents, and one
 * with everything marked is a finished piece of work; in both cases the
 * project's position is somewhere else. Requiring at least one finished and
 * one unfinished rung is what makes "this project is on Faz 3" a reading
 * rather than a guess.
 *
 * **Only plans and status documents vote.** A changelog naming `Faz 2` is
 * describing the past.
 */
function spineCandidates(
  readings: Array<{ file: DocFile; doc: DocumentReading }>,
): SpineCandidate[] {
  const out: SpineCandidate[] = [];
  for (const { file, doc } of readings) {
    if (doc.role !== 'PLAN' && doc.role !== 'STATUS') continue;
    for (const ladder of doc.ladders) {
      // Version tokens are not phases: `v1.2` and `v2.0` are release names,
      // and a project is not "half way through v1 and v2".
      if (ladder.unit === 'v') continue;
      const rungs = ladder.entries.filter((e) => e.status !== 'dropped');
      if (rungs.length < SPINE_MIN_RUNGS) continue;
      const doneRungs = rungs.filter((e) => e.status === 'done').length;
      if (doneRungs === 0 || doneRungs === rungs.length) continue;
      out.push({ file, doc, ladder, rungs, doneRungs });
    }
  }
  return out;
}

const ROLE_RANK: Record<string, number> = { STATUS: 2, PLAN: 1 };

/**
 * The one ladder allowed to answer "which phase is this project in".
 *
 * A status document outranks a plan because it is the project reporting on
 * itself now, where a plan is the project's intention. Below that, more rungs
 * wins — a longer ladder is a more considered decomposition — and recency
 * breaks what is left.
 *
 * When a second document carries its own part-done ladder, no answer is
 * given at all — unless it is plainly the same ladder, same unit and same
 * position, in which case the two agree and either will do. Anything else is
 * a project with two candidate spines, and picking the higher-ranked file
 * would be taking a side in a disagreement the reader cannot see. Two units
 * are never comparable: `Faz 3 of 7` and `Aşama 1 of 4` in different files
 * are two decompositions of different things.
 */
function pickSpine(cands: SpineCandidate[]): { spine: SpineCandidate | null; rivalry?: Phrase } {
  if (cands.length === 0) return { spine: null };
  const ranked = [...cands].sort(
    (a, b) =>
      (ROLE_RANK[b.doc.role] ?? 0) - (ROLE_RANK[a.doc.role] ?? 0) ||
      b.ladder.entries.length - a.ladder.entries.length ||
      b.file.mtimeMs - a.file.mtimeMs,
  );
  const best = ranked[0]!;
  const rivals = ranked.filter(
    (c) =>
      c.file.rel !== best.file.rel &&
      !(c.ladder.unit === best.ladder.unit && c.doneRungs === best.doneRungs),
  );
  if (rivals.length > 0) {
    return {
      spine: null,
      rivalry: ph(
        '{0} belge ayrı birer basamak dizisi tanımlıyor — proje fazı belirsiz',
        new Set([best.file.rel, ...rivals.map((r) => r.file.rel)]).size,
      ),
    };
  }
  return { spine: best };
}

/**
 * A weight, printed.
 *
 * Partial work counts as half, so these are not always whole numbers, and
 * `3.5` has to survive to the screen: rounding it to `4` in the provenance
 * while the percentage was computed from `3.5` is the same class of lie this
 * file exists to avoid.
 */
function weight(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The phase the *branch name* claims.
 *
 * Only the branch. A commit subject mentioning `Stage 1` is prose -- it might
 * be "does not break Stage 1" -- and taking a phase from it made a project on
 * its fifth stage report `Stage 1` from `main`, then raised a drift alert
 * against its own plan for disagreeing. A branch name is a deliberate label
 * for the work in hand; a sentence is not.
 *
 * Verified branch names on the reference machine that this is built for:
 * `phase0-desktop-m9`, `faz1/sprint0-1-hardening`,
 * `slice-a/a4-goods-receipt-putaway`.
 */
function readGitPhase(git: GitFacts | null | undefined): PhaseView | null {
  if (!git?.branch) return null;
  const best = phaseTokens(git.branch)[0];
  if (!best) return null;
  return {
    labelRaw: best.labelRaw,
    unit: best.unit,
    ordinal: best.ordinal,
    total: best.ordinal,
    kind: classifyPhaseKind(git.branch),
    basis: 'git',
    confidence: 0.6,
  };
}

function days(ms: number): number {
  return Math.round(ms / 86_400_000);
}


