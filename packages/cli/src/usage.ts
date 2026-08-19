/**
 * The help text, as rows rather than as one block.
 *
 * The first version was a single tagged template, which made the entire help
 * one catalog key. That works right up until a command is added: the key
 * changes, every language loses its whole help text at once, and the coverage
 * test correctly reports the lot as untranslated. Invalidating one row when
 * one row changes is the behaviour worth having.
 *
 * Two rules follow from how translation is checked:
 *
 * 1. **Every description is a literal inside `tr(...)`.** The second version
 *    kept the strings in a table and called `tr(desc)` in the formatter. The
 *    static key scanner sees only literals, so it found nothing, the coverage
 *    test passed, and every row printed in Turkish under `--lang en`. A
 *    lookup the scanner cannot see is a lookup nobody will notice is broken.
 * 2. **Every table is a function.** Module bodies run before the language is
 *    resolved; a constant would capture the source language and no amount of
 *    correct catalog data would change what prints.
 *
 * The left column is never translated — `vt doctor --bundle` is the same in
 * every language — and the alignment is computed rather than typed.
 */
import { t, tr } from '@vibetracker/core';

type Row = [invocation: string, description: string];

const commands = (): Row[] => [
  ['vt init', tr('First-run setup — your disk is never scanned')],
  [`vt status [${tr('options')}]`, tr('One-shot snapshot of every agent session')],
  ['vt daemon [--open]', tr('Continuous watch + live web dashboard')],
  ['vt daemon stop', tr("Stop a running daemon cleanly")],
  ['vt open', tr("Open a running daemon's dashboard in the browser")],
  ['vt mini', tr('Sticky-note window — small, stays on top')],
  ['vt doctor [--json]', tr('What works and what does not, on this machine')],
  [`vt doctor --bundle [${tr('file')}]`, tr('Shareable diagnostic bundle (allowlist-based)')],
  [`vt config <${tr('subcommand')}>`, tr('Show/validate configuration (show|path|check)')],
  [`vt hooks <${tr('subcommand')}>`, tr('Exact permission/turn detection (install|uninstall|status)')],
  [`vt autostart <${tr('subcommand')}>`, tr("Start the daemon at log on (install|uninstall|status)")],
  ['vt uninstall [--keep-data]', tr('Undo everything, and print what was undone')],
  // A distinct key from the `proje` stat label: the same Turkish word is a
  // singular metavariable here and a plural count there, and one catalog
  // entry cannot be both.
  [`vt board [${tr('project')}]`, tr('Phase board — a timeline mined from commit history')],
  [`vt projects [${tr('subcommand')}]`, tr('Choose which projects to track (list|add|rm|all)')],
  [`vt digest [${tr('project')}]`, tr('LLM summary — phase name, blocker, next action (off by default)')],
  ['vt digest providers', tr('Which LLM is in use, and which ones you can choose')],
  ['vt digest key <anahtar>', tr("Write the API key to a 0600 file (never written to the config)")],
  ['vt demo [--all]', tr('The dashboard on synthetic data — real state is never touched')],
  ['vt lang [missing]', tr('Translation status; list untranslated strings')],
  ['vt --help', tr('This help')],
];

const miniOptions = (): Row[] => [
  ['vt mini full|shade|badge', tr('Open in one of the three sizes')],
  ['vt mini unpin', tr('Close the open window')],
  ['--browser', tr('Use the browser window instead of the native one')],
  ['--size <gxy>', tr('Browser window size, e.g. 360x260')],
  ['--at <x,y>', tr('Position on screen')],
  ['--no-pin', tr('Open it but do not keep it on top')],
];

const options = (): Row[] => [
  [`--html <${tr('file')}>`, tr('Write a self-contained HTML snapshot')],
  ['--json', tr('Print the report as JSON (machine readable)')],
  ['--full', tr('Per-session detail instead of the compact list')],
  ['--every', tr('Ignore the tracking selection and show every project')],
  ['--all', tr('Include dead/orphaned sessions')],
  ['--temp', tr('Include temporary/scratch working directories')],
  ['--quick', tr('Skip CPU sampling (weakens "thinking vs stalled")')],
  ['--tail <kb>', tr('Transcript tail window, KB (default 256)')],
  ['--signal-waiting', tr('Exit 10 when a session is waiting')],
  ['--lang <tr|en>', tr("Language for this run (overrides VT_LANG and the config)")],
  ['--dry-run', tr('vt digest: show the text that would be sent, do not send it')],
  ['--version, -V', tr('Version, platform and Node version — include this when reporting a bug')],
];

const daemonOptions = (): Row[] => [
  ['--open', tr('Open the dashboard once started')],
  ['--port <n>', tr('Port to listen on (default 47823)')],
  ['--interval <ms>', tr('Scan interval (default 3000)')],
];

const hookOptions = (): Row[] => [
  ['--yes', tr("Show the diff but do not ask (for scripts)")],
  ['--high-fidelity', tr('Also bind PreToolUse/PostToolUse (high volume, off by default)')],
];

const initOptions = (): Row[] => [
  ['--yes', tr('Ask nothing, accept the safe defaults')],
  ['--force', tr('Re-run setup over an existing configuration')],
];

const uninstallOptions = (): Row[] => [
  ['--keep-data', tr('Keep the database, log and config (only detach from the system)')],
];

const exitCodes = (): Row[] => [
  ['0', tr('success')],
  ['1', tr('doctor: a check failed')],
  ['2', tr('usage error')],
  ['3', tr('daemon already running / not running')],
  ['4', tr('port held by something else')],
  ['10', tr('a session is waiting (only with --signal-waiting)')],
  ['70', tr('unexpected error')],
];

/**
 * Align on the widest invocation, so a longer command never breaks the layout.
 * The descriptions arrive already translated — see rule 1 above.
 */
function block(rows: Row[], indent = '  '): string {
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([left, desc]) => `${indent}${left.padEnd(width)}  ${desc}`).join('\n');
}

export function usage(): string {
  return [
    t`vt — VibeTracker`,
    '',
    block(commands()),
    '',
    tr('Options'),
    block(options()),
    '',
    tr('daemon options'),
    block(daemonOptions()),
    '',
    tr('hooks options'),
    block(hookOptions()),
    '',
    tr('init options'),
    block(initOptions()),
    '',
    tr('uninstall options'),
    block(uninstallOptions()),
    '',
    tr('mini options'),
    block(miniOptions()),
    '',
    tr('Exit codes'),
    block(exitCodes()),
    '',
    tr('VibeTracker never writes to your projects, never talks to an agent, never goes online.'),
    '',
  ].join('\n');
}
