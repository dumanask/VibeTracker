import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { IdeWindow, RegistryEntry } from '@vibetracker/shared';

/**
 * Readers for the agent's on-disk state. Every function here is read-only and
 * failure-tolerant: a half-written file, a foreign file, or a directory that
 * does not exist is normal on a machine we do not control, and must never be
 * an error the user has to care about.
 */

export async function readRegistry(
  claudeDir: string,
): Promise<{ entries: RegistryEntry[]; error?: string }> {
  const sessionsDir = join(claudeDir, 'sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (err) {
    return { entries: [], error: (err as Error).message };
  }
  const entries: RegistryEntry[] = [];
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        const file = join(sessionsDir, n);
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<RegistryEntry>;
          if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return;
          entries.push({
            pid: raw.pid,
            sessionId: raw.sessionId,
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
            startedAt: raw.startedAt,
            procStart: typeof raw.procStart === 'string' ? raw.procStart : undefined,
            version: raw.version,
            kind: raw.kind,
            entrypoint: raw.entrypoint,
            name: raw.name,
            sourceFile: file,
          });
        } catch {
          /* not ours, or being written right now */
        }
      }),
  );
  return { entries };
}

export async function readIdeLocks(claudeDir: string): Promise<IdeWindow[]> {
  const ideDir = join(claudeDir, 'ide');
  let names: string[];
  try {
    names = await readdir(ideDir);
  } catch {
    return [];
  }
  const out: IdeWindow[] = [];
  await Promise.all(
    names
      .filter((n) => n.endsWith('.lock'))
      .map(async (n) => {
        const file = join(ideDir, n);
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as {
            pid?: number;
            workspaceFolders?: unknown;
            ideName?: string;
            transport?: string;
          };
          if (typeof raw.pid !== 'number') return;
          out.push({
            pid: raw.pid,
            workspaceFolders: Array.isArray(raw.workspaceFolders)
              ? raw.workspaceFolders.filter((f): f is string => typeof f === 'string')
              : [],
            ideName: raw.ideName,
            transport: raw.transport,
            lockFile: file,
            alive: false,
          });
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/**
 * Build sessionId -> transcript path.
 *
 * We index rather than derive: the project directory name is a lossy slug of
 * the working directory (every non-alphanumeric character becomes `-`, and
 * names over 200 characters are truncated with a hash appended), so it cannot
 * be reversed into a path, and its letter case is not stable either. One
 * readdir per project directory is cheap and exact.
 */
export async function indexTranscripts(claudeDir: string): Promise<Map<string, string>> {
  const projectsDir = join(claudeDir, 'projects');
  const index = new Map<string, string>();
  let slugs: string[];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return index;
  }
  await Promise.all(
    slugs.map(async (slug) => {
      const full = join(projectsDir, slug);
      try {
        for (const name of await readdir(full)) {
          if (name.endsWith('.jsonl')) index.set(basename(name, '.jsonl'), join(full, name));
        }
      } catch {
        /* not a directory, or unreadable */
      }
    }),
  );
  return index;
}

export interface KnownProject {
  /** The agent's directory name. Opaque; kept only so a reader can skip it. */
  slug: string;
  /** The working directory the transcript recorded, verbatim. */
  cwd: string;
  /** Newest transcript mtime in that directory — when the project was last worked in. */
  lastSeenAt: number;
}

/** Bytes read from the head of a transcript while looking for `cwd`. */
const HEAD_BYTES = 32 * 1024;

/**
 * Every project the agent has ever recorded, recovered from its transcripts.
 *
 * The session registry holds only what is running or recently ran — 59 entries
 * on the reference machine, six projects. The transcript directory holds
 * thirty, which is the real answer to "what have I been working on", and it is
 * the list a project chooser has to offer: the project you want to add is
 * usually one you are not running right now.
 *
 * The directory name cannot be used. It is the absolute path with every
 * non-alphanumeric character replaced, truncated and hashed past 200
 * characters, and its case is not stable — `c--dev-VibeTracker` and
 * `C--dev-probros` sit side by side. So the path is read from the transcript's
 * own `cwd` field, which is the only authoritative copy.
 *
 * Only the head of one file per directory is read, and only until a line
 * carries a `cwd`: the newest transcript here is 518 MB, and the whole point
 * of this function is that it costs a few kilobytes per project.
 */
export async function readKnownProjects(claudeDir: string): Promise<KnownProject[]> {
  const projectsDir = join(claudeDir, 'projects');
  let slugs: string[];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const out = await Promise.all(
    slugs.map(async (slug): Promise<KnownProject | null> => {
      const dir = join(projectsDir, slug);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return null;
      }
      if (files.length === 0) return null;

      // Newest first: the most recent transcript is the one most likely to
      // still name a directory that exists, and its mtime is the answer to
      // "when was this project last touched".
      const stats = await Promise.all(
        files.map(async (f) => {
          try {
            return { path: join(dir, f), mtimeMs: (await stat(join(dir, f))).mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      const ranked = stats.filter((x): x is { path: string; mtimeMs: number } => x !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (ranked.length === 0) return null;

      for (const candidate of ranked.slice(0, 3)) {
        const cwd = await cwdFromHead(candidate.path);
        if (cwd) return { slug, cwd, lastSeenAt: ranked[0]!.mtimeMs };
      }
      return null;
    }),
  );
  return out.filter((x): x is KnownProject => x !== null);
}

/**
 * The first `cwd` in a transcript's opening lines.
 *
 * Not every line has one — `ai-title`, `mode` and `queue-operation` records do
 * not — so a few are tried. A line that will not parse is skipped rather than
 * thrown on: this runs over files written by a program whose format is not
 * ours to depend on.
 */
async function cwdFromHead(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    // The last element is dropped: without a terminating newline it is a
    // fragment, and half a JSON object parses as nothing or, worse, as
    // something.
    for (const line of lines.slice(0, -1)) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      } catch {
        /* a line we cannot read is a line we skip */
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Project name from whichever manifest exists. Used only for identity fallback. */
export async function readPackageName(dir: string): Promise<string | null> {
  for (const file of ['package.json', 'Cargo.toml', 'pyproject.toml']) {
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      if (file === 'package.json') {
        const name = (JSON.parse(raw) as { name?: string }).name;
        if (typeof name === 'string' && name) return name;
      } else {
        const m = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        if (m?.[1]) return m[1];
      }
    } catch {
      /* try the next marker */
    }
  }
  return null;
}
