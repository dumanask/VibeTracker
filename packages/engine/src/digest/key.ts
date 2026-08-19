/**
 * Where the API key comes from, and where it must never be.
 *
 * Never in `config.toml`. That file is plain text a person edits by hand,
 * keeps in a dotfiles repository, screenshots into a bug report, and hands to
 * `vt doctor --bundle`. A key in it is a key in all of those. So the config
 * holds the *name* of an environment variable, and the value is looked up at
 * the moment it is needed.
 *
 * Environment variables are not always convenient — a desktop app started from
 * the Start menu inherits an environment nobody chose — so there is a second
 * route: a 0600 file in the data directory, written by `vt digest key`. It is
 * on the diagnostics deny-list by name, for the same reason
 * `.credentials.json` is.
 *
 * Precedence is env first. Whoever has bothered to export a variable meant it,
 * and a stale file quietly winning over it is the kind of surprise that ends
 * with somebody's other key being billed.
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@vibetracker/platform';
import { DEFAULT_KEY_ENV, type ProviderId } from './provider.ts';

export function keyFilePath(): string {
  return join(dataDir(), 'digest-key');
}

export interface KeySource {
  key: string | null;
  /** Where it came from, for saying so without saying what it is. */
  from: 'env' | 'file' | 'none';
  /** The variable that was read, when it was an environment one. */
  envName?: string;
}

/**
 * Resolve the key without ever returning it by accident.
 *
 * `configuredEnv` is `[digest] api_key_env`; empty falls back to the family's
 * usual variable. A provider that needs no key resolves to `none`, which is a
 * complete answer rather than a failure.
 */
export function resolveKey(provider: ProviderId, configuredEnv: string): KeySource {
  const name = configuredEnv.trim() || DEFAULT_KEY_ENV[provider] || '';
  if (name) {
    const v = process.env[name]?.trim();
    if (v) return { key: v, from: 'env', envName: name };
  }
  try {
    const v = readFileSync(keyFilePath(), 'utf8').trim();
    if (v) return { key: v, from: 'file' };
  } catch {
    /* absent, which is the normal case */
  }
  return { key: null, from: 'none', envName: name || undefined };
}

/** Write the key file at 0600. Returns the path so the caller can name it. */
export function writeKeyFile(key: string): string {
  const path = keyFilePath();
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path, key.trim() + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not all filesystems honour this */
  }
  return path;
}

/** Remove it. Returns whether there was one. */
export function clearKeyFile(): boolean {
  try {
    unlinkSync(keyFilePath());
    return true;
  } catch {
    return false;
  }
}

/**
 * A key, shown.
 *
 * Four characters at each end is enough to answer "is this the key I think it
 * is" and not enough to be one. Short strings are shown as their length alone,
 * because masking a twelve-character secret to eight characters is not masking.
 */
export function maskKey(key: string): string {
  if (key.length < 16) return `«${key.length} karakter»`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length})`;
}
