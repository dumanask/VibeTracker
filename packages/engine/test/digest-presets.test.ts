/**
 * The agent CLIs offered by name, rather than by asking the user to write a
 * command into a config file.
 *
 * `claude` and `codex` were presets from the start; `opencode` and `gemini`
 * were not, and the only way to reach them was the generic `cli` provider —
 * which is config-file-only, because it accepts a command string. The result
 * was that two perfectly ordinary answers to "which model" were reachable only
 * by someone willing to find a TOML file. Adding them as presets fixes that
 * without letting a command string near the wire: what a chooser sends is a
 * provider name, and what runs comes from this codebase.
 *
 * The arguments are chosen from each program's own `--help`, so a version
 * without a flag does not get it. The fixtures beside this file are that help
 * text, captured verbatim from real installs — which is what makes these
 * assertions statements about the programs rather than about my memory of
 * them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  chat,
  cliCommandLine,
  cliProgram,
  codexArgs,
  egress,
  geminiArgs,
  isCliProvider,
  opencodeArgs,
  CLI_PROGRAM,
  CLI_PROVIDERS,
  ProviderError,
  type ProviderConfig,
} from '../src/digest/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const help = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

test('every CLI provider names a program, and only the open-ended one does not', () => {
  for (const id of CLI_PROVIDERS) {
    assert.equal(typeof CLI_PROGRAM[id], 'string', id);
    if (id !== 'cli') assert.ok(CLI_PROGRAM[id].length > 0, id);
  }
  assert.equal(CLI_PROGRAM.cli, '');

  // The program to look for on PATH. For a preset it is fixed; for `cli` it is
  // whatever the user wrote, and for everything else there is none.
  assert.equal(cliProgram({ provider: 'opencode-cli' }), 'opencode');
  assert.equal(cliProgram({ provider: 'gemini-cli' }), 'gemini');
  assert.equal(cliProgram({ provider: 'cli', command: '  aider  ' }), 'aider');
  assert.equal(cliProgram({ provider: 'cli' }), '');
  assert.equal(cliProgram({ provider: 'ollama' }), '');
  assert.equal(cliProgram({ provider: 'off' }), '');
});

test('the preview names the program, not the whole flag list', () => {
  assert.equal(cliCommandLine({ provider: 'claude-cli' }), 'claude -p');
  assert.equal(cliCommandLine({ provider: 'codex-cli' }), 'codex exec');
  assert.equal(cliCommandLine({ provider: 'opencode-cli' }), 'opencode run');
  assert.equal(cliCommandLine({ provider: 'gemini-cli' }), 'gemini --prompt');
  assert.equal(cliCommandLine({ provider: 'cli', command: 'aider', args: ['--no-git'] }), 'aider --no-git');
  assert.equal(cliCommandLine({ provider: 'ollama' }), '');
});

test('the new presets reach a vendor, so they are reported as leaving', () => {
  const of = (provider: ProviderConfig['provider']): string =>
    egress({ provider, model: '', baseUrl: '', apiKey: null });
  assert.equal(of('opencode-cli'), 'yes');
  assert.equal(of('gemini-cli'), 'yes');
  // Still `unknown` for the open-ended one: that command might be a wrapper
  // around a local model and might be a satellite uplink.
  assert.equal(of('cli'), 'unknown');
  assert.ok(isCliProvider('opencode-cli'));
  assert.ok(isCliProvider('gemini-cli'));
});

test('opencode is run with the flags its own help offers', () => {
  const h = help('opencode-run-help.txt');
  const args = opencodeArgs(h, { model: 'opencode/claude-haiku-4-5', workDir: 'WORK' });

  // No positional message: the prompt goes in on stdin. Verified against the
  // real program — `opencode run` with a piped prompt and no argument reaches
  // the model — and it is the whole reason this provider is allowed to exist.
  assert.deepEqual(args, [
    'run',
    '--pure',
    '--dir',
    'WORK',
    '--model',
    'opencode/claude-haiku-4-5',
  ]);

  // Nothing resembling the payload is ever an argument.
  assert.ok(!args.some((a) => a.includes(' ')));

  // A version that has none of these flags gets none of them, rather than
  // failing on an unknown option.
  assert.deepEqual(opencodeArgs('', { model: 'm', workDir: 'W' }), ['run']);
  // And no model configured means no `--model`: the one the user picked inside
  // opencode is the one they would look for.
  assert.deepEqual(opencodeArgs(h, { model: '', workDir: 'W' }), ['run', '--pure', '--dir', 'W']);
});

test('gemini is put into headless mode without the prompt on the command line', () => {
  const h = help('gemini-help.txt');
  const args = geminiArgs(h, { model: 'gemini-2.5-flash' });

  assert.deepEqual(args, [
    '--skip-trust',
    '--approval-mode',
    'plan',
    '--model',
    'gemini-2.5-flash',
    '--prompt',
    '',
  ]);

  // The empty `--prompt` is what switches it to headless; its own help says
  // the value there is appended to stdin, so the payload still travels on
  // stdin and the argument stays empty.
  assert.equal(args[args.length - 1], '');

  // `--skip-trust` is not decoration. Without it Gemini refuses to run in a
  // directory it has not been told to trust, and ours is a scratch directory
  // created a second earlier. Measured on a real install.
  assert.ok(args.includes('--skip-trust'));

  assert.deepEqual(geminiArgs('', { model: 'm' }), ['--prompt', '']);
});

test('codex still gets exactly the flags it did', () => {
  // The captured help is from the installed codex; this is the regression
  // guard for a refactor that moved every preset onto one table.
  const args = codexArgs(help('codex-exec-help.txt'), {
    model: 'gpt-5.1',
    outFile: 'OUT',
    workDir: 'WORK',
  });
  assert.equal(args[0], 'exec');
  assert.equal(args[args.length - 1], '-');
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('OUT'));
});

/**
 * A stand-in program on PATH, so the preset path can be run without the real
 * one being installed, signed in, or in credit.
 */
function withFakeOnPath(name: string, body: string, fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vt-preset-'));
  const saved = process.env['PATH'];
  const win = process.platform === 'win32';
  const file = join(dir, win ? `${name}.cmd` : name);
  writeFileSync(file, body);
  if (!win) chmodSync(file, 0o755);
  // Prepended, so the fake wins over a real installation on the machine
  // running the suite.
  process.env['PATH'] = `${dir}${delimiter}${saved ?? ''}`;
  return fn().finally(() => {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

const REQ = { system: 'SYS', user: 'PLAN', maxTokens: 100, timeoutMs: 30_000 };

test('a failing opencode is reported with the words the vendor used, not swallowed', async () => {
  // Measured against a real install: a billing failure exits 1 and prints the
  // reason on **stdout**, wrapped in colour codes it emits even when nothing
  // is watching. Both halves matter — reading only stderr loses the message,
  // and leaving the escape codes in makes it unreadable in a terminal that is
  // not interpreting them.
  const win = process.platform === 'win32';
  const esc = String.fromCharCode(27);
  const body = win
    ? `@echo off\r\nif "%2"=="--help" (echo --pure --dir --model & exit /b 0)\r\necho ${esc}[91mError: Insufficient balance.${esc}[0m\r\nexit /b 1\r\n`
    : `#!/bin/sh\ncase "$2" in --help) echo "--pure --dir --model"; exit 0;; esac\nprintf '${esc}[91mError: Insufficient balance.${esc}[0m\\n'\nexit 1\n`;
  await withFakeOnPath('opencode', body, async () => {
    const cfg: ProviderConfig = { provider: 'opencode-cli', model: '', baseUrl: '', apiKey: null };
    await assert.rejects(
      () => chat(cfg, REQ),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.match(e.message, /Insufficient balance/);
        assert.ok(!e.message.includes(esc), 'no escape codes in a message a person reads');
        return true;
      },
    );
  });
});

test('the prompt reaches the program on stdin and never as an argument', async () => {
  // The rule the whole CLI half of this feature is built on: the payload is a
  // summary of the user's own plans, and a command line is readable in the
  // process table by anything on the machine.
  const win = process.platform === 'win32';
  const marker = 'GIZLI-PLAN-METNI';
  const body = win
    ? '@echo off\r\nif "%2"=="--help" (echo --pure --dir --model & exit /b 0)\r\nset /p L=\r\necho seen:%L%\r\necho args:%*\r\n'
    : '#!/bin/sh\ncase "$2" in --help) echo "--pure --dir --model"; exit 0;; esac\nread L\necho "seen:$L"\necho "args:$*"\n';
  await withFakeOnPath('opencode', body, async () => {
    const cfg: ProviderConfig = { provider: 'opencode-cli', model: '', baseUrl: '', apiKey: null };
    const reply = await chat(cfg, { ...REQ, system: marker, user: 'plan' });
    assert.match(reply.text, new RegExp('seen:' + marker));
    const args = /args:(.*)/.exec(reply.text)?.[1] ?? '';
    assert.ok(!args.includes(marker), 'the payload is not on the command line');
  });
});

test('a preset that is not installed says so instead of throwing a stack', async () => {
  // `spawn` reports ENOENT asynchronously, through an event rather than a
  // throw, so this is the difference between a sentence and an unhandled
  // error event taking the process down.
  const saved = process.env['PATH'];
  process.env['PATH'] = mkdtempSync(join(tmpdir(), 'vt-empty-'));
  try {
    const cfg: ProviderConfig = { provider: 'gemini-cli', model: '', baseUrl: '', apiKey: null };
    await assert.rejects(
      () => chat(cfg, REQ),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.kind, 'config');
        assert.match(e.message, /bulunamadı|PATH/);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
  }
});
