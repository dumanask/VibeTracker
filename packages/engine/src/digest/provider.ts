/**
 * Which model writes the summary, and whose account pays for it.
 *
 * The thing this file exists to avoid is a tool that only works if you happen
 * to be an Anthropic customer. The summary is one paragraph of judgement about
 * a project — it is not a place to require a particular vendor, and requiring
 * one would exclude most of the people the tool is for. So the provider is a
 * choice with four real answers, and one of them is a wire format rather than
 * a company.
 *
 * **`openai` is not OpenAI.** It is `POST {base}/chat/completions` with a
 * bearer token and a `messages` array, which is what OpenRouter, Groq,
 * DeepSeek, Mistral, xAI, Together, Fireworks, LM Studio, vLLM, llama.cpp's
 * server and Google's own compatibility endpoint all accept. One `base_url`
 * reaches every one of them; writing an adapter per vendor would have been a
 * row of adapters that each go stale on their own schedule.
 *
 * **Nothing here runs unless the user turned it on.** The default is `off`,
 * the daemon never calls any of this, and the only caller is a command the
 * user types. VibeTracker watching your machine and VibeTracker sending
 * anything anywhere are two separate decisions, and this file is the second
 * one.
 *
 * Zero dependencies, like the rest: global `fetch` for the three HTTP
 * providers, a child process for the CLI one.
 */

export type ProviderId = 'off' | 'claude-cli' | 'anthropic' | 'openai' | 'ollama';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  /** Empty means the provider's own default. */
  baseUrl: string;
  /** Resolved key, or null when this provider needs none. */
  apiKey: string | null;
}

export interface ChatRequest {
  system: string;
  user: string;
  /** A ceiling on the reply, not on the thinking. */
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChatReply {
  text: string;
  /** Absent when the provider does not say. Never estimated here. */
  inputTokens?: number;
  outputTokens?: number;
  /** What actually answered, as the provider names it. */
  model?: string;
}

export class ProviderError extends Error {
  readonly kind: 'config' | 'auth' | 'network' | 'http' | 'shape' | 'unsupported';
  readonly status?: number;
  constructor(
    message: string,
    kind: 'config' | 'auth' | 'network' | 'http' | 'shape' | 'unsupported',
    status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/** The default endpoint for each family. */
export const DEFAULT_BASE: Record<'anthropic' | 'openai' | 'ollama', string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434',
};

/**
 * The variable each family conventionally uses, when the config names none.
 *
 * A default rather than a requirement: whoever points `openai` at OpenRouter
 * already has `OPENROUTER_API_KEY` set and can say so in one line, and whoever
 * points it at a llama.cpp on their own machine needs no key at all.
 */
export const DEFAULT_KEY_ENV: Record<ProviderId, string | null> = {
  off: null,
  'claude-cli': null,
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: null,
};

/** A model that exists, per family, when the user named none. */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  off: '',
  'claude-cli': '',
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1:8b',
};

export function isLocal(url: string): boolean {
  try {
    // `hostname` keeps the brackets on an IPv6 literal — `[::1]`, not `::1` —
    // so comparing it raw quietly calls a loopback address remote, and the
    // preview then warns that data is leaving a machine it never leaves.
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/** Whether a key is required before we can even try. */
export function needsKey(provider: ProviderId, baseUrl: string): boolean {
  if (provider === 'anthropic') return true;
  // An OpenAI-shaped endpoint on loopback is a model running on this machine,
  // and those take no key. Demanding one would make the most private option
  // the most annoying one to set up.
  if (provider === 'openai') return !isLocal(baseUrl || DEFAULT_BASE.openai);
  return false;
}

/**
 * Does the payload leave this machine?
 *
 * Asked before anything is sent, and shown to the user in those words. It is
 * the only question about a provider that the tool's own promises depend on.
 */
export function leavesMachine(cfg: ProviderConfig): boolean {
  if (cfg.provider === 'off') return false;
  // The CLI talks to the vendor on our behalf, which is still egress.
  if (cfg.provider === 'claude-cli') return true;
  const base = cfg.baseUrl || DEFAULT_BASE[cfg.provider];
  return !isLocal(base);
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = (): void => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new ProviderError(e instanceof Error ? e.message : String(e), 'network');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    // The body is read because providers put the useful part there — "model
    // not found", "insufficient quota", "context length exceeded" — and a bare
    // 400 sends the user guessing. Truncated, because it is not ours.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* nothing to add */
    }
    throw new ProviderError(
      `HTTP ${res.status}${detail ? ': ' + detail : ''}`,
      res.status === 401 || res.status === 403 ? 'auth' : 'http',
      res.status,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError('yanıt JSON değil', 'shape');
  }
}

/** `POST /v1/messages` — Anthropic's own shape. */
async function chatAnthropic(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  if (!cfg.apiKey) throw new ProviderError('anahtar yok', 'config');
  const base = cfg.baseUrl || DEFAULT_BASE.anthropic;
  const body = await post(
    joinUrl(base, '/v1/messages'),
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: cfg.model || DEFAULT_MODEL.anthropic,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    },
    req.timeoutMs,
    req.signal,
  );
  const b = body as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    model?: unknown;
  };
  const text = (b.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => str(c.text))
    .join('');
  if (!text) throw new ProviderError('boş yanıt', 'shape');
  return {
    text,
    inputTokens: num(b.usage?.input_tokens),
    outputTokens: num(b.usage?.output_tokens),
    model: str(b.model) || undefined,
  };
}

/**
 * `POST {base}/chat/completions` — the shape almost everything else speaks.
 *
 * Deliberately plain: no `response_format`, no tool calls, no vendor JSON
 * mode. Half the endpoints this reaches implement those partially or not at
 * all, and a request that 400s on somebody's self-hosted model is worse than
 * a reply we validate ourselves — which has to happen either way, because a
 * schema the provider enforced is still a schema we did not check.
 */
async function chatOpenAI(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const base = cfg.baseUrl || DEFAULT_BASE.openai;
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
  const body = await post(
    joinUrl(base, '/chat/completions'),
    headers,
    {
      model: cfg.model || DEFAULT_MODEL.openai,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    },
    req.timeoutMs,
    req.signal,
  );
  const b = body as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    model?: unknown;
  };
  const text = str(b.choices?.[0]?.message?.content);
  if (!text) throw new ProviderError('boş yanıt', 'shape');
  return {
    text,
    inputTokens: num(b.usage?.prompt_tokens),
    outputTokens: num(b.usage?.completion_tokens),
    model: str(b.model) || undefined,
  };
}

/** `POST /api/chat` — Ollama. Nothing leaves the machine. */
async function chatOllama(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const base = cfg.baseUrl || DEFAULT_BASE.ollama;
  const body = await post(
    joinUrl(base, '/api/chat'),
    {},
    {
      model: cfg.model || DEFAULT_MODEL.ollama,
      stream: false,
      options: { num_predict: req.maxTokens },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    },
    req.timeoutMs,
    req.signal,
  );
  const b = body as {
    message?: { content?: unknown };
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    model?: unknown;
  };
  const text = str(b.message?.content);
  if (!text) throw new ProviderError('boş yanıt', 'shape');
  return {
    text,
    inputTokens: num(b.prompt_eval_count),
    outputTokens: num(b.eval_count),
    model: str(b.model) || undefined,
  };
}

/**
 * The `claude` CLI, if the user already has one.
 *
 * The one provider that costs nothing extra and needs no key: it bills
 * whatever subscription is already signed in. Slower, and it eats the same
 * quota the user's actual coding sessions eat, which is why it is offered
 * rather than defaulted to.
 *
 * The prompt goes in on stdin. Passing it as an argument would put a project's
 * plan text on a command line — readable in the process table by anything on
 * the machine, and captured by every process-listing tool including, with some
 * irony, this product's own probe.
 */
async function chatClaudeCli(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const { spawn } = await import('node:child_process');
  const args = ['-p', '--output-format', 'json'];
  if (cfg.model) args.push('--model', cfg.model);
  return await new Promise<ChatReply>((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProviderError('zaman aşımı', 'network'));
    }, req.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.stderr.on('data', (c: string) => {
      if (err.length < 2000) err += c;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ProviderError(`claude çalıştırılamadı: ${e.message}`, 'config'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ProviderError(`claude çıkış kodu ${code}${err ? ': ' + err.trim() : ''}`, 'http'),
        );
        return;
      }
      try {
        const parsed = JSON.parse(out) as {
          result?: unknown;
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
        };
        const text = str(parsed.result);
        if (!text) {
          reject(new ProviderError('boş yanıt', 'shape'));
          return;
        }
        resolve({
          text,
          inputTokens: num(parsed.usage?.input_tokens),
          outputTokens: num(parsed.usage?.output_tokens),
          model: cfg.model || undefined,
        });
      } catch {
        reject(new ProviderError('yanıt JSON değil', 'shape'));
      }
    });
    // The system prompt is prepended rather than passed separately: `claude -p`
    // takes one prompt, and `--append-system-prompt` is not on every version
    // that is out there in the wild.
    child.stdin.end(`${req.system}\n\n${req.user}`);
  });
}

export async function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  switch (cfg.provider) {
    case 'off':
      throw new ProviderError('LLM kapalı', 'config');
    case 'anthropic':
      return await chatAnthropic(cfg, req);
    case 'openai':
      return await chatOpenAI(cfg, req);
    case 'ollama':
      return await chatOllama(cfg, req);
    case 'claude-cli':
      return await chatClaudeCli(cfg, req);
    default:
      throw new ProviderError('bilinmeyen sağlayıcı', 'unsupported');
  }
}
