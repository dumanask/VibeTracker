/**
 * Which model writes the summary, and whose account pays for it.
 *
 * The thing this file exists to avoid is a tool that only works if you happen
 * to be an Anthropic customer. The summary is one paragraph of judgement about
 * a project — it is not a place to require a particular vendor, and requiring
 * one would exclude most of the people the tool is for. So the provider is a
 * choice, one of the answers is a wire format rather than a company, and two
 * of them are "a program that is already on your machine".
 *
 * **`openai` is not OpenAI.** It is `POST {base}/chat/completions` with a
 * bearer token and a `messages` array, which is what OpenRouter, Groq,
 * DeepSeek, Mistral, xAI, Together, Fireworks, LM Studio, vLLM, llama.cpp's
 * server and Google's own compatibility endpoint all accept. One `base_url`
 * reaches every one of them; writing an adapter per vendor would have been a
 * row of adapters that each go stale on their own schedule.
 *
 * **The same argument, one level up, is why `cli` exists.** The people this
 * tool watches already have an agent CLI signed in — `claude`, `codex`,
 * `gemini`, `opencode`, and whatever is released next month. Each of those is
 * a working model endpoint that costs nothing extra and needs no key, and
 * hardcoding an adapter per program would age exactly the way a per-vendor
 * HTTP adapter would. So there is one generic runner: the user names a
 * command, the prompt goes in, the answer comes out. `claude-cli` and
 * `codex-cli` are presets of it, present because those two are common enough
 * to be worth a one-word answer.
 *
 * **Nothing here runs unless the user turned it on.** The default is `off`,
 * the daemon never calls any of this, and the only caller is a command the
 * user types. VibeTracker watching your machine and VibeTracker sending
 * anything anywhere are two separate decisions, and this file is the second
 * one.
 *
 * Zero dependencies, like the rest: global `fetch` for the HTTP providers, a
 * child process for the CLI ones.
 */

export type ProviderId =
  | 'off'
  | 'claude-cli'
  | 'codex-cli'
  | 'cli'
  | 'anthropic'
  | 'openai'
  | 'ollama';

/** The providers that run a program instead of opening a socket. */
export type CliProviderId = 'claude-cli' | 'codex-cli' | 'cli';
export const CLI_PROVIDERS: readonly CliProviderId[] = ['claude-cli', 'codex-cli', 'cli'];

export function isCliProvider(p: ProviderId): p is CliProviderId {
  return (CLI_PROVIDERS as readonly string[]).includes(p);
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  /** Empty means the provider's own default. */
  baseUrl: string;
  /** Resolved key, or null when this provider needs none. */
  apiKey: string | null;
  /** `cli` only: the program to run. Nothing is guessed if this is empty. */
  command?: string;
  /** `cli` only: its arguments, after placeholder substitution. */
  args?: string[];
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
  'codex-cli': null,
  cli: null,
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: null,
};

/**
 * A model that exists, per family, when the user named none.
 *
 * Empty for every CLI provider on purpose. Those programs are already signed
 * in and already configured, and a default here would silently override the
 * model the user picked in the CLI's own config — the one place they would
 * look for it.
 */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  off: '',
  'claude-cli': '',
  'codex-cli': '',
  cli: '',
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

/** Whether the payload leaves the machine — including "we cannot know". */
export type Egress = 'yes' | 'no' | 'unknown';

/**
 * Does the payload leave this machine?
 *
 * Asked before anything is sent, and shown to the user in those words. It is
 * the only question about a provider that the tool's own promises depend on.
 *
 * Three answers rather than two, because `cli` runs a program we did not
 * write. `codex exec` goes to OpenAI; the same mechanism pointed at a local
 * wrapper goes nowhere; and there is no way to tell which from here without
 * inspecting somebody else's binary. Guessing "no" would be a promise this
 * file cannot keep, and guessing "yes" would libel a local model — so it says
 * it does not know, and every caller treats not-knowing as egress.
 */
export function egress(cfg: ProviderConfig): Egress {
  switch (cfg.provider) {
    case 'off':
      return 'no';
    // These talk to a vendor on our behalf, which is still egress.
    case 'claude-cli':
    case 'codex-cli':
      return 'yes';
    case 'cli':
      return 'unknown';
    default:
      return isLocal(cfg.baseUrl || DEFAULT_BASE[cfg.provider]) ? 'no' : 'yes';
  }
}

/** The conservative reading of {@link egress}: unknown counts as leaving. */
export function leavesMachine(cfg: ProviderConfig): boolean {
  return egress(cfg) !== 'no';
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

// ── running somebody else's program ──────────────────────────────────────
//
// One runner for all three CLI providers. What it will not do is put the
// prompt on a command line: a project's plan text on an argv is readable in
// the process table by anything on the machine, and captured by every
// process-listing tool including, with some irony, this product's own probe.
// So the prompt goes in on stdin, and when a program cannot read stdin it
// goes in a 0600 file that is deleted afterwards. There is deliberately no
// `{prompt}` placeholder.

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * `.cmd` shims need a shell on Windows, and a shell does not quote for us.
 *
 * Node hands `spawn(..., {shell:true})` a single string, so an argument
 * containing a space — a temporary path under a username with one, which is
 * ordinary — would arrive as two arguments. Applied only where the shell is.
 */
function shellQuote(a: string): string {
  return /[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

async function runCommand(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const { spawn, spawnSync } = await import('node:child_process');
  const useShell = process.platform === 'win32';

  /**
   * Kill the tree, not the handle we happen to hold.
   *
   * On Windows the thing we spawned is `cmd.exe`, because a `.cmd` shim needs
   * a shell. `child.kill()` kills the shell and leaves the actual program
   * running — with our stdout pipe still open, so a timeout would return while
   * the abandoned process kept going. Measured: a run that should have given
   * up after 1.5 seconds held on for the child's full sixty.
   */
  const killTree = (pid: number | undefined): void => {
    if (useShell && pid !== undefined) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return;
      } catch {
        /* fall through to the ordinary kill */
      }
    }
  };
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(useShell ? shellQuote(command) : command, useShell ? args.map(shellQuote) : args, {
      // Everything piped, never inherited: a CLI that finds itself on a
      // terminal draws a progress spinner, and the spinner would land in the
      // middle of the answer.
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      child.kill();
      finish(() => reject(new ProviderError(`zaman aşımı (${Math.round(timeoutMs / 1000)} sn)`, 'network')));
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child.pid);
      child.kill();
      finish(() => reject(new ProviderError('iptal edildi', 'network')));
    };
    signal?.addEventListener('abort', onAbort);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.stderr.on('data', (c: string) => {
      if (err.length < 4000) err += c;
    });
    child.on('error', (e) => {
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
      finish(() =>
        reject(
          new ProviderError(
            enoent ? `"${command}" bulunamadı — kurulu mu, PATH'te mi?` : `${command}: ${e.message}`,
            'config',
          ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => resolve({ stdout: out, stderr: err, code }));
    });
    // A program that ignores stdin gets an EPIPE here, and that is its
    // business rather than a crash of ours.
    child.stdin.on('error', () => {
      /* the exit code and the output are what we judge by */
    });
    child.stdin.end(stdin);
  });
}

/** The whole prompt as one string. CLIs take one prompt, not a system/user pair. */
function flatten(req: ChatRequest): string {
  // Prepended rather than passed separately: `claude -p` takes one prompt and
  // `--append-system-prompt` is not on every version that is out there.
  return `${req.system}\n\n${req.user}`;
}

function cliFailed(command: string, r: CommandResult): ProviderError {
  const tail = r.stderr.trim().split('\n').slice(-3).join(' · ').slice(0, 300);
  return new ProviderError(`${command} çıkış kodu ${r.code}${tail ? ': ' + tail : ''}`, 'http');
}

/**
 * A scratch directory for one run: the prompt file, the answer file, and a
 * working root for agent CLIs that insist on having one.
 *
 * Under the OS temp directory rather than anywhere near a project, because
 * an agent CLI given a working root will look around in it, and the one place
 * it must not look around in is the repository we are summarising.
 */
async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vt-digest-'));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS cleans its own temp directory eventually */
    }
  }
}

/**
 * The `claude` CLI, if the user already has one.
 *
 * Costs nothing extra and needs no key: it bills whatever subscription is
 * already signed in. Slower, and it eats the same quota the user's actual
 * coding sessions eat, which is why it is offered rather than defaulted to.
 */
async function chatClaudeCli(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const args = ['-p', '--output-format', 'json'];
  if (cfg.model) args.push('--model', cfg.model);
  const r = await runCommand('claude', args, flatten(req), req.timeoutMs, req.signal);
  if (r.code !== 0) throw cliFailed('claude', r);
  try {
    const parsed = JSON.parse(r.stdout) as {
      result?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const text = str(parsed.result);
    if (!text) throw new ProviderError('boş yanıt', 'shape');
    return {
      text,
      inputTokens: num(parsed.usage?.input_tokens),
      outputTokens: num(parsed.usage?.output_tokens),
      model: cfg.model || undefined,
    };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('yanıt JSON değil', 'shape');
  }
}

/**
 * Which flags this `codex` has.
 *
 * Codex is a fast-moving CLI and the installed version is whatever the user
 * installed. Rather than pin a flag set and break on the versions that do not
 * have it — or omit useful flags and be careless on the versions that do —
 * the arguments are chosen from `codex exec --help`, which costs one process
 * on a call that is about to spend a minute talking to a model.
 *
 * Pure, so the choice is testable without a `codex` on the machine.
 */
export function codexArgs(
  help: string,
  opts: { model: string; outFile: string; workDir: string },
): string[] {
  const has = (flag: string): boolean => help.includes(flag);
  const args = ['exec'];
  // We are not in a repository and do not want to be treated as if we were.
  if (has('--skip-git-repo-check')) args.push('--skip-git-repo-check');
  // Codex is an agent, not a completion endpoint. It is asked a question about
  // text it was handed, so it has no reason to touch a disk — and read-only is
  // the strongest thing its own sandbox offers by name.
  if (has('--sandbox')) args.push('--sandbox', 'read-only');
  // Do not leave a session transcript of our payload behind on the way.
  if (has('--ephemeral')) args.push('--ephemeral');
  if (has('--color')) args.push('--color', 'never');
  // An empty scratch directory: if it does look around, there is nothing there.
  if (has('--cd')) args.push('--cd', opts.workDir);
  // The final message alone. Without it the answer arrives wrapped in the
  // agent's own progress narration, which is parseable but not dependably so.
  if (has('--output-last-message')) args.push('--output-last-message', opts.outFile);
  if (opts.model) args.push('--model', opts.model);
  // Read the prompt from stdin.
  args.push('-');
  return args;
}

/**
 * The `codex` CLI, if the user already has one.
 *
 * The same bargain as `claude-cli`, for the people who have the other
 * subscription — which is the entire point of this file existing.
 */
async function chatCodexCli(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const help = await runCommand('codex', ['exec', '--help'], '', 20_000, req.signal).catch(
    (e: unknown) => {
      throw e instanceof ProviderError ? e : new ProviderError(String(e), 'config');
    },
  );
  return await withScratch(async (dir) => {
    const { mkdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const outFile = join(dir, 'answer.txt');
    const workDir = join(dir, 'work');
    mkdirSync(workDir, { recursive: true });
    const args = codexArgs(help.stdout + help.stderr, { model: cfg.model, outFile, workDir });
    const r = await runCommand('codex', args, flatten(req), req.timeoutMs, req.signal);
    if (r.code !== 0) throw cliFailed('codex', r);
    let text = '';
    try {
      text = readFileSync(outFile, 'utf8').trim();
    } catch {
      // No `--output-last-message` on this version; the answer is in the
      // narration and `parseDigest` takes the outermost brace pair anyway.
      text = r.stdout;
    }
    if (!text.trim()) throw new ProviderError('boş yanıt', 'shape');
    return { text, model: cfg.model || 'codex' };
  });
}

/** Placeholders a user may put in `[digest] args`. */
export const CLI_PLACEHOLDERS = ['{prompt_file}', '{output_file}', '{model}'] as const;

/** Substitute, and say which of the two file placeholders were actually used. */
export function substituteArgs(
  args: string[],
  paths: { promptFile: string; outputFile: string; model: string },
): { args: string[]; usesPromptFile: boolean; usesOutputFile: boolean } {
  let usesPromptFile = false;
  let usesOutputFile = false;
  const out = args.map((a) => {
    if (a.includes('{prompt_file}')) usesPromptFile = true;
    if (a.includes('{output_file}')) usesOutputFile = true;
    return a
      .replaceAll('{prompt_file}', paths.promptFile)
      .replaceAll('{output_file}', paths.outputFile)
      .replaceAll('{model}', paths.model);
  });
  return { args: out, usesPromptFile, usesOutputFile };
}

/**
 * Any other command the user names.
 *
 * This is the answer to "I use something you have never heard of". The
 * contract is small on purpose: the program is given the prompt, and whatever
 * it prints is read as the answer. `{prompt_file}` and `{output_file}` are
 * there for programs that will not use stdin or stdout; `{model}` is there so
 * the `[digest] model` line means something for them too.
 *
 * The command comes out of the user's own config file, which is to say the
 * user is running a program they named. That is not a new privilege — but it
 * is why `vt digest` prints the command before it runs it, and why egress for
 * this provider is reported as unknown rather than assumed.
 */
async function chatCli(cfg: ProviderConfig, req: ChatRequest): Promise<ChatReply> {
  const command = (cfg.command ?? '').trim();
  if (!command) {
    throw new ProviderError(
      'çalıştırılacak komut yazılmamış — config dosyasında [digest] command ayarla',
      'config',
    );
  }
  return await withScratch(async (dir) => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const promptFile = join(dir, 'prompt.txt');
    const outputFile = join(dir, 'answer.txt');
    const prompt = flatten(req);
    const sub = substituteArgs(cfg.args ?? [], { promptFile, outputFile, model: cfg.model });
    // Written only when asked for, at 0600, and taken away with the directory.
    if (sub.usesPromptFile) writeFileSync(promptFile, prompt, { mode: 0o600 });

    const r = await runCommand(
      command,
      sub.args,
      sub.usesPromptFile ? '' : prompt,
      req.timeoutMs,
      req.signal,
    );
    if (r.code !== 0) throw cliFailed(command, r);

    let text = r.stdout;
    if (sub.usesOutputFile) {
      try {
        text = readFileSync(outputFile, 'utf8');
      } catch {
        throw new ProviderError(`{output_file} yazılmadı: ${outputFile}`, 'shape');
      }
    }
    if (!text.trim()) throw new ProviderError('boş yanıt', 'shape');
    return { text, model: cfg.model || command };
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
    case 'codex-cli':
      return await chatCodexCli(cfg, req);
    case 'cli':
      return await chatCli(cfg, req);
    default:
      throw new ProviderError('bilinmeyen sağlayıcı', 'unsupported');
  }
}
