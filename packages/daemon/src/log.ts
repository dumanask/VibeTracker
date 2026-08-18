import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '@vibetracker/core';

/**
 * Minimal file logging.
 *
 * This exists because of autostart: a daemon launched by the scheduler at logon
 * has no console, so everything it says — including the watchdog explaining why
 * it killed itself — would otherwise go nowhere. A background process that can
 * fail invisibly is worse than one that does not start at all.
 *
 * Deliberately small: no levels, no JSON, no dependencies. Structured logging
 * arrives with the config file in M4. What matters now is that the bytes land
 * somewhere a person can read.
 *
 * Never log prompts, transcript text, or file contents — the log is one of the
 * surfaces the privacy model has to hold.
 *
 * That rule used to be a convention, and conventions are kept by whoever
 * remembers them. It was already broken in two places, both of them the same
 * mistake: `String(err)` on a filesystem failure, and an agent's error text
 * arriving through a hook. Neither is a prompt, and both can carry one.
 *
 * So redaction runs here, at the single point every line goes through, rather
 * than at each call site. The cost is one regex pass on a handful of lines a
 * run; the alternative is a guarantee that holds until the next person adds a
 * log statement.
 */

let target: string | null = null;

/** One rotation, so an unattended daemon cannot fill a disk with its own log. */
const MAX_BYTES = 4 * 1024 * 1024;

export function enableFileLog(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    target = path;
    rotateIfBig();
  } catch {
    target = null; // Logging must never be the reason the daemon fails to start.
  }
}

export function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${redact(line)}`;
  process.stderr.write(stamped + '\n');
  if (!target) return;
  try {
    appendFileSync(target, stamped + '\n', 'utf8');
  } catch {
    /* disk full, permissions, file locked — none of it is worth crashing over */
  }
}

function rotateIfBig(): void {
  if (!target) return;
  try {
    if (statSync(target).size > MAX_BYTES) renameSync(target, target + '.1');
  } catch {
    /* absent or unrotatable */
  }
}

export function logPath(): string | null {
  return target;
}
