/**
 * VS Code and its forks: Code, Cursor, Antigravity, Trae, Windsurf, VSCodium.
 * Plus Gemini, which is a different shape but has the same ceiling.
 *
 * These adapters offer **directories, not sessions**, and that is the whole
 * design decision.
 *
 * What is readable is `workspaceStorage/<hash>/workspace.json`, one per window
 * the editor has ever opened, holding a `file://` URI of the folder. Measured on
 * this machine: Code 59, Antigravity 30, Trae 15, Cursor 10 — 117 folders in
 * total. Turning those into board rows would bury five projects anyone is
 * actually working in under a hundred they opened once, and every one of those
 * rows would be a session that does not exist.
 *
 * So they feed the project chooser: "you have worked here, do you want it
 * tracked". A folder that was open in an editor is a real fact and a useful one.
 * A session is a different claim and none of these can support it.
 *
 * The agent conversations *are* in `state.vscdb` — Cursor keeps
 * `composer.composerData`, `aiService.generations`,
 * `workbench.panel.composerChatViewPane.<uuid>` in an opaque `ItemTable` of
 * JSON blobs. That is readable and deliberately not read: the keys are
 * undocumented, per-fork, and change without notice, and every one of them is a
 * blob of conversation text — exactly the thing this tool does not copy. Turn
 * state bought that way would be the most fragile and least private data on the
 * board.
 *
 * Two shapes appear in `workspace.json`. `folder` is a directory and is what we
 * want. `workspace` points at a `.code-workspace` *file* — a multi-root
 * definition, and on this machine it points into `AppData\Roaming\Code\User`,
 * which is not a project. Only `folder` is read.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { vscodeUserDirs } from '@vibetracker/platform';
import type {
  AdapterContext,
  AgentAdapter,
  AgentProjectHint,
  DetectResult,
  ObservedSession,
} from './types.ts';

/** The editors that ship an agent and therefore belong on this list. */
const NAMES: Record<string, string> = {
  code: 'VS Code / Copilot',
  'code-insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  vscodium: 'VSCodium',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  'antigravity-ide': 'Antigravity IDE',
  trae: 'Trae',
  'trae-solo': 'Trae SOLO',
};

/**
 * `file:///c%3A/Users/...` to a real path.
 *
 * Percent-decoded first, then the leading slash before a drive letter is
 * dropped: `/c:/dev/x` is not a path any Windows API accepts. Everything else
 * is left exactly as the editor wrote it, including case — folding it here
 * would be guessing, and `pathKey` is where that decision belongs.
 */
export function pathFromFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
  if (p.startsWith('/') && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p.length > 0 ? p : null;
}

async function foldersOf(userDir: string): Promise<AgentProjectHint[]> {
  const storage = join(userDir, 'workspaceStorage');
  let hashes: string[];
  try {
    hashes = await readdir(storage);
  } catch {
    return [];
  }
  const out = await Promise.all(
    hashes.map(async (h): Promise<AgentProjectHint | null> => {
      const file = join(storage, h, 'workspace.json');
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as { folder?: unknown };
        if (typeof raw.folder !== 'string') return null;
        const path = pathFromFileUri(raw.folder);
        if (!path) return null;
        // The directory's own mtime, not the json's: the editor rewrites
        // `workspace.json` rarely, but touches the storage folder as the window
        // is used.
        let lastSeenAt = 0;
        try {
          lastSeenAt = (await stat(join(storage, h))).mtimeMs;
        } catch {
          /* keep 0 */
        }
        return { agentKind: '', path, lastSeenAt };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((h): h is AgentProjectHint => h !== null);
}

/** One adapter per installed editor, so `vt doctor` can name each. */
export function createIdeAdapters(): AgentAdapter[] {
  return vscodeUserDirs().map((v) => {
    const id = v.id;
    const displayName = NAMES[id] ?? id;
    return {
      id,
      displayName,
      capabilities: {
        // No session claim at all. See the note at the top of this file: the
        // conversations exist in `state.vscdb` and reading them would be both
        // fragile and a privacy regression.
        sessions: false,
        liveProcess: false,
        turnState: false,
        openTools: false,
        todos: false,
      },
      async detect(): Promise<DetectResult> {
        const folders = await foldersOf(v.dir);
        return {
          installed: true,
          hasData: folders.length > 0,
          lastActivityAt: folders.reduce((a, f) => Math.max(a, f.lastSeenAt), 0),
          dir: v.dir,
          note: 'folders-only',
        };
      },
      async listSessions(_ctx: AdapterContext): Promise<ObservedSession[]> {
        return [];
      },
      async listProjectHints(): Promise<AgentProjectHint[]> {
        return (await foldersOf(v.dir)).map((h) => ({ ...h, agentKind: id }));
      },
    };
  });
}

/**
 * Gemini / Antigravity CLI.
 *
 * `~/.gemini/projects.json` is a flat map of path to name. Two things about it
 * are worth writing down: the paths are **lower-cased** (`c:\users\askim\
 * onedrive\masaüstü\business\projectbsh`), and they keep their Turkish
 * characters. Neither is a problem downstream — identity goes through `realpath`
 * and a git root commit, and the display name comes from git rather than from
 * this file — but a reader that compared these strings to anything would get it
 * wrong, so it does not.
 *
 * There is more here (`antigravity-cli/conversations`, `history.jsonl`,
 * `conversation_summaries.db`) and none of it is read yet, so no session is
 * claimed.
 */
export function createGeminiAdapter(): AgentAdapter {
  const dir = join(homedir(), '.gemini');
  const file = join(dir, 'projects.json');

  const hints = async (): Promise<AgentProjectHint[]> => {
    try {
      const st = await stat(file);
      const raw = JSON.parse(await readFile(file, 'utf8')) as { projects?: unknown };
      const projects = raw.projects;
      if (!projects || typeof projects !== 'object') return [];
      return Object.keys(projects as Record<string, unknown>)
        .filter((p) => p.length > 0)
        .map((path) => ({ agentKind: 'gemini', path, lastSeenAt: st.mtimeMs }));
    } catch {
      return [];
    }
  };

  return {
    id: 'gemini',
    displayName: 'Gemini',
    capabilities: {
      sessions: false,
      liveProcess: false,
      turnState: false,
      openTools: false,
      todos: false,
    },
    async detect(): Promise<DetectResult> {
      if (!existsSync(dir)) return { installed: false, hasData: false, lastActivityAt: 0 };
      const found = await hints();
      let lastActivityAt = 0;
      try {
        lastActivityAt = (await stat(file)).mtimeMs;
      } catch {
        /* keep 0 */
      }
      return {
        installed: true,
        hasData: found.length > 0,
        lastActivityAt,
        dir,
        note: 'folders-only',
      };
    },
    async listSessions(_ctx: AdapterContext): Promise<ObservedSession[]> {
      return [];
    },
    listProjectHints: hints,
  };
}
