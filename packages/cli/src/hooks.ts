import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { claudeDir } from '@vibetracker/platform';
import { t, appendInto, applySplices, parseWithPositions, child, detectIndent, hasComments, type JsonNode, JsonParseError, tr, removeElement, removeMember, render, type Splice } from '@vibetracker/core';
import {
  DEFAULT_HOOK_EVENTS,
  HIGH_FIDELITY_HOOK_EVENTS,
  HOOK_PATH,
  HOOK_TOKEN_HEADER,
  VT_MARKER,
  type HookEvent,
} from '@vibetracker/shared';
import { DEFAULT_PORT, loadOrCreateHookToken, readHookToken } from '@vibetracker/daemon';

/**
 * Installing hooks into a file we do not own.
 *
 * `settings.json` is the user's. It may hold their own hooks, their own
 * formatting, and their own comments, and every one of those must survive us.
 * Three rules follow, and each of them cost something to honour:
 *
 * 1. **No parse/stringify round trip.** Edits are text splices at recorded
 *    offsets (see `jsonedit.ts`). Rewriting the file would silently reformat
 *    everything we did not touch.
 * 2. **Show the diff, then ask.** Nothing is written until the user has seen
 *    exactly what changes. `--yes` exists for scripts; without a TTY it is
 *    required, because a prompt nobody can answer is not consent.
 * 3. **Never remove what we did not add.** Every entry carries `"_vt": true`
 *    and our own URL, and uninstall matches on both. Verified against the
 *    installed agent that the extra key is accepted rather than rejected —
 *    unknown hook *events* are reported as invalid, unknown *fields* are not.
 */

export interface HooksArgs {
  yes: boolean;
  highFidelity: boolean;
  port: number;
  /** Override the settings file, for tests and for non-default config dirs. */
  settingsPath?: string;
}

interface HookEntry {
  type: 'http';
  url: string;
  timeout: number;
  headers: Record<string, string>;
  [VT_MARKER]: true;
}

function settingsFile(args: Pick<HooksArgs, 'settingsPath'>): string {
  return args.settingsPath ?? join(claudeDir(), 'settings.json');
}

function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}${HOOK_PATH}`;
}

function entryFor(port: number, token: string): HookEntry {
  return {
    type: 'http',
    url: hookUrl(port),
    // Seconds. Short on purpose: the endpoint answers in under a millisecond,
    // so anything approaching this means the daemon is wedged, and the right
    // outcome then is for the agent to give up on us rather than wait.
    timeout: 3,
    headers: { [HOOK_TOKEN_HEADER]: token },
    [VT_MARKER]: true,
  };
}

function eventsFor(args: HooksArgs): HookEvent[] {
  return args.highFidelity
    ? [...DEFAULT_HOOK_EVENTS, ...HIGH_FIDELITY_HOOK_EVENTS]
    : [...DEFAULT_HOOK_EVENTS];
}

// ── reading current state ─────────────────────────────────────────────────

interface Installed {
  /** Events that already have one of our entries. */
  ours: Map<HookEvent, { url: string; token?: string }>;
  /** Events with someone else's hooks — counted, never touched. */
  foreign: number;
  raw: string;
  root: JsonNode;
  /** The agent rejects a commented settings file outright — see below. */
  commented: boolean;
}

function readSettings(path: string): { raw: string; root: JsonNode } {
  if (!existsSync(path)) return { raw: '{}\n', root: parseWithPositions('{}') };
  const raw = readFileSync(path, 'utf8');
  try {
    return { raw, root: parseWithPositions(raw) };
  } catch (err) {
    const e = err as JsonParseError;
    const line = raw.slice(0, e.offset).split('\n').length;
    throw new Error(
      t`${path} is not valid JSON (line ${line}: ${e.message}). ` +
        t`Nothing was changed, so your file stays intact.`,
    );
  }
}

function inspect(path: string, url: string): Installed {
  const { raw, root } = readSettings(path);
  const hooks = child(root, 'hooks');
  const ours = new Map<HookEvent, { url: string; token?: string }>();
  let foreign = 0;

  for (const m of hooks?.members ?? []) {
    for (const matcher of m.value.items ?? []) {
      for (const h of child(matcher, 'hooks')?.items ?? []) {
        const isOurs = child(h, VT_MARKER)?.value === true || child(h, 'url')?.value === url;
        if (isOurs) {
          const token = child(child(h, 'headers'), HOOK_TOKEN_HEADER)?.value;
          ours.set(m.key as HookEvent, {
            url: String(child(h, 'url')?.value ?? ''),
            token: typeof token === 'string' ? token : undefined,
          });
        } else {
          foreign++;
        }
      }
    }
  }
  return { ours, foreign, raw, root, commented: hasComments(raw) };
}

/**
 * Measured, not assumed: `claude doctor` reports "Invalid or malformed JSON"
 * for a settings file containing `//`, and drops the whole file. So a comment
 * is not a style choice here, it is a broken config — and it was broken before
 * we arrived. Saying so is the difference between the user fixing their file
 * and the user blaming our installer.
 */
function warnIfCommented(state: Installed, path: string): void {
  if (!state.commented) return;
  process.stderr.write(
    t`\n⚠ ${path} contains comment lines.\n` +
      t`  Claude Code reads this file as strict JSON and when it sees a comment it\n` +
      t`  ignores THE ENTIRE FILE ("Invalid or malformed JSON") — meaning none of\n` +
      t`  the settings here are in force right now, and neither would the hooks we\n` +
      t`  install. This was already true before we touched anything.\n` +
      t`  Remove the comments first, then run again. To verify: claude doctor\n\n`,
  );
}

// ── install ───────────────────────────────────────────────────────────────

export async function installHooks(args: HooksArgs): Promise<number> {
  const path = settingsFile(args);
  const token = loadOrCreateHookToken();
  const url = hookUrl(args.port);

  let state: Installed;
  try {
    state = inspect(path, url);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 5;
  }

  warnIfCommented(state, path);

  const wanted = eventsFor(args);
  const missing = wanted.filter((e) => !state.ours.has(e));
  const stale = wanted.filter((e) => {
    const cur = state.ours.get(e);
    return cur && (cur.url !== url || cur.token !== token);
  });

  if (missing.length === 0 && stale.length === 0) {
    process.stdout.write(t`Hooks are already up to date (${wanted.length} events).\n${path}\n`);
    return 0;
  }

  // Rewriting a stale entry is remove-then-add: an in-place value patch would
  // have to reason about where the old token sits inside an arbitrary object.
  const next = buildNext(state, path, wanted, url, token);

  process.stdout.write(renderDiff(state.raw, next, path));
  process.stdout.write(
    t`\n${missing.length} events will be added` +
      (stale.length ? t`, ${stale.length} events will be refreshed` : '') +
      (state.foreign ? t` · your ${state.foreign} hooks will be left alone` : '') +
      '\n',
  );
  process.stdout.write(
    t`\nThis adds one POST to ${url} on every agent turn. If the daemon is down the\n` +
      t`connection is refused immediately; the agent does not wait.\n`,
  );

  if (!(await confirm(args.yes, tr('Apply?')))) {
    process.stdout.write(tr('Abandoned. Nothing was written.\n'));
    return 0;
  }

  const backup = writeAtomic(path, next);
  process.stdout.write(t`\nWritten: ${path}\n`);
  if (backup) process.stdout.write(t`Backup: ${backup}\n`);
  process.stdout.write(
    t`To undo: vt hooks uninstall\n` +
      t`Start a new agent session for this to take effect (existing sessions run on the old settings).\n`,
  );
  return 0;
}

function buildNext(
  state: Installed,
  path: string,
  wanted: HookEvent[],
  url: string,
  token: string,
): string {
  // Work on a fresh parse after each structural change: offsets shift, and
  // reasoning about several inserts into the same container at once is exactly
  // where a text-splice editor earns its bugs.
  let text = state.raw;
  const indent = detectIndent(text);
  const entry = entryFor(portFromUrl(url), token);

  // Drop our stale entries first so the add path is uniform.
  for (;;) {
    const root = parseWithPositions(text);
    const splice = findStaleSplice(text, root, url, token);
    if (!splice) break;
    text = applySplices(text, [splice]);
  }

  let root = parseWithPositions(text);
  if (!child(root, 'hooks')) {
    const s = appendInto(text, root, t`"hooks": {}`);
    text = applySplices(text, [s]);
    root = parseWithPositions(text);
  }

  for (const event of wanted) {
    root = parseWithPositions(text);
    const hooks = child(root, 'hooks')!;
    const existing = child(hooks, event);
    if (!existing) {
      // Rendered one level deep, with the first line indented by hand:
      // `appendInto` prefixes every line with the container's inner indent, so
      // the object needs its own extra level to sit inside the array.
      const block = indent + render({ matcher: '*', hooks: [entry] }, indent, 1);
      const s = appendInto(text, hooks, `${JSON.stringify(event)}: [\n${block}\n]`);
      text = applySplices(text, [s]);
      root = parseWithPositions(text);
      continue;
    }
    if (hasOurEntry(existing, url)) continue;
    // The event exists with someone else's hooks: append a matcher of our own
    // rather than editing theirs.
    const block = render({ matcher: '*', hooks: [entry] }, indent, 0);
    const s = appendInto(text, existing, block);
    text = applySplices(text, [s]);
  }
  return text;
}

function portFromUrl(url: string): number {
  const m = /:(\d+)\//.exec(url);
  return m ? Number(m[1]) : DEFAULT_PORT;
}

function hasOurEntry(matcherArray: JsonNode, url: string): boolean {
  for (const matcher of matcherArray.items ?? []) {
    for (const h of child(matcher, 'hooks')?.items ?? []) {
      if (child(h, VT_MARKER)?.value === true || child(h, 'url')?.value === url) return true;
    }
  }
  return false;
}

/** One splice removing a single outdated entry of ours, or null when clean. */
function findStaleSplice(
  text: string,
  root: JsonNode,
  url: string,
  token: string,
): Splice | null {
  const hooks = child(root, 'hooks');
  for (const m of hooks?.members ?? []) {
    const matchers = m.value.items ?? [];
    for (let mi = 0; mi < matchers.length; mi++) {
      const list = child(matchers[mi], 'hooks');
      const entries = list?.items ?? [];
      for (let hi = 0; hi < entries.length; hi++) {
        const h = entries[hi]!;
        const mine = child(h, VT_MARKER)?.value === true || child(h, 'url')?.value === url;
        if (!mine) continue;
        const curUrl = child(h, 'url')?.value;
        const curTok = child(child(h, 'headers'), HOOK_TOKEN_HEADER)?.value;
        if (curUrl === url && curTok === token) continue;
        return spliceOutEntry(text, root, m.key, mi, hi, entries.length, matchers.length);
      }
    }
  }
  return null;
}

/**
 * Remove one hook entry, collapsing empty containers as we go: an orphaned
 * `"Stop": [{"matcher":"*","hooks":[]}]` is not wrong, but leaving debris in
 * someone's config is its own kind of rude.
 */
function spliceOutEntry(
  text: string,
  root: JsonNode,
  event: string,
  matcherIndex: number,
  entryIndex: number,
  entryCount: number,
  matcherCount: number,
): Splice | null {
  const hooks = child(root, 'hooks')!;
  const matcherArray = child(hooks, event)!;
  const matcher = (matcherArray.items ?? [])[matcherIndex]!;
  const list = child(matcher, 'hooks')!;

  if (entryCount > 1) return removeElement(text, list, entryIndex);
  if (matcherCount > 1) return removeElement(text, matcherArray, matcherIndex);
  return removeMember(text, hooks, event);
}

// ── uninstall ─────────────────────────────────────────────────────────────

export async function uninstallHooks(args: HooksArgs): Promise<number> {
  const path = settingsFile(args);
  const url = hookUrl(args.port);
  if (!existsSync(path)) {
    process.stdout.write(t`No ${path} — so there is nothing to remove.\n`);
    return 0;
  }

  let state: Installed;
  try {
    state = inspect(path, url);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 5;
  }
  warnIfCommented(state, path);
  if (state.ours.size === 0) {
    process.stdout.write(
      t`We have no hooks here.` +
        (state.foreign ? t` (${state.foreign} hooks are yours, untouched)` : '') +
        `\n`,
    );
    return 0;
  }

  let text = state.raw;
  let removed = 0;
  for (;;) {
    const root = parseWithPositions(text);
    const splice = findAnyOursSplice(text, root, url);
    if (!splice) break;
    text = applySplices(text, [splice]);
    removed++;
    if (removed > 200) break; // structural guard against a splice that never shrinks
  }

  // If `hooks` is now empty, take it out too.
  const root = parseWithPositions(text);
  const hooks = child(root, 'hooks');
  if (hooks && (hooks.members ?? []).length === 0) {
    const s = removeMember(text, root, 'hooks');
    if (s) text = applySplices(text, [s]);
  }

  process.stdout.write(renderDiff(state.raw, text, path));
  process.stdout.write(
    t`\n${removed} entries will be removed` +
      (state.foreign ? t` · your ${state.foreign} hooks will be left alone` : '') +
      '\n',
  );
  if (!(await confirm(args.yes, tr('Apply?')))) {
    process.stdout.write(tr('Abandoned. Nothing was written.\n'));
    return 0;
  }

  const backup = writeAtomic(path, text);
  process.stdout.write(t`\nRemoved: ${path}\n`);
  if (backup) process.stdout.write(t`Backup:     ${backup}\n`);
  return 0;
}

function findAnyOursSplice(text: string, root: JsonNode, url: string): Splice | null {
  const hooks = child(root, 'hooks');
  for (const m of hooks?.members ?? []) {
    const matchers = m.value.items ?? [];
    for (let mi = 0; mi < matchers.length; mi++) {
      const list = child(matchers[mi], 'hooks');
      const entries = list?.items ?? [];
      for (let hi = 0; hi < entries.length; hi++) {
        const h = entries[hi]!;
        if (child(h, VT_MARKER)?.value === true || child(h, 'url')?.value === url) {
          return spliceOutEntry(text, root, m.key, mi, hi, entries.length, matchers.length);
        }
      }
    }
  }
  return null;
}

// ── status ────────────────────────────────────────────────────────────────

export async function statusHooks(args: HooksArgs): Promise<number> {
  const path = settingsFile(args);
  const url = hookUrl(args.port);
  const token = readHookToken();

  let state: Installed;
  try {
    state = inspect(path, url);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 5;
  }

  warnIfCommented(state, path);
  process.stdout.write(t`\nSettings file: ${path}\n`);
  process.stdout.write(t`Hook URL     : ${url}\n\n`);

  if (state.ours.size === 0) {
    process.stdout.write(tr('Not installed. Install with `vt hooks install`.\n'));
    process.stdout.write(
      tr('Without hooks, "waiting for permission" is inferred rather than measured — the dashboard marks it with `?`.\n\n'),
    );
    return 0;
  }

  const wanted = eventsFor(args);
  for (const e of wanted) {
    const cur = state.ours.get(e);
    const mark = !cur ? '·' : cur.token === token ? '✔' : '!';
    const note = !cur ? tr('not installed') : cur.token === token ? 'kurulu' : tr('stale token — refresh');
    process.stdout.write(` ${mark} ${e.padEnd(20)} ${note}\n`);
  }
  const extra = [...state.ours.keys()].filter((e) => !wanted.includes(e));
  for (const e of extra) {
    process.stdout.write(t` ! ${e.padEnd(20)} installed but no longer in use\n`);
  }
  if (state.foreign > 0) {
    process.stdout.write(t`\nYou have ${state.foreign} hooks of your own; they are never touched.\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── shared helpers ────────────────────────────────────────────────────────

/**
 * Atomic replace, with a backup kept beside the original.
 *
 * Writing in place risks a half-written settings file if the process dies
 * mid-write — and a truncated `settings.json` is a broken agent, not a broken
 * dashboard. Write a sibling, then rename, which is atomic on the same volume.
 */
function writeAtomic(path: string, text: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.vtbak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.vttmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return backup;
}

async function confirm(yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      t`\nCannot ask for confirmation (no terminal). To apply this deliberately, add --yes.\n`,
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [e/H] `)).trim().toLowerCase();
    return a === 'e' || a === 'evet' || a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * A line diff, because the user is being asked to approve a change to their
 * own file and "trust me" is not an acceptable prompt.
 */
function renderDiff(before: string, after: string, path: string): string {
  const useColor =
    process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const green = (s: string): string => (useColor ? `\u001b[32m${s}\u001b[0m` : s);
  const red = (s: string): string => (useColor ? `\u001b[31m${s}\u001b[0m` : s);
  const dim = (s: string): string => (useColor ? `\u001b[2m${s}\u001b[0m` : s);

  const a = before.split('\n');
  const b = after.split('\n');
  // Common prefix and suffix are enough: our edits are contiguous inserts and
  // deletes, so a full LCS would render the same hunk with more code.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const out: string[] = ['', dim(`--- ${path}`)];
  const ctx = 2;
  for (let i = Math.max(0, head - ctx); i < head; i++) out.push(dim(`  ${a[i]}`));
  for (let i = head; i < a.length - tail; i++) out.push(red(`- ${a[i]}`));
  for (let i = head; i < b.length - tail; i++) out.push(green(`+ ${b[i]}`));
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + ctx); i++) {
    out.push(dim(`  ${a[i]}`));
  }
  return out.join('\n') + '\n';
}
