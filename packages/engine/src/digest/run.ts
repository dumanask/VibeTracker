/**
 * One digest, end to end: build, send, validate.
 *
 * Small on purpose. Everything that decides anything lives on either side of
 * it — `payload.ts` decides what is sent, `schema.ts` decides what counts as
 * an answer, `provider.ts` decides how to reach a model. This is the part that
 * says "once, and once more if the answer was not a valid one".
 *
 * Exactly one retry. A model that returned prose the first time usually
 * returns JSON when told so plainly; a model that returns prose twice is not
 * going to be argued into it, and each attempt is the user's money or the
 * user's quota.
 */
import { buildPayload, type BuiltPayload, type DigestInput } from './payload.ts';
import { parseDigest, type DigestOutput } from './schema.ts';
import { chat, ProviderError, type ChatReply, type ProviderConfig } from './provider.ts';

export interface RunResult {
  output: DigestOutput;
  payload: BuiltPayload;
  reply: ChatReply;
  /** How many requests it took. Two means the first answer was rejected. */
  attempts: number;
  model?: string;
}

export interface RunOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called before each request, so a caller can show what is happening. */
  onAttempt?: (n: number) => void;
}

const RETRY_NOTE =
  '\n\nYour previous reply was not accepted: it must be one JSON object matching the ' +
  'schema exactly, with a non-empty "evidence_refs". Reply with the object and nothing else.';

export async function runDigest(
  cfg: ProviderConfig,
  input: DigestInput,
  opts: RunOptions = {},
): Promise<RunResult> {
  const payload = buildPayload(input);
  const maxTokens = opts.maxTokens ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let lastReason = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    opts.onAttempt?.(attempt);
    const reply = await chat(cfg, {
      system: payload.system,
      user: attempt === 1 ? payload.user : payload.user + RETRY_NOTE,
      maxTokens,
      timeoutMs,
      signal: opts.signal,
    });
    const parsed = parseDigest(reply.text);
    if (parsed.ok) {
      return { output: parsed.value, payload, reply, attempts: attempt, model: reply.model };
    }
    lastReason = parsed.reason;
  }
  throw new ProviderError(`the answer did not fit the schema: ${lastReason}`, 'shape');
}
