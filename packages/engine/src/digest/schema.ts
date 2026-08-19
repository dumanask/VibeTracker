/**
 * The closed shape a model's answer has to fit, and what happens when it does
 * not.
 *
 * Two jobs, and the second is the one that matters. The first is ordinary: a
 * model asked for JSON returns something JSON-shaped most of the time, and the
 * rest of the time returns it wrapped in a code fence, or with a sentence in
 * front, or with a field spelled differently. That is tidying.
 *
 * The second is a security boundary. The payload contains text lifted out of
 * the user's own plan files, and a plan file can be written by anyone — a
 * dependency's README, a repository somebody cloned. If that text talks the
 * model into emitting something else, the closed schema is what stops it
 * mattering: every string is length-capped, every category is an enum, and the
 * result is only ever *rendered*. Nothing in it is executed, no file is written
 * from it, and no path in it is opened.
 *
 * `evidence_refs` is required. An answer with no evidence is refused outright
 * rather than shown with a shrug, because an unsupported claim on a dashboard
 * is indistinguishable from a supported one at a glance.
 */

export const PHASE_KINDS = [
  'scaffold',
  'design',
  'build',
  'integrate',
  'harden',
  'test',
  'release',
  'maintain',
  'paused',
  'unknown',
] as const;
export type DigestPhaseKind = (typeof PHASE_KINDS)[number];

export const PHASE_STATUSES = ['not_started', 'in_progress', 'done', 'blocked', 'unknown'] as const;
export type DigestPhaseStatus = (typeof PHASE_STATUSES)[number];

export const PERCENT_BASES = [
  'milestones',
  'checklist',
  'todo_tool',
  'commits',
  'declared',
  'llm_judgement',
  'none',
] as const;
export type DigestPercentBasis = (typeof PERCENT_BASES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type DigestConfidence = (typeof CONFIDENCES)[number];

export type EvidenceKind = 'commit' | 'file' | 'branch' | 'session' | 'plan';

export interface DigestOutput {
  phaseKind: DigestPhaseKind;
  phaseLabelRaw: string;
  phaseIndex: number | null;
  phaseTotal: number | null;
  phaseStatus: DigestPhaseStatus;
  percentEstimate: number | null;
  percentBasis: DigestPercentBasis;
  confidence: DigestConfidence;
  nextAction: string | null;
  blocker: string | null;
  stallReason: string | null;
  riskFlags: string[];
  evidence: Array<{ kind: EvidenceKind; ref: string }>;
  conflicts: string[];
  unchanged: boolean;
  summary: string;
}

export type ParseResult =
  | { ok: true; value: DigestOutput }
  | { ok: false; reason: string };

/**
 * Find the JSON in whatever came back.
 *
 * Models fence it, prefix it, and occasionally apologise before it. Taking the
 * outermost brace pair is enough for all three and does not need a parser of
 * its own — and if the result is not valid JSON, that is a refusal, not a
 * salvage operation.
 */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

function cap(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.slice(0, max);
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function intOrNull(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < min || n > max ? null : n;
}

function strings(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = cap(x, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

const EVIDENCE_KINDS: EvidenceKind[] = ['commit', 'file', 'branch', 'session', 'plan'];

export function parseDigest(raw: string): ParseResult {
  const json = extractJson(raw);
  if (!json) return { ok: false, reason: 'yanıtta JSON yok' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'JSON ayrıştırılamadı' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'JSON bir nesne değil' };
  }
  const o = parsed as Record<string, unknown>;

  const evidence: Array<{ kind: EvidenceKind; ref: string }> = [];
  if (Array.isArray(o['evidence_refs'])) {
    for (const e of o['evidence_refs'] as unknown[]) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const ref = cap(r['ref'], 120);
      if (!ref) continue;
      evidence.push({ kind: pick(r['kind'], EVIDENCE_KINDS, 'file'), ref });
      if (evidence.length >= 8) break;
    }
  }
  // The one hard requirement. A summary that cites nothing is a summary that
  // could have been written without reading anything, and there is no way to
  // tell the two apart once it is on screen.
  if (evidence.length === 0) return { ok: false, reason: 'kanıt gösterilmemiş' };

  const summary = cap(o['summary'], 400);
  if (!summary) return { ok: false, reason: 'özet yok' };

  let confidence = pick(o['confidence'], CONFIDENCES, 'low');
  const percentEstimate = intOrNull(o['percent_estimate'], 0, 100);
  let percentBasis = pick(o['percent_basis'], PERCENT_BASES, 'none');
  // A basis without a number, or a number without a basis, is a half-answer.
  // Both halves are made to agree here rather than left for each surface to
  // interpret differently.
  if (percentEstimate === null) percentBasis = 'none';
  else if (percentBasis === 'none') percentBasis = 'llm_judgement';
  // A model's own estimate is never allowed to look counted.
  if (percentBasis === 'llm_judgement' && confidence === 'high') confidence = 'medium';

  return {
    ok: true,
    value: {
      phaseKind: pick(o['phase_kind'], PHASE_KINDS, 'unknown'),
      phaseLabelRaw: cap(o['phase_label_raw'], 60) ?? '',
      phaseIndex: intOrNull(o['phase_index'], 0, 999),
      phaseTotal: intOrNull(o['phase_total'], 0, 999),
      phaseStatus: pick(o['phase_status'], PHASE_STATUSES, 'unknown'),
      percentEstimate,
      percentBasis,
      confidence,
      nextAction: cap(o['next_action'], 160),
      blocker: cap(o['blocker'], 160),
      stallReason: cap(o['stall_reason'], 160),
      riskFlags: strings(o['risk_flags'], 6, 40),
      evidence,
      conflicts: strings(o['conflicts'], 4, 160),
      unchanged: o['unchanged'] === true,
      summary,
    },
  };
}
