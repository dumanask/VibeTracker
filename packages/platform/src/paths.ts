/**
 * Path normalization.
 *
 * Two traps this file exists to avoid:
 *
 * 1. Unicode form. macOS APFS/HFS+ hands back decomposed (NFD) filenames while
 *    Windows and Linux typically use composed (NFC). The same project would
 *    otherwise appear twice — once per form. Everything is normalized to NFC
 *    at the boundary.
 *
 * 2. Locale casing. `String.prototype.toLowerCase()` is locale-INDEPENDENT by
 *    specification and is safe. The dangerous operations are
 *    `toLocaleLowerCase()` / `toLocaleUpperCase()`: under a Turkish locale
 *    `'I'.toLocaleLowerCase('tr')` is `'ı'` (U+0131, dotless) and
 *    `'i'.toLocaleUpperCase('tr')` is `'İ'` (U+0130). Code using them breaks
 *    *only on Turkish machines* — the worst possible failure distribution,
 *    since that is the author's machine and nobody else's. They are banned
 *    project-wide; `fold()` below is the only permitted folding.
 */
import { platform } from 'node:os';
import { realpathSync } from 'node:fs';

const PLAT = platform();

/**
 * The only case-folding permitted for matching, map keys, and comparison.
 * NFKC so that compatibility forms (full-width characters from a document
 * pasted out of Word, ligatures) match their plain equivalents.
 */
export function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** Lowercase ASCII A-Z and nothing else. Used where only the drive letter matters. */
export function asciiLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/**
 * Canonical textual form of a path: NFC, forward slashes, lowercased drive
 * letter, no trailing separator, no doubled separators (UNC prefix preserved).
 */
export function normPath(p: string): string {
  if (!p) return '';
  let s = p.normalize('NFC').replace(/\\/g, '/');

  const isUnc = s.startsWith('//');
  if (isUnc) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (isUnc) s = '//' + s;

  // Drive letter only — never the whole path.
  s = s.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);

  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * Map key for path identity. On case-insensitive filesystems two spellings are
 * the same path, so the key folds case; on Linux it does not.
 *
 * Note: Windows and APFS use their own case tables, which do not agree with
 * Unicode full case folding in every corner. `fold()` is the pragmatic choice
 * and is correct for every case difference actually observed in agent state.
 */
export function pathKey(p: string): string {
  const n = normPath(p);
  return PLAT === 'linux' ? n : fold(n);
}

/** Resolve symlinks/junctions where possible; fall back to the input. */
export function realPathSafe(p: string): string {
  try {
    return normPath(realpathSync(p));
  } catch {
    return normPath(p);
  }
}

/**
 * Classify storage so we can back off on anything that may be remote or is
 * throwaway. Reading a cloud placeholder can block for seconds; scratch dirs
 * are noise that would otherwise dominate a first run.
 */
export function classifyStorage(
  p: string,
): 'local' | 'cloud' | 'temp' | 'network' | 'wsl' {
  const n = fold(normPath(p));
  if (n.startsWith('//')) return 'network';
  if (n.startsWith('/mnt/') && /^\/mnt\/[a-z]\//.test(n)) return 'wsl';
  if (
    /\/appdata\/local\/temp\//.test(n) ||
    /^\/tmp\//.test(n) ||
    /^\/private\/var\/folders\//.test(n) ||
    /\/\.cache\//.test(n) ||
    /\/appdata\/roaming\/[^/]*\/workspaces\//.test(n)
  ) {
    return 'temp';
  }
  if (/\/onedrive[^/]*\//.test(n) || /\/dropbox\//.test(n) || /\/library\/mobile documents\//.test(n)) {
    return 'cloud';
  }
  return 'local';
}

/** Directories whose churn is build output, not authored work. */
const BUILD_DIRS = [
  'node_modules/', 'target/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/',
  '.svelte-kit/', '.turbo/', 'obj/', 'bin/debug/', 'bin/release/', '__pycache__/',
  '.venv/', 'venv/', 'coverage/', '.gradle/', '.parcel-cache/', '.pytest_cache/',
];

/**
 * A large dirty count means "hot work in progress" only if the dirt is authored
 * files. A repo with 500 dirty paths under `target/` is not busy, it is just
 * missing a gitignore — flagging it as hot would push it to the top of the
 * attention list forever.
 */
export function isBuildNoise(relPaths: string[]): boolean {
  if (relPaths.length === 0) return false;
  let noise = 0;
  for (const raw of relPaths) {
    const p = fold(raw.replace(/\\/g, '/'));
    if (BUILD_DIRS.some((d) => p.startsWith(d) || p.includes('/' + d))) noise++;
  }
  return noise / relPaths.length > 0.8;
}
