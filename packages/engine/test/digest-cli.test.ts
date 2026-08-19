/**
 * The providers that run a program instead of opening a socket.
 *
 * Why this half of the feature exists: not everyone has a Claude subscription,
 * and the people this tool watches already have *some* agent CLI signed in —
 * `claude`, `codex`, `gemini`, `opencode`, whatever ships next. Each of those
 * is a working model endpoint that costs nothing extra and needs no key, so
 * "which LLM" should be answerable with "the one I already have".
 *
 * Two things that decision has to get right, and both are tested here:
 *
 * 1. **What is claimed about egress.** `cli` runs a program this codebase did
 *    not write. It might be a wrapper around a local model, it might be a
 *    satellite uplink. Claiming either would be making something up.
 * 2. **What ends up on a command line.** Nothing. The payload is a summary of
 *    the user's own plans, and a command line is readable in the process table
 *    by anything on the machine — including, with some irony, this product's
 *    own probe.
 *
 * The command tests run a real child process rather than a mock, because the
 * failures they are for — stdin never arriving, a temporary file surviving the
 * run, an exit code swallowing the reason — do not exist in a mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chat,
  codexArgs,
  egress,
  isCliProvider,
  leavesMachine,
  parseDigest,
  substituteArgs,
  ProviderError,
  type ProviderConfig,
} from '../src/digest/index.ts';

/** A `-e` script for `node`, the one program a machine running this must have. */
function nodeCli(script: string, args: string[] = []): ProviderConfig {
  return {
    provider: 'cli',
    model: '',
    baseUrl: '',
    apiKey: null,
    command: process.execPath,
    args: ['-e', script, ...args],
  };
}

const ANSWER =
  'JSON.stringify({phase_kind:"build",phase_label_raw:"Faz 2",phase_status:"in_progress",' +
  'confidence:"medium",summary:"ok",evidence_refs:[{kind:"commit",ref:"abc"}]})';

const REQ = {
  system: 'SYS',
  user: '<<<DATA\nplan\nDATA>>>',
  maxTokens: 100,
  timeoutMs: 30_000,
};

test('an empty argument survives the shell it has to cross', async () => {
  // Found by running it. On Windows a `.cmd` shim needs a shell, so Node is
  // handed one string and each argument is quoted into it — and an empty
  // string matched nothing that looked like it needed quoting, so it was
  // written as nothing and ceased to be an argument at all.
  //
  // That is not a corner case here: `gemini --prompt ""` is what puts that CLI
  // into headless mode. With the empty value gone the flag arrived without
  // one, the program printed its usage and exited 1, and the whole thing
  // surfaced as "the model failed".
  const cfg = nodeCli('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ['', 'SON']);
  const reply = await chat(cfg, REQ);
  assert.deepEqual(JSON.parse(reply.text), ['', 'SON']);
});

test('egress has three answers, because one of the providers is not ours', () => {
  const of = (provider: ProviderConfig['provider'], baseUrl = ''): string =>
    egress({ provider, model: '', baseUrl, apiKey: null });

  assert.equal(of('off'), 'no');
  assert.equal(of('ollama'), 'no');
  assert.equal(of('openai', 'http://127.0.0.1:1234/v1'), 'no');
  assert.equal(of('openai'), 'yes');
  // These reach a vendor through a program rather than through our socket,
  // which is the same thing as far as the user's data is concerned.
  assert.equal(of('claude-cli'), 'yes');
  assert.equal(of('codex-cli'), 'yes');
  assert.equal(of('cli'), 'unknown');

  // The conservative reading, which is what every surface uses: not knowing is
  // treated as leaving, never as staying.
  assert.equal(leavesMachine({ provider: 'cli', model: '', baseUrl: '', apiKey: null }), true);

  assert.ok(isCliProvider('codex-cli'));
  assert.ok(!isCliProvider('ollama'));
});

test('codex is invoked with the flags the installed codex actually has', () => {
  const full = [
    '  -m, --model <MODEL>',
    '      --sandbox <SANDBOX_MODE>',
    '      --skip-git-repo-check',
    '      --ephemeral',
    '      --color <COLOR>',
    '  -C, --cd <DIR>',
    '  -o, --output-last-message <FILE>',
  ].join('\n');
  const args = codexArgs(full, {
    model: 'gpt-5',
    outFile: '/tmp/a/out.txt',
    workDir: '/tmp/a/work',
  });

  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--skip-git-repo-check'));
  // An agent asked a question about text it was handed has no reason to write
  // anything, and its working root is an empty scratch directory rather than
  // the repository being summarised.
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), [
    '--sandbox',
    'read-only',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2), [
    '--cd',
    '/tmp/a/work',
  ]);
  assert.ok(args.includes('--ephemeral'), 'the payload must leave no session record on disk');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'gpt-5',
  ]);
  // The prompt comes in on stdin, so the last argument is the marker that says
  // so — and the prompt itself is nowhere on this list.
  assert.equal(args.at(-1), '-');

  // An older codex without those flags gets a command it can actually run,
  // rather than one that dies on an unknown argument.
  const old = ['  -m, --model <MODEL>', '      --skip-git-repo-check'].join('\n');
  const lean = codexArgs(old, { model: '', outFile: '/tmp/a/out.txt', workDir: '/tmp/a/work' });
  assert.deepEqual(lean, ['exec', '--skip-git-repo-check', '-']);
});

test('placeholders are substituted and the caller is told which were used', () => {
  const paths = { promptFile: '/tmp/p.txt', outputFile: '/tmp/o.txt', model: 'llama3' };

  const none = substituteArgs(['run'], paths);
  assert.deepEqual(none.args, ['run']);
  assert.equal(none.usesPromptFile, false);
  assert.equal(none.usesOutputFile, false);

  const both = substituteArgs(
    ['-m', '{model}', '--in', '{prompt_file}', '--out', '{output_file}'],
    paths,
  );
  assert.deepEqual(both.args, ['-m', 'llama3', '--in', '/tmp/p.txt', '--out', '/tmp/o.txt']);
  assert.equal(both.usesPromptFile, true);
  assert.equal(both.usesOutputFile, true);

  // There is deliberately no `{prompt}`. It is left alone rather than quietly
  // filled in, so nobody discovers the payload in a process listing.
  const nope = substituteArgs(['--text', '{prompt}'], paths);
  assert.deepEqual(nope.args, ['--text', '{prompt}']);
});

test('a named command is fed on stdin and read back, narration and all', async () => {
  const script =
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{' +
    'if(!s.includes("DATA>>>"))throw new Error("yuk stdin ile gelmedi");' +
    'process.stdout.write("thinking...\\n"+' +
    ANSWER +
    ')});';
  const reply = await chat(nodeCli(script), REQ);
  const parsed = parseDigest(reply.text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.value.phaseLabelRaw, 'Faz 2');
});

test('a command that will not read stdin gets a file, and it does not survive', async () => {
  // For the CLIs that take a path instead of a pipe. That file is the payload
  // in the clear, so the assertion that matters is the last one: a leftover
  // would sit in the temp directory indefinitely.
  const script =
    'const fs=require("node:fs");' +
    'const text=fs.readFileSync(process.argv[1],"utf8");' +
    'if(!text.includes("DATA>>>"))throw new Error("yuk dosyaya yazilmadi");' +
    'fs.writeFileSync(process.argv[2],' +
    ANSWER +
    ');fs.writeFileSync(process.argv[3],process.argv[1]);';
  const spy = mkdtempSync(join(tmpdir(), 'vt-spy-'));
  const trace = join(spy, 'where.txt');
  try {
    const reply = await chat(
      nodeCli(script, ['{prompt_file}', '{output_file}', trace]),
      REQ,
    );
    const parsed = parseDigest(reply.text);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    assert.equal(parsed.value.phaseLabelRaw, 'Faz 2');

    const promptPath = readFileSync(trace, 'utf8');
    assert.ok(promptPath.length > 0, 'the command never saw the payload file');
    assert.equal(existsSync(promptPath), false, `the payload file was left behind: ${promptPath}`);
  } finally {
    rmSync(spy, { recursive: true, force: true });
  }
});

test('a cli provider with nothing to run says so instead of guessing', async () => {
  await assert.rejects(
    () =>
      chat(
        { provider: 'cli', model: '', baseUrl: '', apiKey: null, command: '  ', args: [] },
        { ...REQ, timeoutMs: 1000 },
      ),
    (e: ProviderError) => e.kind === 'config',
  );
});

test('a command that is not there is a configuration problem, not a crash', async () => {
  await assert.rejects(
    () =>
      chat(
        {
          provider: 'cli',
          model: '',
          baseUrl: '',
          apiKey: null,
          command: 'vt-no-such-command',
          args: [],
        },
        { ...REQ, timeoutMs: 15_000 },
      ),
    // Windows reports a missing program through the shell's exit code rather
    // than through ENOENT, so both roads are accepted — what is not accepted
    // is an unhandled throw out of `spawn`.
    (e: ProviderError) => e.kind === 'config' || e.kind === 'http',
  );
});

test('a failing command reports what it said rather than a bare exit code', async () => {
  await assert.rejects(
    () => chat(nodeCli('process.stderr.write("kota bitti");process.exit(2)'), REQ),
    (e: ProviderError) => e.kind === 'http' && e.message.includes('kota bitti'),
  );
});

test('a command that never answers is given up on rather than waited out', async () => {
  await assert.rejects(
    () => chat(nodeCli('setTimeout(()=>{},60000)'), { ...REQ, timeoutMs: 1500 }),
    (e: ProviderError) => e.kind === 'network' && /timed out/.test(e.message),
  );
});
