/**
 * `vt board` — the phase timeline, in a terminal.
 *
 * A Gantt chart made of block characters, which sounds like a gimmick and is
 * not: the question "when did this project actually work on phase 3" is a
 * question about *spans*, and a table of dates does not answer it at a glance
 * while a bar does.
 *
 * The rule the drawing obeys: **a reconstructed span and an observed one never
 * look the same.** History mined from commit subjects is coarse — it knows a
 * phase was worked on in March, not what it stood at on the 14th — so it is
 * drawn hatched. Anything else would let the past borrow the credibility of
 * the present.
 */
import { ScanContext, backfillPhases, scan, toSpans, type PhaseSpan } from '@vibetracker/engine';
import { readGitFacts } from '@vibetracker/platform';
import { fmtAge, say, t, tr } from '@vibetracker/core';

const WIDTH = 46;

const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = wrap('2');
const bold = wrap('1');
const cyan = wrap('36');
const green = wrap('32');
const yellow = wrap('33');

export interface BoardArgs {
  /** Project name or id filter; empty means every project. */
  filter?: string;
  json: boolean;
}

export async function runBoard(args: BoardArgs): Promise<number> {
  const ctx = new ScanContext();
  let report;
  try {
    report = await scan(
      { cpuSample: false, cpuSampleMs: 0, includeDead: false, includeTemp: false, tailBytes: 64 * 1024 },
      ctx,
    );
  } finally {
    await ctx.close();
  }

  const wanted = report.projects.filter(
    (p) =>
      !args.filter ||
      p.displayName.toLowerCase().includes(args.filter.toLowerCase()) ||
      p.projectId === args.filter,
  );

  if (wanted.length === 0) {
    process.stdout.write(tr('Eşleşen proje yok.\n'));
    return 0;
  }

  const boards: Array<{ name: string; spans: PhaseSpan[]; scanned: number; reason?: string }> = [];
  for (const p of wanted) {
    const root = p.workspaces[0]?.normPath;
    if (!root) continue;
    // Confirm it is a repository before shelling out to `git log`: a project
    // identified by package name or path has no recoverable history, and
    // saying so beats an empty chart.
    const facts = await readGitFacts(root);
    if (!facts) {
      boards.push({ name: p.displayName, spans: [], scanned: 0, reason: 'no-git' });
      continue;
    }
    const r = await backfillPhases(root);
    boards.push({ name: p.displayName, spans: toSpans(r.points), scanned: r.commitsScanned, reason: r.reason });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(boards, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(render(boards));
  return 0;
}

function render(
  boards: Array<{ name: string; spans: PhaseSpan[]; scanned: number; reason?: string }>,
): string {
  const out: string[] = [''];
  const all = boards.flatMap((b) => b.spans);
  if (all.length === 0) {
    out.push(tr('  Hiçbir projede commit mesajlarından faz izi bulunamadı.'));
    out.push(dim(tr('  Faz adları commit başlıklarında geçmiyorsa geçmiş çıkarılamaz — uydurulmaz.')));
    return `${out.join('\n')}\n\n`;
  }

  const min = Math.min(...all.map((s) => s.firstAt));
  const max = Math.max(...all.map((s) => s.lastAt));
  const span = Math.max(1, max - min);
  const at = (ms: number): number =>
    Math.max(0, Math.min(WIDTH - 1, Math.round(((ms - min) / span) * (WIDTH - 1))));

  out.push(
    `  ${bold(tr('FAZ PANOSU'))} ${dim(
      t`${new Date(min).toISOString().slice(0, 10)} → ${new Date(max).toISOString().slice(0, 10)}`,
    )}`,
  );
  out.push(
    dim(
      `  ${tr('▒ commit geçmişinden çıkarıldı (kaba)')} · ${tr('│ ilk anma')} · ${tr('▐ tamamlandı denildi')}`,
    ),
  );

  for (const b of boards) {
    out.push('');
    out.push(`  ${cyan(b.name)} ${dim(t`${b.scanned} commit`)}`);
    if (b.spans.length === 0) {
      out.push(
        dim(
          `    ${b.reason === 'no-git' ? tr('git yok — geçmiş çıkarılamaz') : tr('commit başlıklarında faz adı geçmiyor')}`,
        ),
      );
      continue;
    }
    for (const s of b.spans) {
      const a = at(s.firstAt);
      const z = at(s.lastAt);
      const d = s.doneAt === null ? -1 : at(s.doneAt);
      let bar = '';
      for (let i = 0; i < WIDTH; i++) {
        if (i === d) bar += '▐';
        else if (i === a && a === z) bar += '│';
        else if (i >= a && i <= z) bar += '▒';
        else bar += '·';
      }
      const label = `${s.unit} ${s.ordinal}`.padEnd(10);
      const tail =
        s.afterDone > 0
          ? yellow(t` · bitti denildikten sonra ${s.afterDone} commit`)
          : s.doneAt !== null
            ? green(t` · ${fmtAge(Date.now() - s.doneAt)} önce bitti`)
            : dim(tr(' · açık'));
      out.push(`    ${label} ${dim(bar)} ${dim(t`${s.commits} commit`)}${tail}`);
    }
  }

  out.push('');
  out.push(
    dim(
      `  ${tr('Bu tablo commit başlıklarından çıkarıldı; VibeTracker kurulmadan önceki her şey kaba.')}`,
    ),
  );
  return `${out.join('\n')}\n`;
}

/** Re-exported so the daemon's board payload and this view stay in step. */
export type { PhaseSpan };
export { say };
