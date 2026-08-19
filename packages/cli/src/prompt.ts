/**
 * Terminal prompts.
 *
 * One rule governs all of them: **without a terminal, nothing is assumed.**
 * `vt init` may well be run from a script, a CI job, or a provisioning tool,
 * and in that setting a prompt that silently takes the default is how a
 * machine ends up with hooks it was never asked about. Non-interactive runs
 * either get an explicit flag or get the safe answer.
 */
import { createInterface } from 'node:readline/promises';
import { t, tr } from '@vibetracker/core';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Yes/no. `fallback` is what a non-interactive run gets — always the answer
 * that changes nothing on the machine.
 */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!isInteractive()) return fallback;
  // The hint letters are translated, but every language's letters are always
  // accepted below: someone reading English output on a Turkish keyboard
  // habit should not have their `e` rejected.
  const hint = fallback ? tr('[Y/n]') : tr('[y/N]');
  for (;;) {
    const a = (await ask(`${question} ${hint} `)).toLowerCase();
    if (a === '') return fallback;
    // Both languages the interface speaks are accepted, whichever one is
    // active: somebody running with --lang tr types `e`, and the prompt should
    // not refuse the word it just showed them.
    if (a === 'y' || a === 'yes' || a === 'e' || a === 'evet') return true;
    if (a === 'n' || a === 'no' || a === 'h' || a === 'hayır' || a === 'hayir') return false;
    process.stdout.write(tr('  Type y (yes) or n (no).\n'));
  }
}

export interface Choice<T> {
  value: T;
  label: string;
  /** One line under the label. Where the trade-off goes. */
  detail?: string;
}

/** Numbered menu. Returns `fallback` when there is no terminal. */
export async function choose<T>(
  question: string,
  choices: Array<Choice<T>>,
  fallback: T,
): Promise<T> {
  if (!isInteractive()) return fallback;
  const defaultIndex = Math.max(
    0,
    choices.findIndex((c) => c.value === fallback),
  );
  process.stdout.write(`\n${question}\n`);
  for (const [i, c] of choices.entries()) {
    const mark = i === defaultIndex ? '›' : ' ';
    process.stdout.write(`  ${mark} ${i + 1}) ${c.label}\n`);
    if (c.detail) process.stdout.write(`        ${c.detail}\n`);
  }
  for (;;) {
    const a = await ask(t`Choice [${defaultIndex + 1}] `);
    if (a === '') return choices[defaultIndex]!.value;
    const n = Number.parseInt(a, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    process.stdout.write(t`  Type a number between 1 and ${choices.length}.\n`);
  }
}

/** Free text with a default. */
export async function askText(question: string, fallback: string): Promise<string> {
  if (!isInteractive()) return fallback;
  const a = await ask(`${question} [${fallback}] `);
  return a === '' ? fallback : a;
}
