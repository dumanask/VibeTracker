import { execFile } from 'node:child_process';
import { isBuildNoise, normPath, pathKey, realPathSafe } from './paths.ts';

/**
 * Git probing.
 *
 * Two deliberate choices:
 *
 * - We shell out to `git` rather than inspecting `.git` ourselves. On Windows
 *   `.git` carries the Hidden attribute, which makes several stat-based
 *   approaches fail intermittently; `git` itself has no such problem.
 * - Every invocation passes `--no-optional-locks` so the daemon can never
 *   create `.git/index.lock` and never races the user's own git commands. No
 *   command here writes anything.
 */

const GIT_TIMEOUT_MS = 5000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, '--no-optional-locks', ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * Recent commit subjects, newest first.
 *
 * Subjects only. Never a diff, never a file, never a name or an address: a
 * commit subject is a sentence the author wrote about their own work, which is
 * the one part of a repository's history that is a claim rather than content.
 * The digest sends these; nothing else from git goes with it.
 */
export async function readRecentCommits(
  cwd: string,
  limit = 20,
): Promise<Array<{ subject: string; atMs: number }>> {
  const raw = await git(cwd, [
    'log',
    `-n${Math.max(1, Math.min(200, limit))}`,
    '--no-merges',
    // NUL between fields so a subject containing anything at all is safe.
    '--format=%ct%x00%s',
  ]);
  if (raw === null) return [];
  const out: Array<{ subject: string; atMs: number }> = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [secs, subject] = line.split('\0');
    const at = Number(secs) * 1000;
    if (!Number.isFinite(at) || subject === undefined) continue;
    out.push({ subject, atMs: at });
  }
  return out;
}

export interface GitFacts {
  toplevel: string;
  commonDir: string;
  isWorktree: boolean;
  /**
   * Hash of the repository's oldest root commit — the project identity key.
   * Survives moves, renames, cloud-folder copies, remote changes and worktrees.
   */
  rootSha: string | null;
  branch: string | null;
  headSha: string | null;
  headSubject: string | null;
  headAtMs: number | null;
  commitCount: number | null;
  dirtyCount: number;
  dirtyIsBuildNoise: boolean;
  /**
   * Repo-relative paths of dirty files that are not build output, capped.
   *
   * Kept because "the plan says this phase is done" and "the directories that
   * phase names hold uncommitted work" is a contradiction worth reporting, and
   * a bare count cannot say where the work is. Capped because a 500-file dirty
   * tree is common and the tail adds nothing.
   */
  dirtyPaths: string[];
  remote: string | null;
}

/** How many dirty paths travel with the facts. */
const DIRTY_SAMPLE = 200;

/** Returns null when `cwd` is not inside a git repository. */
export async function readGitFacts(cwd: string): Promise<GitFacts | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;
  const toplevel = normPath(top.trim());
  if (!toplevel) return null;

  const [commonRaw, rootRaw, branchRaw, headRaw, countRaw, statusRaw, remoteRaw] =
    await Promise.all([
      git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      // A repository can have several root commits (merged histories). Take the
      // LAST line: `rev-list` prints newest first, so the last is the oldest,
      // which is the only stable choice.
      git(cwd, ['rev-list', '--max-parents=0', 'HEAD']),
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['log', '-1', '--format=%H%x00%ct%x00%s']),
      git(cwd, ['rev-list', '--count', 'HEAD']),
      git(cwd, ['status', '--porcelain=v2', '--untracked-files=normal']),
      git(cwd, ['remote', 'get-url', 'origin']),
    ]);

  const commonDir = commonRaw ? normPath(commonRaw.trim()) : `${toplevel}/.git`;
  const isWorktree = commonDir !== `${toplevel}/.git`;

  const rootLines = (rootRaw ?? '').trim().split('\n').filter(Boolean);
  const rootSha = rootLines.length > 0 ? rootLines[rootLines.length - 1]!.trim() : null;

  let headSha: string | null = null;
  let headAtMs: number | null = null;
  let headSubject: string | null = null;
  if (headRaw) {
    const [sha, ct, subject] = headRaw.trim().split('\0');
    headSha = sha ?? null;
    headAtMs = ct ? Number(ct) * 1000 : null;
    headSubject = subject ?? null;
  }

  const dirtyPaths = parseDirtyPaths(statusRaw ?? '');

  return {
    toplevel,
    commonDir,
    isWorktree,
    rootSha,
    branch: branchRaw ? branchRaw.trim() : null,
    headSha,
    headSubject,
    headAtMs,
    commitCount: countRaw ? Number(countRaw.trim()) : null,
    dirtyCount: dirtyPaths.length,
    dirtyIsBuildNoise: isBuildNoise(dirtyPaths),
    dirtyPaths: dirtyPaths
      .filter((p) => !isBuildNoise([p]))
      .slice(0, DIRTY_SAMPLE)
      .map((p) => p.replaceAll('\\', '/')),
    remote: remoteRaw ? remoteRaw.trim() : null,
  };
}

/**
 * Extract paths from `git status --porcelain=v2`.
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> ... <path><sep><origPath>
 *   u <XY> ... <path>
 *   ? <path>
 */
function parseDirtyPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const kind = line[0];
    if (kind === '?' || kind === '!') {
      paths.push(line.slice(2));
    } else if (kind === '1' || kind === 'u') {
      const parts = line.split(' ');
      if (parts.length > 8) paths.push(parts.slice(8).join(' '));
    } else if (kind === '2') {
      const parts = line.split(' ');
      if (parts.length > 9) paths.push(parts.slice(9).join(' ').split('\t')[0]!);
    }
  }
  return paths;
}

export interface ProjectIdentity {
  projectId: string;
  identityKind: 'git_root' | 'package' | 'path';
  git: GitFacts | null;
}

/**
 * Resolve the identity of the project a session's working directory belongs to.
 *
 * Deliberately does NOT use the git remote URL. On the reference machine one
 * project existed at two paths with the *same* root commit but *different*
 * remotes — remote-based identity would have split it, which is exactly the
 * case the feature exists to handle.
 */
export async function resolveProjectIdentity(
  cwd: string,
  readPackageName: (dir: string) => Promise<string | null>,
): Promise<ProjectIdentity> {
  const facts = await readGitFacts(cwd);
  if (facts?.rootSha) {
    return {
      projectId: `git:${facts.rootSha.slice(0, 16)}`,
      identityKind: 'git_root',
      git: facts,
    };
  }

  const pkg = await readPackageName(facts?.toplevel ?? cwd);
  if (pkg) {
    return { projectId: `pkg:${shortHash(pkg)}`, identityKind: 'package', git: facts };
  }

  // Folded, not raw. `realpath` does not canonicalise case on Windows -- asked
  // for `c:/users/ad/.../projeadi` it returns exactly that, and asked for
  // `C:/Users/ad/.../ProjeAdi` it returns that -- so hashing its output
  // gives one directory two identities and the board two rows for it. Both
  // spellings turn up in real agent state: Gemini writes its project paths
  // lower-cased, Codex records `c:\GDEV\x` and `C:\GDEV\x` for the same
  // repository, and Claude Code's own slugs appear as both `C--Users` and
  // `c--Users`. `pathKey` is the canonical form, and it already declines to fold
  // on Linux, where two spellings really are two directories.
  return {
    projectId: `path:${shortHash(pathKey(realPathSafe(facts?.toplevel ?? cwd)))}`,
    identityKind: 'path',
    git: facts,
  };
}

/** Stable short hash. Not security-relevant; only needs to avoid collisions. */
function shortHash(s: string): string {
  // FNV-1a 64-bit via BigInt — deterministic across platforms and Node versions.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = Buffer.from(s, 'utf8');
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}
