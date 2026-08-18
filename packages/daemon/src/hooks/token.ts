import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@vibetracker/platform';
import { generateToken } from '../security.ts';

/**
 * The hook token is separate from the dashboard token, and stable.
 *
 * The dashboard token is regenerated every time the daemon starts — it lives in
 * a URL that we print, so rotating it is free. The hook token cannot work that
 * way: it is written into the user's `settings.json`, and a token that changed
 * on restart would silently break every hook until they reinstalled. Worse, it
 * would break them *quietly* — the agent would keep POSTing and keep getting
 * 401s, and the dashboard would just look like hooks never fire.
 *
 * So this one is generated once and persisted at 0600. On Windows the mode bits
 * are advisory, but the file also sits under the user's own LOCALAPPDATA.
 */
export function hookTokenPath(): string {
  return join(dataDir(), 'hook-token');
}

export function loadOrCreateHookToken(): string {
  const path = hookTokenPath();
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

/** Read without creating — used by `vt hooks status` and `vt doctor`. */
export function readHookToken(): string | null {
  try {
    const t = readFileSync(hookTokenPath(), 'utf8').trim();
    return t.startsWith('vt_') ? t : null;
  } catch {
    return null;
  }
}
