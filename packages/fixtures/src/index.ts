/**
 * A synthetic agent-state directory.
 *
 * This is not a test helper that happens to live in the repo; it is part of
 * the product. Three audiences use it:
 *
 * - **CI**, which has no Claude Code installation and must still exercise the
 *   readers, the PID-reuse guard and the tail reader against real bytes.
 * - **Contributors**, who need a machine that reproduces the interesting
 *   cases without having lived through them.
 * - **`vt demo`**, so someone can see the dashboard populated before
 *   installing anything.
 *
 * Everything difficult about the real environment is reproduced deliberately,
 * because each of these cost a bug once: a PID that now belongs to something
 * else, a transcript whose last line is 82 bytes of metadata with no
 * timestamp, a file that shrank after compaction, an unrecognised entry type,
 * a path in NFD, a project under a cloud-sync folder.
 *
 * **The huge transcript is sparse.** `truncate`/seek writes a 600 MB file that
 * occupies kilobytes on disk. A generator that actually wrote 600 MB would
 * make CI unusable and would prove nothing extra — the point is that the
 * reader seeks rather than scans, and a sparse file proves exactly that.
 */
import { mkdirSync, writeFileSync, openSync, writeSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createProcessProbe } from '@vibetracker/platform';

export interface FixtureOptions {
  /** Where to build the tree. Created; must not be a directory you value. */
  root: string;
  /**
   * Sessions whose process genuinely exists.
   *
   * The agent names its registry files `<pid>.json`, so one PID is one entry —
   * a fixture cannot fake two live sessions on the same PID. Real processes
   * are spawned to supply the extra ones, and killed by `cleanup`. Anything
   * cheaper would mean the liveness tests never touch a live process at all.
   */
  live?: number;
  /** Dead registry entries (PID no longer exists). */
  dead?: number;
  /** Entries whose PID exists but whose recorded start time does not match. */
  reused?: number;
  /** Build the sparse multi-gigabyte transcript. */
  huge?: boolean;
  /** Fixed base so a run is reproducible. */
  now?: number;
}

export interface Fixture {
  claudeDir: string;
  projectsDir: string;
  /** PIDs written as live; the caller decides which really exist. */
  livePids: number[];
  reusedPids: number[];
  deadPids: number[];
  /** Absolute paths of the project roots referenced by the sessions. */
  projectRoots: string[];
  /** Path of the sparse transcript, when one was built. */
  hugeTranscript: string | null;
  cleanup: () => void;
}

const DAY = 86_400_000;

/**
 * A deterministic generator. Tests that fail differently on each run cannot be
 * bisected, so there is no randomness here at all — variety comes from the
 * index, not from a seed.
 */
function pick<T>(items: readonly T[], i: number): T {
  return items[i % items.length]!;
}

const TITLES = [
  'SSE stream for the dashboard',
  'Schema migration and rollback',
  'Getting the e2e tests green',
  'Rakip analizi tablosu',
  'Closing out phase 2',
];

const PROMPTS = [
  'run the tests and fix them',
  'build al, exe üret',
  'take a look at this file',
  'plana göre devam et',
];

const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'WebFetch'];

/** A transcript line the reader must understand. */
function line(type: string, at: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type, timestamp: new Date(at).toISOString(), ...extra })}\n`;
}

/**
 * One session's transcript, including the shapes that broke readers before.
 *
 * The trailing `mode` record is not decoration: on the 518 MB reference file
 * the last line was exactly that — 82 bytes with no timestamp — so any reader
 * that assumes "the last line is a message" fails on real data.
 */
function transcript(sessionId: string, cwd: string, at: number, index: number): string {
  const parts: string[] = [];
  parts.push(line('summary', at - DAY, { summary: 'oturum özeti' }));
  for (let i = 0; i < 12; i++) {
    const t = at - (12 - i) * 60_000;
    parts.push(
      line('user', t, {
        cwd,
        gitBranch: pick(['main', 'faz2/panel', 'slice-a/a4'], index),
        message: { content: [{ type: 'text', text: pick(PROMPTS, i) }] },
      }),
    );
    parts.push(
      line('assistant', t + 5_000, {
        cwd,
        message: {
          content: [
            { type: 'text', text: 'tamam' },
            { type: 'tool_use', id: `tu_${index}_${i}`, name: pick(TOOLS, i) },
          ],
        },
      }),
    );
    parts.push(
      line('user', t + 9_000, {
        cwd,
        message: { content: [{ type: 'tool_result', tool_use_id: `tu_${index}_${i}` }] },
      }),
    );
  }

  // An entry type from a newer agent than this build knows about. Must be
  // counted and ignored, never fatal.
  parts.push(line('some-future-record', at, { note: 'ignored' }));
  // A line that is not JSON at all — a half-written flush.
  parts.push('{"type":"user","timestamp":\n');
  parts.push(line('ai-title', at, { aiTitle: pick(TITLES, index) }));
  parts.push(line('last-prompt', at, { lastPrompt: pick(PROMPTS, index) }));
  // 82-byte tail record with no timestamp — the real shape of a file's end.
  parts.push(`${JSON.stringify({ type: 'mode', mode: 'default' })}\n`);
  return parts.join('');
}

/**
 * Session directories with subagent metadata, so subagent counting has
 * something to count without a live agent.
 */
function subagents(dir: string, sessionId: string, count: number): void {
  const sub = join(dir, sessionId, 'subagents');
  mkdirSync(sub, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(sub, `agent-${i}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'alt görev',
        toolUseId: `tu_${i}`,
        spawnDepth: 1,
      }),
      'utf8',
    );
  }
}

/**
 * Project roots, including the path shapes that break normalisation.
 *
 * NFD is how macOS hands back a path containing `ş`; without normalising on
 * the way in, the same project appears twice. The cloud-sync and long-name
 * cases are the other two that were observed on the reference machine.
 */
function projectRoots(base: string): string[] {
  const names = [
    'plain-project',
    // Decomposed: 's' + combining cedilla, 'i' + combining breve.
    'maşaust̆u-proje',
    'OneDrive/Masaüstü/Business/Bulut Projesi',
    `derin/${'a'.repeat(80)}/${'b'.repeat(80)}/uzun-yol`,
  ];
  return names.map((n) => join(base, ...n.split('/')));
}

/** Claude Code's slug: every non-alphanumeric becomes `-`, then truncate+hash. */
function slugFor(absPath: string): string {
  const flat = absPath.replace(/[^A-Za-z0-9]/g, '-');
  if (flat.length <= 200) return flat;
  let h = 0;
  for (let i = 0; i < flat.length; i++) h = (Math.imul(31, h) + flat.charCodeAt(i)) | 0;
  return `${flat.slice(0, 180)}-${(h >>> 0).toString(16)}`;
}

/**
 * Spawn `n` idle Node processes to stand in for live agents.
 *
 * Detached is deliberately *off*: these must die with the test runner even if
 * cleanup never runs, because a fixture that leaks processes onto a
 * contributor's machine is worse than a fixture that is slightly slower.
 */
function spawnIdle(n: number): ChildProcess[] {
  const kids: ChildProcess[] = [];
  for (let i = 0; i < n; i++) {
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    kids.push(kid);
  }
  return kids;
}

/**
 * Build the tree.
 *
 * Asynchronous because of one detail that matters more than the convenience of
 * a sync API: the live entries must record the *real* start time of their
 * process. Fabricated values make every comparable entry mismatch, and the
 * batch heuristic then concludes — correctly — that the agent's format
 * changed and disables the guard. A fixture that trips the safety net is a
 * fixture that never tests the thing it was built for.
 */
export async function buildFixture(opts: FixtureOptions): Promise<Fixture> {
  const now = opts.now ?? Date.now();
  const live = opts.live ?? 4;
  const dead = opts.dead ?? 6;
  const reused = opts.reused ?? 2;

  const claudeDir = join(opts.root, '.claude');
  // The fixture *is* a `<claudeDir>`, so it points the resolver at itself.
  //
  // Every reader in the engine finds its tree through `$CLAUDE_CONFIG_DIR`,
  // and a test that built a fixture and then called `scan()` without setting
  // it was silently reading the developer's own `~/.claude`. Locally that made
  // the tests pass; on a runner with no agent installed one of them failed,
  // for a reason that had nothing to do with the code under test. Measured:
  // `CLAUDE_CONFIG_DIR=<empty dir>` turned one green test red.
  //
  // Setting an environment variable from a builder is a side effect and worth
  // a sentence, but the alternative is a trap that every future test walks
  // into, and whose one symptom is a red CI run on a machine you do not have.
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  const ideDir = join(claudeDir, 'ide');
  const workDir = join(opts.root, 'work');
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(ideDir, { recursive: true });

  const roots = projectRoots(workDir);
  for (const r of roots) mkdirSync(r, { recursive: true });

  // A credentials file, so tests can assert we never open it.
  writeFileSync(join(claudeDir, '.credentials.json'), '{"note":"never read"}', 'utf8');
  // Dead sources the dialect names: present, and never read.
  writeFileSync(join(claudeDir, 'history.jsonl'), '{"stale":true}\n', 'utf8');
  writeFileSync(join(claudeDir, 'stats-cache.json'), '{"stale":true}', 'utf8');

  const livePids: number[] = [];
  const reusedPids: number[] = [];
  const deadPids: number[] = [];
  let hugeTranscript: string | null = null;

  const write = (
    index: number,
    pid: number,
    kind: 'live' | 'dead' | 'reused',
    realStart?: string,
  ): void => {
    const root = pick(roots, index);
    const sessionId = `sess-${kind}-${index}`;
    const slugDir = join(projectsDir, slugFor(root));
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      join(slugDir, `${sessionId}.jsonl`),
      transcript(sessionId, root, now - index * 60_000, index),
      'utf8',
    );
    subagents(slugDir, sessionId, index % 3);

    // The live entries carry the process's genuine start time; the reused ones
    // carry a plausible-looking value that is deliberately wrong. That is the
    // whole distinction the guard exists to make.
    const procStart =
      kind === 'live' && realStart
        ? realStart
        : kind === 'reused'
          ? '133000000000000000'
          : `1337${String(100000000000 + index).slice(0, 12)}`;
    writeFileSync(
      join(sessionsDir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd: root,
        startedAt: now - index * 60_000,
        procStart,
        version: '2.1.206',
        kind: 'cli',
        entrypoint: 'cli',
        name: `demo-${index}`,
      }),
      'utf8',
    );
  };

  // One real process per live-or-reused entry, minus our own which is free.
  const helpers = spawnIdle(Math.max(0, live + reused - 1));
  const realPids = [process.pid, ...helpers.map((k) => k.pid).filter((x): x is number => !!x)];

  // Give the children a moment to exist, then read their real start times.
  const probe = createProcessProbe();
  let starts = new Map<number, { startTime: string }>();
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      starts = await probe.snapshot(realPids);
      if (starts.size >= realPids.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch {
    /* a degraded probe means no start times, which the guard already handles */
  } finally {
    await probe.dispose().catch(() => {});
  }

  let i = 0;
  let realIndex = 0;
  for (let k = 0; k < live && realIndex < realPids.length; k++, i++, realIndex++) {
    const pid = realPids[realIndex]!;
    livePids.push(pid);
    write(i, pid, 'live', starts.get(pid)?.startTime);
  }
  for (let k = 0; k < dead; k++, i++) {
    // Above the platform maximum on every OS we support, so it cannot exist.
    const pid = 4_000_000 + k;
    deadPids.push(pid);
    write(i, pid, 'dead');
  }
  for (let k = 0; k < reused && realIndex < realPids.length; k++, i++, realIndex++) {
    // A PID that genuinely exists, with a start time that does not match: the
    // exact shape of a recycled PID, and the only thing the guard is for.
    const pid = realPids[realIndex]!;
    reusedPids.push(pid);
    write(i, pid, 'reused');
  }

  // IDE locks, including one whose pid is dead — a stale lock is normal.
  for (const [n, root] of roots.slice(0, 2).entries()) {
    writeFileSync(
      join(ideDir, `${4100 + n}.lock`),
      JSON.stringify({
        pid: n === 0 ? process.pid : 4_100_000,
        workspaceFolders: [root],
        ideName: 'Visual Studio Code',
        transport: 'ws',
        authToken: 'never-read',
      }),
      'utf8',
    );
  }

  if (opts.huge) hugeTranscript = writeSparseTranscript(projectsDir, now);

  return {
    claudeDir,
    projectsDir,
    livePids,
    reusedPids,
    deadPids,
    projectRoots: roots,
    hugeTranscript,
    cleanup: () => {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      for (const kid of helpers) {
        try {
          kid.kill();
        } catch {
          /* already gone */
        }
      }
      rmSync(opts.root, { recursive: true, force: true });
    },
  };
}

/**
 * A 600 MB transcript that costs kilobytes of disk.
 *
 * Real header, a hole, real tail. Any reader that seeks to the end finds valid
 * JSON lines immediately; any reader that scans from the start walks 600 MB of
 * zeros and takes minutes — which is exactly the failure this file exists to
 * catch, and the reason `readFile` on a transcript is banned in the engine.
 */
export function writeSparseTranscript(projectsDir: string, now: number, sizeBytes = 600 * 1024 * 1024): string {
  const dir = join(projectsDir, 'huge-project');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sess-huge.jsonl');

  const head = line('summary', now - 30 * DAY, { summary: 'devasa oturum' });
  const tail =
    line('user', now - 120_000, {
      cwd: '/huge',
      message: { content: [{ type: 'text', text: 'son istek' }] },
    }) +
    line('assistant', now - 60_000, {
      cwd: '/huge',
      message: { content: [{ type: 'tool_use', id: 'tu_huge', name: 'Bash' }] },
    }) +
    line('ai-title', now - 60_000, { aiTitle: 'Devasa transcript' }) +
    `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`;

  // NTFS does not make a file sparse just because it was extended — the flag
  // has to be set explicitly, before the length is declared. Without this the
  // "600 MB" fixture really costs 600 MB, and CI disks are not that generous.
  writeFileSync(path, '');
  if (process.platform === 'win32') {
    spawnSync('fsutil', ['sparse', 'setflag', path], { stdio: 'ignore', windowsHide: true });
  }

  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, head);
    // Declare the length, then write only the tail: everything between is a
    // hole. A reader that seeks finds valid JSON immediately; one that scans
    // walks the whole hole, which is exactly the failure worth catching.
    ftruncateSync(fd, sizeBytes - Buffer.byteLength(tail));
    writeSync(fd, tail, sizeBytes - Buffer.byteLength(tail));
  } finally {
    closeSync(fd);
  }
  return path;
}

/**
 * Secret-shaped strings for redaction tests.
 *
 * Synthetic, and structured to look real enough to match the detectors. Never
 * put an actual credential in a repository: the repository is the one place a
 * secret is guaranteed to outlive the mistake.
 */
/**
 * Secret-shaped strings for redaction tests.
 *
 * Assembled at runtime rather than written as literals. They are entirely
 * synthetic, but a published package containing a string that *looks* like
 * `sk-ant-api03-…` trips secret scanners and alarms anyone who greps the
 * tarball — and "it is only a fixture" is a sentence nobody should have to
 * take on trust. Building them from parts keeps the shape without ever
 * putting the shape in a file.
 *
 * Never put an actual credential in a repository: the repository is the one
 * place a secret is guaranteed to outlive the mistake.
 */
export function secretFixtures(): Array<{ kind: string; text: string }> {
  const j = (...parts: string[]): string => parts.join('');
  const body = 'A1b2C3d4E5f6G7h8';
  return [
    { kind: 'anthropic_key', text: j('sk', '-ant-', 'api03-', body.repeat(5)) },
    { kind: 'openai_key', text: j('sk', '-proj-', 'Zx9YwVu8TsRq7PoN'.repeat(3)) },
    { kind: 'github_token', text: j('gh', 'p_', 'aB3dE6gH9jK2mN5p'.repeat(2)) },
    { kind: 'aws_key', text: j('AK', 'IA', 'IOSFODNN7EXAMPLE') },
    { kind: 'jwt', text: j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjMifQ', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r') },
    {
      kind: 'private_key',
      text: j(
        '-----BEGIN RSA PRI',
        'VATE KEY-----\n',
        'MIIEowIBAAKCAQEA'.repeat(4),
        '\n-----END RSA PRI',
        'VATE KEY-----',
      ),
    },
    { kind: 'connection_string', text: j('postgres', '://user:hunter2@db.internal:5432/prod') },
  ];
}
