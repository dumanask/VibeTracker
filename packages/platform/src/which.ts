/**
 * Is this program on the machine?
 *
 * Asked in two places, for the same reason. `vt init` offers "the LLM you
 * already have" as an answer, and that offer is only honest if the list is
 * the programs actually installed rather than the programs somebody imagined.
 * `vt doctor` asks it afterwards, because a configured provider that names a
 * command nobody can run should say so before the day somebody needs the
 * summary.
 *
 * A PATH lookup, not a search. Nothing walks the disk, nothing is executed,
 * and a name with a separator in it is checked exactly where it points — this
 * resolves what the shell would resolve and nothing else.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * The extensions Windows will append to a bare name, in order.
 *
 * Not including the empty string, and that is the whole point. npm installs
 * both `codex` (a shell script for Git Bash) and `codex.cmd` next to each
 * other; an empty extension matches the first, which `cmd.exe` will not run —
 * so reporting it would name a file that cannot be executed by the thing that
 * is about to execute it.
 */
function extensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter(Boolean);
}

function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * As it is spelled on disk.
 *
 * `PATHEXT` is conventionally uppercase, so a match built from it names a real
 * file with the wrong capitalisation — `claude.CMD`. Windows does not care and
 * the string is shown to a person, who does. The native realpath answers with
 * the filesystem's own casing; anything that fails here keeps the path that
 * already resolved.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The absolute path the shell would run, or null.
 *
 * Case is never folded by hand here: `PATH` entries are compared by the
 * filesystem, and folding them ourselves would be this codebase's own locale
 * trap in miniature.
 */
export function whichCommand(name: string): string | null {
  const wanted = name.trim();
  if (!wanted) return null;

  const exts = extensions();
  // A path rather than a bare name — `./bin/summarise`, `C:\tools\x.exe` — is
  // not looked up anywhere. It either is what it says or it is nothing. The
  // literal spelling is tried first, because a path the user wrote in full
  // usually already carries its extension.
  if (wanted.includes('/') || wanted.includes('\\')) {
    const abs = isAbsolute(wanted) ? wanted : resolve(wanted);
    for (const ext of ['', ...exts]) {
      if (runnable(abs + ext)) return canonical(abs + ext);
    }
    return null;
  }

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    // Windows PATH entries are quoted often enough to be worth undoing.
    const clean = dir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = join(clean, wanted + ext);
      if (runnable(candidate)) return canonical(candidate);
    }
  }
  return null;
}

/** Whether it is there at all. */
export function hasCommand(name: string): boolean {
  return whichCommand(name) !== null;
}
