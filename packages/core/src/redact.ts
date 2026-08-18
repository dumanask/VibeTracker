/**
 * Redaction.
 *
 * Not a nice-to-have. Measured on the reference machine: the last megabyte of
 * 25 transcripts contained 5 private-key markers and 2 JWTs, and the agent's
 * own state directory holds a `.credentials.json`. Any free text that crosses
 * from the agent into our database, our log, our dashboard or an LLM payload
 * has to come through here first.
 *
 * Two honest limits, stated because pretending otherwise is how people get
 * burned:
 *
 * 1. **This produces false negatives.** A company-internal token format we have
 *    never seen will pass straight through. Redaction is therefore never the
 *    only defence — the LLM digest stays off by default and shows a full
 *    preview before sending, and the diagnostics bundle is allowlist-based.
 * 2. **It also produces false positives**, and that is the correct trade. A
 *    high-entropy string that turns out to be a git SHA reads as
 *    `«redacted:secret»`, which costs a little debuggability. The reverse
 *    mistake costs a credential.
 *
 * Placeholders are type-labelled so a redacted string is still diagnosable:
 * `«redacted:anthropic_key»` tells you what was there without telling you what
 * it was.
 */

interface Detector {
  name: string;
  re: RegExp;
}

/**
 * Order matters: the most specific patterns run first, so a provider key is
 * labelled as one rather than caught by the generic entropy rule.
 */
const DETECTORS: Detector[] = [
  { name: 'private_key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  // Length is deliberately not the gate for prefixed keys. `sk-ant-` is not a
  // string that occurs by accident, so requiring a realistic key length only
  // creates a way for a truncated or test key to slip through unredacted.
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{12,})/g },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
  { name: 'google_key', re: /\bAIza[A-Za-z0-9_-]{35}/g },
  { name: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g },
  {
    name: 'connection_string',
    re: /\b(?:postgres|postgresql|mysql|mongodb\+srv|mongodb|redis|amqp):\/\/[^\s"'<>]{8,}/gi,
  },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/g },
  { name: 'basic_auth', re: /\bBasic\s+[A-Za-z0-9+/=]{16,}/g },
];

/** `KEY=value` env lines: the name is useful context, the value never is. */
const ENV_LINE = /^([A-Z][A-Z0-9_]{3,})=(.{8,})$/gm;

/**
 * Shannon entropy per character. Real secrets sit above 4.0; English prose is
 * around 2.5-3.5 and identifiers lower still.
 */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{32,}\b/g;
const ENTROPY_THRESHOLD = 4.0;

/**
 * Hex and base64 of exactly the shapes we produce ourselves. A commit SHA or a
 * session UUID appearing as `«redacted»` in every evidence line would make the
 * dashboard useless, and neither is a credential.
 */
function isKnownBenign(s: string): boolean {
  if (/^[0-9a-f]{32,40}$/i.test(s)) return true; // git sha / md5
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  return false;
}

export interface RedactResult {
  text: string;
  /** Detector names that fired, for reporting "3 secrets removed". */
  hits: string[];
}

export function redactDetailed(input: string): RedactResult {
  const hits: string[] = [];
  let text = input;

  for (const d of DETECTORS) {
    text = text.replace(d.re, () => {
      hits.push(d.name);
      return `«redacted:${d.name}»`;
    });
  }

  text = text.replace(ENV_LINE, (_m, key: string) => {
    hits.push('env_value');
    return `${key}=«redacted:env_value»`;
  });

  text = text.replace(HIGH_ENTROPY, (m: string) => {
    if (isKnownBenign(m)) return m;
    if (entropy(m) < ENTROPY_THRESHOLD) return m;
    hits.push('high_entropy');
    return '«redacted:secret»';
  });

  return { text, hits };
}

export function redact(input: string): string {
  return redactDetailed(input).text;
}

/**
 * Redact and clamp to one short line. Used for anything rendered next to a
 * session — evidence strings, error reasons — where the point is a hint, not a
 * transcript.
 */
export function redactSnippet(input: string, max = 140): string {
  const oneLine = redact(input).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
