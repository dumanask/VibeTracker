/**
 * Suppress exactly one warning: node:sqlite's experimental notice.
 *
 * This lives in its own module because ES module imports are hoisted and
 * evaluated before any top-level statement in the importing file. Putting the
 * override next to `import { DatabaseSync } from 'node:sqlite'` therefore runs
 * it too late — the warning has already fired. A module imported *before* the
 * sqlite import is evaluated first, which is early enough.
 *
 * Scoped to this one message on purpose. A blanket `--no-warnings` would also
 * hide deprecations and real problems, and a tool other people install should
 * neither print scary notices about its own internals nor silence genuine ones.
 */
const original = process.emitWarning;

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
