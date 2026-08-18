/**
 * `vt demo` — the dashboard, populated, on a machine that has never run an
 * agent.
 *
 * Two audiences, one implementation. Someone evaluating the tool should be
 * able to see what it looks like full before installing anything; someone
 * reporting a bug should be able to reproduce the hard cases without having
 * lived through them. The generator that serves both is the same one CI uses,
 * which is what keeps the demo honest — it cannot drift into a prettier
 * version of reality, because the tests would fail first.
 *
 * Everything is built in a temporary directory and removed on exit. Nothing
 * touches the real agent state, which for this command is not a precaution but
 * the entire premise: the demo must work when there is no agent state at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture } from '@vibetracker/fixtures';
import { scan, ScanContext } from '@vibetracker/engine';
import { t, tr } from '@vibetracker/core';
import { renderText, renderHtml } from './render.ts';

export interface DemoArgs {
  /** Also build the sparse 600 MB transcript. */
  huge: boolean;
  /** Write a self-contained HTML snapshot here instead of printing. */
  html?: string;
  json: boolean;
}

export async function runDemo(args: DemoArgs): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'vt-demo-'));
  // Narration goes to stderr, always. `--json` output has to be pipeable,
  // and a progress line in the middle of a JSON document is the kind of bug
  // that only ever shows up in someone else's script.
  const say = (text: string): void => void process.stderr.write(text);
  say(t`Sentetik ortam kuruluyor: ${root}\n`);

  const fixture = await buildFixture({ root, live: 3, dead: 5, reused: 2, huge: args.huge });
  say(
    t`  ${fixture.livePids.length} canlı · ${fixture.deadPids.length} ölü · ${fixture.reusedPids.length} PID geri dönüşmüş\n`,
  );
  if (fixture.hugeTranscript) {
    say(tr('  seyrek 600 MB transcript üretildi (diskte birkaç KB)\n'));
  }

  // The scan reads `$CLAUDE_CONFIG_DIR`, so pointing it at the fixture is the
  // whole redirection — no special demo code path inside the engine, and
  // therefore no way for the demo to exercise something real users do not.
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = fixture.claudeDir;

  const ctx = new ScanContext();
  try {
    const report = await scan(
      {
        cpuSample: false,
        cpuSampleMs: 0,
        includeDead: true,
        includeTemp: true,
        tailBytes: 256 * 1024,
        progress: false,
      },
      ctx,
    );

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (args.html) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(args.html, renderHtml(report), 'utf8');
      say(t`HTML anlık görüntü: ${args.html}\n`);
    } else {
      process.stdout.write(`${renderText(report)}\n`);
      say(tr('Bu tamamen sentetik bir ortamdır. Gerçek ajan durumuna dokunulmadı.\n'));
    }
  } finally {
    await ctx.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fixture.cleanup();
  }
  return 0;
}
