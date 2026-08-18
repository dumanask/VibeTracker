/**
 * Directory discovery. No path is ever hardcoded to one machine — every
 * location is derived from environment or platform convention, so the tool
 * works on a computer it has never seen.
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const HOME = homedir();
const PLAT = platform();

/**
 * Where Claude Code keeps its state.
 * Documented override: when CLAUDE_CONFIG_DIR is set, transcripts live under
 * `$CLAUDE_CONFIG_DIR/projects/` instead of `~/.claude/projects/`.
 */
export function claudeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(HOME, '.claude');
}

/** VibeTracker's own data (db, logs). Never inside the agent's directory. */
export function dataDir(): string {
  if (PLAT === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'VibeTracker');
  }
  if (PLAT === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'VibeTracker');
  }
  return join(process.env.XDG_DATA_HOME ?? join(HOME, '.local', 'share'), 'vibetracker');
}

/** VibeTracker's config.toml. */
export function configDir(): string {
  if (PLAT === 'win32') {
    return join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'VibeTracker');
  }
  if (PLAT === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'VibeTracker');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), 'vibetracker');
}

/**
 * Candidate "User" directories for VS Code and its forks. Returned as
 * candidates rather than a single answer because a machine can have several
 * (stable + Insiders + Cursor) and we cannot know which is in use.
 */
export function vscodeUserDirs(): Array<{ id: string; dir: string }> {
  // Every fork that ships an agent, by the directory name it actually uses.
  // Antigravity and Trae each install two -- an IDE build and a standalone one
  // -- and both of each were found on the reference machine, so both are listed
  // rather than guessed at from the product name.
  const variants = [
    { id: 'code', name: 'Code' },
    { id: 'code-insiders', name: 'Code - Insiders' },
    { id: 'cursor', name: 'Cursor' },
    { id: 'vscodium', name: 'VSCodium' },
    { id: 'windsurf', name: 'Windsurf' },
    { id: 'antigravity', name: 'Antigravity' },
    { id: 'antigravity-ide', name: 'Antigravity IDE' },
    { id: 'trae', name: 'Trae' },
    { id: 'trae-solo', name: 'TRAE SOLO' },
  ];
  const base = (name: string): string => {
    if (PLAT === 'win32') {
      return join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), name, 'User');
    }
    if (PLAT === 'darwin') return join(HOME, 'Library', 'Application Support', name, 'User');
    return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), name, 'User');
  };
  return variants
    .map((v) => ({ id: v.id, dir: base(v.name) }))
    .filter((c) => existsSync(c.dir));
}

/** State directories of the other agent CLIs we can adapt to. */
export function otherAgentDirs(): Array<{ id: string; dir: string }> {
  const share = (name: string): string =>
    PLAT === 'win32'
      ? join(HOME, '.local', 'share', name)
      : join(process.env.XDG_DATA_HOME ?? join(HOME, '.local', 'share'), name);
  const candidates = [
    { id: 'codex', dir: join(HOME, '.codex') },
    { id: 'gemini', dir: join(HOME, '.gemini') },
    { id: 'cursor', dir: join(HOME, '.cursor') },
    { id: 'cline', dir: join(HOME, '.cline') },
    { id: 'opencode', dir: share('opencode') },
    // Kilo is an opencode fork and keeps the same schema in the same layout.
    { id: 'kilo', dir: share('kilo') },
  ];
  return candidates.filter((c) => existsSync(c.dir));
}
