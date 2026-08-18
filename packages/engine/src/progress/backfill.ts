/**
 * Historical phase timeline, reconstructed from git.
 *
 * The daemon only knows what happened since it was installed. Everything
 * before that is a blank on the chart, and a chart whose first three months
 * are blank looks like a project that did nothing — the opposite of the truth.
 *
 * Git already holds the record. Commit subjects carry phase tokens
 * (`feat: Faz 2 tamamlandı`), completion verbs, and dates; running the same
 * phase parser used for plan documents over `git log` yields a dated ladder
 * for the project's whole life. Zero tokens, zero network, one process.
 *
 * Two honesty rules govern the output:
 *
 * 1. **Backfilled points are marked.** They never raise alerts and never
 *    count as observations — a daemon restart must not notify anyone about a
 *    permission prompt from last April.
 * 2. **The resolution difference is stated, not hidden.** Commit archaeology
 *    gives one point per commit that mentions a phase; live tracking gives one
 *    per change. Presenting them in the same visual language would claim a
 *    precision the past does not have.
 */
import { execFile } from 'node:child_process';
import {
  classifyPhaseKind,
  foldText,
  hasStem,
  lexicon,
  phaseTokens,
  type PhaseKind,
} from '@vibetracker/core';

/** How far back to read. 500 commits is minutes of history, not hours. */
const MAX_COMMITS = 500;
const GIT_TIMEOUT_MS = 20_000;

/**
 * Field separator for the git log format, written as an escape rather than as
 * a literal character.
 *
 * A raw NUL in source is invisible in every editor. One of them landed inside
 * a map key in this very file, so the two passes over the point list built
 * keys that looked identical on screen and were not: every lookup in the
 * second pass missed, silently, and the counter it fed stayed at zero. Escapes
 * are the only form these characters may take here.
 */
const SEP = '\u0000';

/** One key per phase rung. Shared so the two passes cannot disagree again. */
function rungKey(p: { unit: string; ordinal: number }): string {
  return `${p.unit} ${p.ordinal}`;
}

export interface PhasePoint {
  /** Commit time, ms since epoch. */
  at: number;
  labelRaw: string;
  unit: string;
  ordinal: number;
  kind: PhaseKind;
  /** True when the subject also carried a completion verb. */
  completed: boolean;
  sha: string;
  /** Always true here: this is reconstruction, not observation. */
  backfill: true;
}

export interface BackfillResult {
  points: PhasePoint[];
  /** Commits examined, so the caller can say how deep the reconstruction went. */
  commitsScanned: number;
  /** Oldest and newest commit times seen, for axis bounds. */
  from: number | null;
  to: number | null;
  /** Why there is nothing, when there is nothing. */
  reason?: 'no-git' | 'no-commits' | 'no-phase-tokens';
}

/**
 * Does this commit subject claim something finished?
 *
 * The vocabulary lives in `lexicons/*.json`, not here — a project that writes
 * "kapanış" instead of "kapatıldı" should be a data fix, not a code release.
 * Stems rather than exact forms, because a commit subject inflects freely:
 * measured on the reference repositories, `tamamlama`, `kapanış` and
 * `tamamlandı` all appear, and a list of exact forms matched none of them.
 */
function claimsCompletion(subject: string): boolean {
  const folded = foldText(subject);
  return lexicon().completionStems.some((stem) => hasStem(folded, stem));
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, '--no-optional-locks', ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * Read the project's phase history out of its commit log.
 *
 * Only the subject line is read — never a diff, never file contents. A commit
 * subject is a sentence the author wrote about their own work, which is
 * exactly the kind of claim this engine is built to read.
 */
export async function backfillPhases(root: string, limit = MAX_COMMITS): Promise<BackfillResult> {
  const raw = await git(root, [
    'log',
    `-n${limit}`,
    '--no-merges',
    // NUL between fields so a subject containing anything at all is safe.
    '--format=%H%x00%ct%x00%s',
  ]);
  if (raw === null) return { points: [], commitsScanned: 0, from: null, to: null, reason: 'no-git' };

  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { points: [], commitsScanned: 0, from: null, to: null, reason: 'no-commits' };
  }

  const points: PhasePoint[] = [];
  let from: number | null = null;
  let to: number | null = null;

  for (const line of lines) {
    const [sha, secs, subject] = line.split('\0');
    if (!sha || !secs || subject === undefined) continue;
    const at = Number(secs) * 1000;
    if (!Number.isFinite(at)) continue;
    from = from === null ? at : Math.min(from, at);
    to = to === null ? at : Math.max(to, at);

    const completed = claimsCompletion(subject);
    for (const token of phaseTokens(subject)) {
      // Same rule the plan ladder uses: only whole rungs. `v2.5` in a commit
      // subject is a version bump, not a step between phase 2 and phase 3,
      // and admitting it invents a rung nobody planned.
      if (!Number.isInteger(token.ordinal)) continue;
      points.push({
        at,
        labelRaw: token.labelRaw,
        unit: token.unit,
        ordinal: token.ordinal,
        // Classify from the whole subject: "Faz 3" alone says nothing, but
        // "Faz 3 — e2e testleri" says `test`.
        kind:
          classifyPhaseKind(subject) !== 'unknown'
            ? classifyPhaseKind(subject)
            : classifyPhaseKind(token.labelRaw),
        completed,
        sha: sha.slice(0, 12),
        backfill: true,
      });
    }
  }

  points.sort((a, b) => a.at - b.at);
  return {
    points,
    commitsScanned: lines.length,
    from,
    to,
    reason: points.length === 0 ? 'no-phase-tokens' : undefined,
  };
}

export interface PhaseSpan {
  unit: string;
  ordinal: number;
  labelRaw: string;
  kind: PhaseKind;
  /** First commit that mentioned this rung. */
  firstAt: number;
  /** Last commit that mentioned it, completed or not. */
  lastAt: number;
  /** First commit that mentioned it *with* a completion verb, if any. */
  doneAt: number | null;
  commits: number;
  /**
   * Commits that mentioned this rung *after* it was first declared done.
   *
   * Worth its own field because it is the common shape of a lie: a phase
   * announced complete, then twenty more commits about it. The board shows
   * the declaration and the tail side by side rather than picking one.
   */
  afterDone: number;
}

/**
 * Collapse the point cloud into one span per phase.
 *
 * The chart wants "Faz 2 ran from March to May", not four hundred dots. First
 * mention opens the span; the first mention with a completion verb closes it.
 * A rung mentioned once and never completed stays open, which is honest: the
 * commit log records that it was worked on, not that it finished.
 */
export function toSpans(points: PhasePoint[]): PhaseSpan[] {
  const byRung = new Map<string, PhaseSpan>();
  for (const p of points) {
    const key = rungKey(p);
    const existing = byRung.get(key);
    if (!existing) {
      byRung.set(key, {
        unit: p.unit,
        ordinal: p.ordinal,
        labelRaw: p.labelRaw,
        kind: p.kind,
        firstAt: p.at,
        lastAt: p.at,
        doneAt: p.completed ? p.at : null,
        commits: 1,
        afterDone: 0,
      });
      continue;
    }
    existing.commits++;
    existing.firstAt = Math.min(existing.firstAt, p.at);
    existing.lastAt = Math.max(existing.lastAt, p.at);
    if (p.completed && (existing.doneAt === null || p.at < existing.doneAt)) existing.doneAt = p.at;
    // A more descriptive label wins: "Faz 3 — e2e testleri" beats "Faz 3".
    if (p.labelRaw.length > existing.labelRaw.length) existing.labelRaw = p.labelRaw;
    if (existing.kind === 'unknown' && p.kind !== 'unknown') existing.kind = p.kind;
  }
  // Second pass: a commit can only be counted as "after done" once `doneAt`
  // is known, and that is not known until every point has been seen.
  for (const p of points) {
    const span = byRung.get(rungKey(p));
    const doneAt = span?.doneAt ?? null;
    if (span && doneAt !== null && p.at > doneAt) span.afterDone++;
  }
  return [...byRung.values()].sort((a, b) => a.firstAt - b.firstAt || a.ordinal - b.ordinal);
}
