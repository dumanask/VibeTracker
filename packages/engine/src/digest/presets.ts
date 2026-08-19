/**
 * The agent CLIs this tool knows how to ask a question, as a table.
 *
 * There was a version of this with one function per program. It lasted two
 * programs. Every entry does the same four things — find out what flags this
 * build has, choose the safe ones, hand the prompt over, read the answer back —
 * so the differences belong in data and the procedure belongs in one place
 * (`chatPreset` in `provider.ts`). Adding a CLI is a row.
 *
 * **The rule every row obeys: the prompt never appears in an argument.** A
 * command line is readable in the process table by anything on the machine,
 * and the payload is a summary of the user's own plans. So a program is only
 * in this table if its documentation says the prompt itself can arrive on
 * stdin — or, for `aider`, in a file, which is the same promise kept a
 * different way (0600, deleted with the scratch directory).
 *
 * Two well-known CLIs are deliberately absent for exactly that reason:
 *
 * - **`cursor-agent`** documents `-p` with the prompt as an argument. Its
 *   reference says print mode is *inferred* from piped stdin, which is not the
 *   same statement as "the pipe becomes the prompt", and guessing wrong here
 *   means silently sending nothing.
 * - **`q`** (Amazon Q Developer) shows piped data as *context* alongside an
 *   argument prompt, and its non-interactive mode wants `--trust-all-tools`.
 *
 * Both remain reachable through the `cli` provider, where the user writes the
 * command themselves and can use `{prompt_file}`.
 *
 * **Flags are chosen from each program's own `--help`.** These are fast-moving
 * tools and the installed build is whatever the user installed; pinning a flag
 * set would break on the versions that lack it, and omitting useful flags
 * would be careless on the versions that have it. One extra process on a call
 * that is about to spend a minute talking to a model.
 *
 * What could not be done from here is run most of them. The invocations come
 * from each project's own documentation, cited per row; only `claude`,
 * `codex`, `opencode` and `gemini` were exercised against a real install. A
 * row that is wrong fails loudly rather than quietly — see the error handling
 * in `chatPreset` — but it is a claim until somebody runs it.
 */

/** Everything a row may use to build its arguments. */
export interface PresetContext {
  /** The program's own `--help`, or empty when the row asked for no probe. */
  help: string;
  /** `[digest] model`, empty when the user named none. */
  model: string;
  /** An empty scratch directory the program is run inside. */
  workDir: string;
  /** Where a program that will not use stdout should write its answer. */
  outFile: string;
  /** Where the prompt is, for the rows that take a file rather than stdin. */
  promptFile: string;
  /**
   * What the program wrote to {@link outFile}, or null if it wrote nothing.
   *
   * Read by the runner rather than by a row, because a row that opened files
   * itself would be a second place that touches a disk — and because a row is
   * otherwise pure, which is what makes the flag choices testable without any
   * of these programs installed.
   */
  outFileText?: string | null;
}

export interface PresetReply {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CliPreset {
  /** The provider id in `config.toml`. */
  id: string;
  /** The program on PATH. */
  program: string;
  /** The short line a preview shows. Not the real argument list. */
  display: string;
  /** Arguments for the `--help` probe, or omitted to skip it. */
  probe?: string[];
  /** How the prompt gets there. `stdin` unless the program cannot take it. */
  promptVia?: 'stdin' | 'file';
  args(ctx: PresetContext): string[];
  /** Pull the answer out of the run. Defaults to stdout. */
  read?(r: { stdout: string; stderr: string }, ctx: PresetContext): PresetReply;
}

/** `flag` appears in the help text this build printed. */
function has(help: string, flag: string): boolean {
  return help.includes(flag);
}

/**
 * `codex exec`.
 *
 * Exported because it was tested before this table existed and the test is
 * worth keeping pointed at the same function.
 */
export function codexArgs(
  help: string,
  opts: { model: string; outFile: string; workDir: string },
): string[] {
  const args = ['exec'];
  // We are not in a repository and do not want to be treated as if we were.
  if (has(help, '--skip-git-repo-check')) args.push('--skip-git-repo-check');
  // Codex is an agent, not a completion endpoint. It is asked a question about
  // text it was handed, so it has no reason to touch a disk — and read-only is
  // the strongest thing its own sandbox offers by name.
  if (has(help, '--sandbox')) args.push('--sandbox', 'read-only');
  // Do not leave a session transcript of our payload behind on the way.
  if (has(help, '--ephemeral')) args.push('--ephemeral');
  if (has(help, '--color')) args.push('--color', 'never');
  if (has(help, '--cd')) args.push('--cd', opts.workDir);
  // The final message alone. Without it the answer arrives wrapped in the
  // agent's own progress narration, which is parseable but not dependably so.
  if (has(help, '--output-last-message')) args.push('--output-last-message', opts.outFile);
  if (opts.model && has(help, '--model')) args.push('--model', opts.model);
  // Read the prompt from stdin.
  args.push('-');
  return args;
}

/** `opencode run`. Verified against a real install: no positional, stdin reaches the model. */
export function opencodeArgs(help: string, opts: { model: string; workDir: string }): string[] {
  const args = ['run'];
  // Third-party plugins are somebody else's code running against our payload.
  if (has(help, '--pure')) args.push('--pure');
  if (has(help, '--dir')) args.push('--dir', opts.workDir);
  if (opts.model && has(help, '--model')) args.push('--model', opts.model);
  return args;
}

/**
 * `gemini --prompt ""`.
 *
 * The empty `--prompt` is what switches it to headless; its own help says the
 * value given there is appended to stdin, so the payload still travels on
 * stdin and the argument stays empty. `--skip-trust` is not optional: without
 * it Gemini refuses to run in a directory it has not been told to trust, and
 * ours is a scratch directory created a second earlier. Both measured.
 */
export function geminiArgs(help: string, opts: { model: string }): string[] {
  const args: string[] = [];
  if (has(help, '--skip-trust')) args.push('--skip-trust');
  if (has(help, '--approval-mode')) args.push('--approval-mode', 'plan');
  if (opts.model && has(help, '--model')) args.push('--model', opts.model);
  args.push('--prompt', '');
  return args;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The table.
 *
 * Ordered by how likely somebody watching agents already has the program:
 * the four that were exercised here first, then the rest alphabetically.
 */
export const CLI_PRESETS: readonly CliPreset[] = [
  {
    // https://code.claude.com/docs/en/headless — `-p` with stdin.
    id: 'claude-cli',
    program: 'claude',
    display: 'claude -p',
    probe: ['--help'],
    args: ({ help, model }) => {
      const args = ['-p'];
      // Gated like every other row. This one used to be unconditional, which
      // was fine right up until a build without the flag: the run would fail
      // on an unknown option and report it as the model failing.
      if (has(help, '--output-format')) args.push('--output-format', 'json');
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
    read: (r, ctx) => {
      // The JSON envelope also carries token counts, which is the only place
      // any of these programs tells us what the call cost.
      try {
        const p = JSON.parse(r.stdout) as {
          result?: unknown;
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
        };
        return {
          text: str(p.result),
          inputTokens: num(p.usage?.input_tokens),
          outputTokens: num(p.usage?.output_tokens),
        };
      } catch {
        // An older build without `--output-format json` prints the answer
        // plainly, and the schema parser takes the outermost brace pair.
        void ctx;
        return { text: r.stdout };
      }
    },
  },
  {
    // https://developers.openai.com/codex/noninteractive — `exec -` reads stdin.
    id: 'codex-cli',
    program: 'codex',
    display: 'codex exec',
    probe: ['exec', '--help'],
    args: (ctx) => codexArgs(ctx.help, ctx),
    // No `--output-last-message` on this build means the answer is in the
    // narration, and the schema parser takes the outermost brace pair anyway.
    read: (r, ctx) => ({ text: ctx.outFileText ?? r.stdout }),
  },
  {
    // https://opencode.ai — `opencode run` with a piped message. Measured.
    id: 'opencode-cli',
    program: 'opencode',
    display: 'opencode run',
    probe: ['run', '--help'],
    args: (ctx) => opencodeArgs(ctx.help, ctx),
  },
  {
    // https://geminicli.com/docs — `--prompt` is appended to stdin. Measured.
    id: 'gemini-cli',
    program: 'gemini',
    display: 'gemini --prompt',
    probe: ['--help'],
    args: (ctx) => geminiArgs(ctx.help, ctx),
  },
  {
    // https://aider.chat/docs/scripting.html — `--message-file`, not stdin.
    // The one row that uses a file, and the reason `promptVia` exists.
    id: 'aider-cli',
    program: 'aider',
    display: 'aider --message-file',
    probe: ['--help'],
    promptVia: 'file',
    args: ({ help, model, promptFile }) => {
      const args = ['--message-file', promptFile];
      // Aider edits and commits by default. We are asking it a question about
      // text we handed it, so every one of those doors gets closed: no repo,
      // no commits, no edits, and no prompt waiting for an answer nobody is
      // there to give.
      if (has(help, '--no-git')) args.push('--no-git');
      if (has(help, '--no-auto-commits')) args.push('--no-auto-commits');
      if (has(help, '--dry-run')) args.push('--dry-run');
      if (has(help, '--no-stream')) args.push('--no-stream');
      if (has(help, '--yes-always')) args.push('--yes-always');
      else if (has(help, '--yes')) args.push('--yes');
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
  },
  {
    // https://ampcode.com/manual — "You can also pipe input when using -x".
    id: 'amp-cli',
    program: 'amp',
    display: 'amp -x',
    args: () => ['-x'],
  },
  {
    // https://docs.continue.dev/cli — `echo "..." | cn -p`.
    id: 'continue-cli',
    program: 'cn',
    display: 'cn -p',
    probe: ['--help'],
    args: ({ help, model }) => {
      const args = ['-p'];
      // Strips the thinking tags, which are not part of an answer.
      if (has(help, '--silent')) args.push('--silent');
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
  },
  {
    // https://docs.github.com/en/copilot — `echo "…" | copilot`.
    id: 'copilot-cli',
    program: 'copilot',
    display: 'copilot',
    probe: ['--help'],
    args: ({ help, model }) => {
      const args: string[] = [];
      // Session metadata is not an answer, and a clarifying question asked of
      // a script is a hang.
      if (has(help, '--no-ask-user')) args.push('--no-ask-user');
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
  },
  {
    // https://charmbracelet-crush.mintlify.app/cli/run — "or piped from stdin".
    id: 'crush-cli',
    program: 'crush',
    display: 'crush run',
    probe: ['run', '--help'],
    args: ({ help, model, workDir }) => {
      const args = ['run'];
      // Hides the spinner, which would otherwise land in the answer.
      if (has(help, '--quiet')) args.push('--quiet');
      if (has(help, '--cwd')) args.push('--cwd', workDir);
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
  },
  {
    // https://docs.factory.ai/droid-exec/overview — `droid exec -` reads stdin,
    // and its default mode is read-only without `--auto`.
    id: 'droid-cli',
    program: 'droid',
    display: 'droid exec',
    probe: ['exec', '--help'],
    args: ({ help, model }) => {
      const args = ['exec'];
      if (has(help, '--output-format')) args.push('--output-format', 'text');
      if (model && has(help, '--model')) args.push('--model', model);
      // Explicitly not `--auto`: read-only is this program's default and the
      // only mode it should ever be in here.
      args.push('-');
      return args;
    },
  },
  {
    // https://goose-docs.ai/docs/guides/goose-cli-commands — `run` takes an
    // instruction file or stdin.
    id: 'goose-cli',
    program: 'goose',
    display: 'goose run',
    probe: ['run', '--help'],
    args: ({ help }) => {
      const args = ['run'];
      // A one-off question has no business in the session history.
      if (has(help, '--no-session')) args.push('--no-session');
      return args;
    },
  },
  {
    // https://llm.datasette.io — piped stdin is treated as a one-off prompt.
    // Not an agent: a prompt goes in, text comes out, nothing is executed.
    id: 'llm-cli',
    program: 'llm',
    display: 'llm',
    probe: ['--help'],
    args: ({ model }) => (model ? ['-m', model] : []),
  },
  {
    // https://qwenlm.github.io/qwen-code-docs — piping alone triggers headless.
    id: 'qwen-cli',
    program: 'qwen',
    display: 'qwen',
    probe: ['--help'],
    args: ({ help, model }) => {
      const args: string[] = [];
      if (has(help, '--approval-mode')) args.push('--approval-mode', 'plan');
      if (has(help, '--output-format')) args.push('--output-format', 'text');
      if (model && has(help, '--model')) args.push('--model', model);
      return args;
    },
  },
];

export function presetFor(id: string): CliPreset | null {
  return CLI_PRESETS.find((p) => p.id === id) ?? null;
}
