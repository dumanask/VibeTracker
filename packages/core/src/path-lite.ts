/**
 * The minimum path normalization needed by pure domain logic.
 *
 * `core` must stay free of I/O so it can be unit-tested without a filesystem;
 * the full implementation (realpath resolution, storage classification,
 * case-sensitivity probing) lives in `@vibetracker/platform`. This is the same
 * textual rule, duplicated deliberately rather than creating a dependency from
 * domain logic onto the platform layer.
 */
export function normPath(p: string): string {
  if (!p) return '';
  let s = p.normalize('NFC').replace(/\\/g, '/');
  const isUnc = s.startsWith('//');
  if (isUnc) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (isUnc) s = '//' + s;
  s = s.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}
