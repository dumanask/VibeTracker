/**
 * The adapter registry.
 *
 * Claude Code is deliberately *not* here. Its reader is the scan itself — the
 * registry, the IDE locks, the transcript index, the CPU sampling and the
 * process tree are all built around what it publishes, and pretending it is one
 * adapter among six would mean either flattening it down to what the others can
 * do or widening the interface until it describes only Claude Code. What is
 * shared instead is the part that matters: every adapter produces
 * `TranscriptFacts`, and `deriveState` decides.
 *
 * Which adapters run is the user's call, through `[agents] enabled`. The default
 * is every agent whose state directory exists — someone who installed Codex and
 * VibeTracker on the same machine did not do that hoping to configure something.
 */
import type { TailReader } from '../tail.ts';
import { createCodexAdapter } from './codex.ts';
import { createSqliteAgentAdapter, opencodeSpecs, closeSqliteAgents } from './opencode.ts';
import { createClineAdapter, closeCline } from './cline.ts';
import { createGeminiAdapter, createIdeAdapters } from './ide.ts';
import type { AgentAdapter } from './types.ts';

export * from './types.ts';
export { applyCodexLines, codexDir } from './codex.ts';
export { pathFromFileUri } from './ide.ts';
export { noteText } from './notes.ts';
export { opencodeSpecs } from './opencode.ts';

/**
 * Every adapter this build knows, whether or not its agent is installed.
 *
 * `detect()` is what answers "installed"; building the list unconditionally is
 * what lets `vt doctor` say "Codex: not found" instead of silently omitting it.
 * The IDE forks are the exception — those are enumerated from the directories
 * that exist, because the list of forks is open-ended and a row for every
 * editor nobody has is noise, not honesty.
 */
export function allAdapters(tail: () => TailReader): AgentAdapter[] {
  return [
    createCodexAdapter(tail),
    ...opencodeSpecs().map(createSqliteAgentAdapter),
    createClineAdapter(),
    createGeminiAdapter(),
    ...createIdeAdapters(),
  ];
}

/**
 * The adapters to actually read from.
 *
 * `enabled` comes from config. `claude-code` in that list is ignored here: it is
 * never an adapter, and its absence from this function is not a bug.
 */
export function enabledAdapters(
  tail: () => TailReader,
  enabled: readonly string[] | undefined,
): AgentAdapter[] {
  const all = allAdapters(tail);
  if (!enabled) return all;
  const want = new Set(enabled);
  // `all` is a shorthand for "whatever is installed", so a user does not have
  // to list nine ids to say yes.
  if (want.has('all')) return all;
  return all.filter((a) => want.has(a.id));
}

/** Release every handle the adapters hold. Called when the scan context closes. */
export function closeAdapters(): void {
  closeSqliteAgents();
  closeCline();
}
