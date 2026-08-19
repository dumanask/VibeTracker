import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@vibetracker/platform';
import { generateToken } from './security.ts';

/**
 * The two bearer tokens, both persisted, and why neither may be rotated on a
 * restart.
 *
 * The hook token was always stable, for an obvious reason: it is written into
 * the user's `settings.json`, and a token that changed on restart would leave
 * every hook POSTing into a 401 while the dashboard simply looked as though
 * hooks never fire.
 *
 * The dashboard token used to be minted fresh on every start, on the argument
 * that it lives in a URL we print and printing it again is free. **That
 * argument was wrong, and it was the bug behind "klasör seç says there are no
 * projects".** It is only true for a surface that is opened after the daemon
 * comes up and closed before it goes down — a terminal printing a link. Every
 * other surface holds the token for as long as it lives:
 *
 * - the post-it takes it as a command-line argument at launch and keeps it for
 *   the life of the window,
 * - the desktop shell bakes it into the panel window's URL when it opens it,
 * - a browser tab has it inlined into the page it was served.
 *
 * Measured on this machine: the note was launched at 21:19 and the daemon
 * restarted at 21:48. From that moment every call the note made returned 401,
 * and because its chooser reported a failed fetch as an empty list, the window
 * said "no projects found" — asserting a fact about the user's projects when
 * what had actually happened was that it had been locked out. The daemon
 * restarts on its own (the watchdog exits rather than hang), so this is not an
 * unusual state; it is the state after any long session.
 *
 * So both are generated once and persisted at 0600. On Windows the mode bits
 * are advisory, but the file also sits under the user's own LOCALAPPDATA.
 *
 * **Rotating one is deleting the file.** The next start mints a new one; the
 * hook token additionally needs `vt hooks install` again, because that one has
 * a copy in `settings.json`.
 */
function tokenPath(name: string): string {
  return join(dataDir(), name);
}

function loadOrCreate(name: string): string {
  const path = tokenPath(name);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.startsWith('vt_') && existing.length > 20) return existing;
  } catch {
    /* absent or unreadable — make a new one */
  }
  const token = generateToken();
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path, token + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not all filesystems honour this */
  }
  return token;
}

function readOnly(name: string): string | null {
  try {
    const t = readFileSync(tokenPath(name), 'utf8').trim();
    return t.startsWith('vt_') ? t : null;
  } catch {
    return null;
  }
}

export function hookTokenPath(): string {
  return tokenPath('hook-token');
}

export function loadOrCreateHookToken(): string {
  return loadOrCreate('hook-token');
}

/** Read without creating — used by `vt hooks status` and `vt doctor`. */
export function readHookToken(): string | null {
  return readOnly('hook-token');
}

export function apiTokenPath(): string {
  return tokenPath('api-token');
}

export function loadOrCreateApiToken(): string {
  return loadOrCreate('api-token');
}

export function readApiToken(): string | null {
  return readOnly('api-token');
}
