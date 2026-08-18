import { SessionState, needsYou, type ProjectView, type SessionView, type StatusReport } from '@vibetracker/shared';
import {
  CONFIDENT,
  compactRank,
  fmtAge,
  fmtPercent,
  getLang,
  say,
  sinceMs,
  summarizeAgents,
  t,
  tr,
  truncate,
  type AgentSummary,
} from '@vibetracker/core';

// ── ansi ──────────────────────────────────────────────────────────────────
const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = wrap('2');
const bold = wrap('1');
const red = wrap('31');
const yellow = wrap('33');
const green = wrap('32');
const blue = wrap('34');
const cyan = wrap('36');

const STATE_GLYPH: Record<string, string> = {
  STARTING: '◌',
  BUSY: '▶',
  WAITING_PERMISSION: '●',
  WAITING_INPUT: '⏸',
  STALLED: '⚠',
  ERRORED: '✖',
  ENDED: '·',
  ORPHANED: '×',
  UNKNOWN: '?',
};

function paintState(state: string): string {
  switch (state) {
    case SessionState.WaitingPermission:
      return red(state);
    case SessionState.Stalled:
    case SessionState.Errored:
      return yellow(state);
    case SessionState.WaitingInput:
      return blue(state);
    case SessionState.Busy:
      return green(state);
    default:
      return dim(state);
  }
}

/**
 * The agent's derived session name is NOT unique — two sessions in the same
 * project were observed sharing `agentworld-43`, one live and one whose PID had
 * been recycled. The pid is appended so two rows are never indistinguishable.
 */
function sessionLabel(s: SessionView): string {
  const base = s.name ?? s.sessionId.slice(0, 8);
  // Which agent, when it is not the one this tool started with. Prefixed rather
  // than appended because the column is truncated from the right, and losing
  // the agent is worse than losing the tail of an opaque id.
  const agent = s.agentKind && s.agentKind !== 'claude-code' ? `${s.agentKind}:` : '';
  // A pid of zero is not a pid. Codex and opencode publish none, so there is
  // nothing to disambiguate with and printing `·0` would suggest otherwise.
  const pid = s.pid > 0 ? `·${s.pid}` : '';
  return `${agent}${base}${pid}`;
}

function activityAge(s: SessionView, now: number): string {
  return s.lastActivityAt ? fmtAge(sinceMs(now, s.lastActivityAt)) : '—';
}

/**
 * The progress line for a project card.
 *
 * A refused number gets as much room as a real one, and says why. "—, this is
 * a changelog" is a useful answer; a blank space is not, and an invented "%100"
 * is worse than either.
 */
function progressLine(p: ProjectView['progress']): string[] {
  if (!p) return [];
  const out: string[] = [];
  const bits: string[] = [];

  if (p.phase) {
    const total = p.phase.total > p.phase.ordinal ? `/${p.phase.total}` : '';
    const sub = p.phase.sub ? ` ${dim('·')} ${p.phase.sub}` : '';
    bits.push(`${cyan(p.phase.labelRaw + total)}${sub}`);
  }
  // Said before the number, because it explains the gap where a phase would
  // be. Said even when a percentage survives: a project can have a countable
  // backlog and still no agreed answer to "which phase is this".
  if (!p.phase && p.phaseSuppressed) bits.push(dim(say(p.phaseSuppressed)));
  if (p.percent !== null && p.percent !== undefined) {
    const filled = Math.round((Math.max(0, Math.min(100, p.percent)) / 100) * 14);
    // Hatched for an inferred number, solid for a counted one — the terminal
    // equivalent of the dashed bar in the browser.
    const glyph = p.approximate ? '▒' : '█';
    const bar = glyph.repeat(filled) + '·'.repeat(14 - filled);
    bits.push(`${bar} ${fmtPercent(p.percent, p.approximate)}`);
  } else {
    bits.push(`${dim('·'.repeat(14))} ${dim('—')}`);
    // Engine-produced phrases are looked up too, so a catalog can translate
    // them without the engine knowing a language exists.
    if (p.percentSuppressed) bits.push(dim(say(p.percentSuppressed)));
  }
  out.push('    ' + bits.join(' '));

  for (const d of p.drift) {
    out.push('    ' + yellow(`⚠ ${say(d.claim)}`) + ' ' + dim(say(d.evidence)));
  }
  if (p.provenance) out.push('    ' + dim(say(p.provenance)));
  if (p.nextAction) out.push('    ' + dim(t`sonraki: ${truncate(p.nextAction, 90)}`));
  return out;
}

/**
 * Flags travel as identifiers so scoring logic can match them; only the
 * displayed form is translated. The count inside `kirli-sel(529)` is split
 * out so one catalog entry covers every project.
 */
function flagText(flag: string): string {
  const m = /^([a-zçğıöşü-]+)\((\d+)\)$/.exec(flag);
  return m ? `${tr(m[1]!)}(${m[2]})` : tr(flag);
}

function subLabel(s: SessionView): string {
  if (s.openTools.length > 0) return `tool:${s.openTools[0]}`;
  return '';
}

/** Renders as `WAITING_PERMISSION?` when we are inferring rather than observing. */
function stateText(s: SessionView): string {
  return s.confidence < CONFIDENT ? `${s.state}?` : s.state;
}

/**
 * The one-line-per-project view.
 *
 * Three columns and nothing else: who, what its agents are doing, how far it
 * has got. The detailed view answers a different question and is still one
 * flag away; this one is for the twenty times a day you only need to know
 * whether anything is stuck.
 *
 * A project is never dropped for having nothing to say — an empty row is
 * information ("nothing running there") and a missing row would read as a
 * tracking failure.
 */
interface Cell {
  text: string;
  plain: string;
}

/**
 * Waiting and running, always both, always in their own columns.
 *
 * This used to name whichever state was dominant and then print `live/total`
 * beside it. Two things were wrong with that. The pair read as
 * "running/total" — which is the shape it had been asked for — while actually
 * meaning "alive/ever seen", so a project with three sessions waiting on the
 * user and one still working announced `3 bekliyor   5/5` and left the reader
 * to guess where the other two had gone. And naming one state hid the other:
 * "waiting" and "running" are simultaneous facts about a project, not
 * alternatives.
 *
 * Two counts answering two questions, in fixed positions, is the only compact
 * form that cannot be misread. A zero is drawn as `—` rather than left blank,
 * because a blank column is indistinguishable from a rendering fault.
 */
function waitingCell(a: AgentSummary): Cell {
  if (a.waiting === 0) return { text: dim('—'), plain: '—' };
  const plain = t`${a.waiting} bekliyor`;
  return { text: a.urgency >= 3 ? red(plain) : yellow(plain), plain };
}

function runningCell(a: AgentSummary): Cell {
  if (a.running > 0) {
    const plain = t`${a.running} çalışıyor`;
    return { text: green(plain), plain };
  }
  // Nothing waiting and nothing running is still two different situations:
  // a session sitting there with nothing to do, and no session at all.
  if (a.waiting === 0) {
    const plain = a.live > 0 ? tr('boşta') : tr('kapalı');
    return { text: dim(plain), plain };
  }
  return { text: dim('—'), plain: '—' };
}

function padCell(c: Cell, width: number): string {
  return c.text + ' '.repeat(Math.max(0, width - c.plain.length));
}

/** A short bar, or a dashed channel when there is no honest number. */
function miniBar(p: ProjectView['progress']): string {
  const width = 10;
  if (!p || p.percent === null || p.percent === undefined) {
    return `${dim('·'.repeat(width))} ${dim('—'.padStart(5))}`;
  }
  const filled = Math.round((Math.max(0, Math.min(100, p.percent)) / 100) * width);
  const glyph = p.approximate ? '▒' : '█';
  const bar = glyph.repeat(filled) + '·'.repeat(width - filled);
  const pct = fmtPercent(p.percent, p.approximate);
  return `${p.approximate ? dim(bar) : bar} ${pct.padStart(5)}`;
}

export function renderCompact(r: StatusReport): string {
  const out: string[] = [];
  const now = r.generatedAt;
  const c = r.counts;
  const followed = r.projects.filter((p) => p.tracked);

  out.push('');
  const head = [
    `${bold('VibeTracker')}`,
    c.needsYou > 0 ? yellow(t`${c.needsYou} bekliyor`) : dim(tr('bekleyen yok')),
    dim(t`${c.live} canlı ajan`),
    dim(t`${followed.length} proje`),
  ];
  if (c.untracked > 0) head.push(dim(t`${c.untracked} izlenmiyor`));
  out.push('  ' + head.join(dim(' · ')));
  out.push('');

  if (followed.length === 0) {
    out.push(dim(tr('  İzlenen proje yok. `vt projects add <proje>` ile ekle.')));
    out.push('');
    return out.join('\n');
  }

  const ranked = [...followed].sort((a, b) => compactRank(b) - compactRank(a));
  // Names are padded to the widest so the three columns line up; a ragged
  // left edge is what makes a list of twelve unreadable.
  const width = Math.min(24, Math.max(...ranked.map((p) => p.displayName.length)));

  const rows = ranked.map((p) => ({
    p,
    waiting: waitingCell(p.summary),
    running: runningCell(p.summary),
  }));
  // Column widths measured across the whole list rather than assumed: the
  // words differ per language and per count, and a column sized for Turkish
  // is a ragged column in English.
  const wWait = Math.max(...rows.map((r) => r.waiting.plain.length));
  const wRun = Math.max(...rows.map((r) => r.running.plain.length));

  for (const { p, waiting, running } of rows) {
    const a = p.summary;
    const name = truncate(p.displayName, width).padEnd(width);
    const glyph =
      a.kind === 'waiting' ? (a.urgency >= 3 ? red('●') : yellow('⏸')) :
      a.kind === 'running' ? green('▶') : dim('·');
    const dwell = a.leadSince
      ? dim(fmtAge(sinceMs(now, a.leadSince)).padStart(9))
      : ' '.repeat(9);
    out.push(
      `  ${glyph} ${bold(name)}  ${padCell(waiting, wWait)}  ${padCell(running, wRun)}  ` +
        `${miniBar(p.progress)}  ${dwell}`,
    );
  }

  out.push('');
  out.push(dim(tr('  ayrıntı: vt status --full')));
  out.push('');
  return out.join('\n');
}

// ── text ──────────────────────────────────────────────────────────────────
export function renderText(r: StatusReport): string {
  const out: string[] = [];
  const now = r.generatedAt;
  const when = new Date(now).toLocaleString();

  out.push('');
  out.push(
    `${bold('VibeTracker')} ${dim('·')} ${when} ${dim('·')} ${r.platform} ${dim('·')} ${r.probeKind} ${dim(`(${r.probePrecision})`)}`,
  );

  const c = r.counts;
  const reusedTxt =
    c.reused > 0 ? red(t`${c.reused} PID-yeniden-kullanım`) : dim(t`0 PID-yeniden-kullanım`);
  out.push(
    t`  ${bold(String(c.registryEntries))} kayıt → ${green(t`${c.live} canlı`)} ${dim('·')} ${dim(t`${c.dead} ölü`)} ${dim('·')} ${reusedTxt}`,
  );
  out.push(
    t`  ${bold(String(c.projects))} proje ${dim('·')} ${c.needsYou > 0 ? yellow(t`${c.needsYou} oturum seni bekliyor`) : dim(t`bekleyen yok`)} ${dim('·')} ${c.ideWindows} IDE penceresi`,
  );
  out.push(dim(`  ${r.claudeDir}`));

  // Capability line — what worked and what did not, always visible.
  const caps = Object.entries(r.capabilities).map(([k, v]) =>
    v.ok ? green(`✓${k}`) : yellow(`!${k}`),
  );
  out.push(`  ${caps.join(dim(' '))}`);

  if (r.warnings.length > 0) {
    out.push('');
    for (const w of r.warnings) out.push(`${yellow('⚠')}  ${w}`);
  }

  // ── needs you ───────────────────────────────────────────────────────────
  const waiting: Array<{ p: ProjectView; s: SessionView }> = [];
  for (const p of r.projects) for (const s of p.sessions) if (needsYou(s.state)) waiting.push({ p, s });

  if (waiting.length > 0) {
    out.push('');
    out.push(bold(t`SENİ BEKLEYENLER`));
    for (const { p, s } of waiting) {
      const glyph = STATE_GLYPH[s.state] ?? '?';
      out.push(
        `  ${glyph} ${cyan(p.displayName.padEnd(16))} ${sessionLabel(s).padEnd(20)} ${paintState(stateText(s))} ${dim(activityAge(s, now).padStart(10))}`,
      );
      if (s.title) out.push(`      ${dim('"' + truncate(s.title, 90) + '"')}`);
    }
  }

  // ── projects ────────────────────────────────────────────────────────────
  out.push('');
  out.push(bold(t`PROJELER`));
  if (r.projects.length === 0) {
    out.push(dim(t`  Görünür oturum yok. Bir ajan oturumu başlat ve tekrar dene.`));
  }

  for (const p of r.projects) {
    const idKind = p.identityKind === 'git_root' ? p.projectId : `${p.projectId} ${dim(`(${p.identityKind})`)}`;
    out.push('');
    out.push(`  ${bold(cyan(p.displayName))} ${dim(idKind)}${p.flags.length ? '  ' + yellow('[' + p.flags.map(flagText).join(' ') + ']') : ''}`);
    for (const line of progressLine(p.progress)) out.push(line);

    for (const w of p.workspaces) {
      const bits: string[] = [];
      if (w.branch) bits.push(w.branch);
      if (w.commitCount !== undefined) bits.push(t`${w.commitCount} commit`);
      if (w.dirtyCount !== undefined) bits.push(t`${w.dirtyCount} kirli`);
      if (w.isWorktree) bits.push('worktree');
      if (w.storageKind !== 'local') bits.push(w.storageKind);
      const label = p.workspaces.length > 1 && w.label ? `${w.label}: ` : '';
      out.push(dim(`    ${label}${w.normPath}${bits.length ? '  — ' + bits.join(' · ') : ''}`));
      if (w.headSubject) out.push(dim(`      HEAD: ${truncate(w.headSubject, 80)}`));
    }

    for (const s of p.sessions) {
      const glyph = STATE_GLYPH[s.state] ?? '?';
      const sub = subLabel(s);
      out.push(
        `    ${glyph} ${sessionLabel(s).padEnd(22)} ${paintState((stateText(s) + (sub ? ' ' + sub : '')).padEnd(30))} ${dim(activityAge(s, now).padStart(10))}`,
      );
      out.push(`        ${dim(s.evidence.join(' · '))}`);
      if (s.title) out.push(`        ${dim('"' + truncate(s.title, 88) + '"')}`);
    }
  }

  out.push('');
  return out.join('\n');
}

// ── html ──────────────────────────────────────────────────────────────────
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );

/**
 * Self-contained snapshot. No external requests of any kind: this file may be
 * opened from anywhere, and a dashboard about someone's private projects must
 * not phone home.
 */
export function renderHtml(r: StatusReport): string {
  const now = r.generatedAt;
  const waiting: Array<{ p: ProjectView; s: SessionView }> = [];
  for (const p of r.projects) for (const s of p.sessions) if (needsYou(s.state)) waiting.push({ p, s });

  const stateChip = (s: SessionView): string => {
    const sub = s.openTools.length > 0 ? ` ${esc(s.openTools[0]!)}` : '';
    const unsure = s.confidence < CONFIDENT;
    // Dashed border and a `?` so an inference is never mistaken for an
    // observation at a glance.
    return `<span class="chip s-${s.state}${unsure ? ' unsure' : ''}" title="${tr('güven')} ${s.confidence.toFixed(2)}">${esc(stateText(s))}${sub}</span>`;
  };

  // A full document, not a fragment: this file is opened directly from disk, so
  // there is no host page to supply <head>. Without an explicit charset the
  // browser falls back to the locale encoding and every Turkish character in
  // the report is mangled.
  return `<!doctype html>
<html lang="${getLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>VibeTracker — durum anlık görüntüsü</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#ffffff; --fg:#16181d; --muted:#5b6270; --line:#e3e6ec; --card:#f7f8fa;
    --busy:#1f8b4c; --wait:#2563c9; --perm:#c3311f; --warn:#9a6300; --idle:#6b7280;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0f1116; --fg:#e6e8ee; --muted:#98a0b0; --line:#262a33; --card:#161922;
      --busy:#4ade80; --wait:#7aa7ff; --perm:#ff8a75; --warn:#ffc266; --idle:#8b93a3;
    }
  }
  :root[data-theme="dark"] {
    --bg:#0f1116; --fg:#e6e8ee; --muted:#98a0b0; --line:#262a33; --card:#161922;
    --busy:#4ade80; --wait:#7aa7ff; --perm:#ff8a75; --warn:#ffc266; --idle:#8b93a3;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
    margin:36px 0 12px; font-weight:600; }
  .meta { color:var(--muted); font-size:13px; font-family:var(--mono); }
  .stats { display:flex; flex-wrap:wrap; gap:8px 20px; margin:18px 0 8px; }
  .stat b { font-size:22px; font-weight:650; letter-spacing:-.02em; }
  .stat span { color:var(--muted); font-size:13px; margin-inline-start:6px; }
  .stat.alert b { color:var(--perm); }
  .caps { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0; }
  .cap { font-size:11.5px; font-family:var(--mono); padding:2px 8px; border-radius:999px;
    border:1px solid var(--line); color:var(--muted); }
  .cap.ok { color:var(--busy); }
  .cap.bad { color:var(--warn); border-color:var(--warn); }
  .warn { border-inline-start:3px solid var(--warn); background:var(--card);
    padding:10px 14px; margin:8px 0; border-radius:0 6px 6px 0; font-size:13.5px; }
  .card { border:1px solid var(--line); border-radius:10px; background:var(--card);
    padding:14px 16px; margin:12px 0; }
  .card h3 { margin:0; font-size:16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pid { font-family:var(--mono); font-size:11.5px; color:var(--muted); font-weight:400; }
  .flags { display:flex; gap:6px; flex-wrap:wrap; }
  .flag { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--warn);
    color:var(--warn); }
  .ws { font-family:var(--mono); font-size:12px; color:var(--muted); margin:8px 0 2px;
    overflow-x:auto; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  th, td { text-align:start; padding:6px 10px 6px 0; font-size:13.5px; vertical-align:top; }
  th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em;
    border-bottom:1px solid var(--line); font-weight:600; }
  tr + tr td { border-top:1px solid var(--line); }
  .name { font-family:var(--mono); font-size:12.5px; white-space:nowrap; }
  .chip { font-size:11.5px; font-family:var(--mono); padding:2px 8px; border-radius:999px;
    border:1px solid currentColor; white-space:nowrap; }
  .chip.unsure { border-style:dashed; opacity:.72; }
  .s-BUSY { color:var(--busy); } .s-WAITING_INPUT { color:var(--wait); }
  .s-WAITING_PERMISSION { color:var(--perm); } .s-STALLED, .s-ERRORED { color:var(--warn); }
  .s-ORPHANED, .s-ENDED, .s-STARTING, .s-UNKNOWN { color:var(--idle); }
  .age { font-family:var(--mono); font-size:12.5px; color:var(--muted); white-space:nowrap; }
  .ev { font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  .title { color:var(--fg); opacity:.85; }
  .empty { color:var(--muted); font-style:italic; }
  footer { margin-top:48px; color:var(--muted); font-size:12px; border-top:1px solid var(--line);
    padding-top:14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>VibeTracker</h1>
  <div class="meta">${esc(new Date(now).toLocaleString())} · ${esc(r.platform)} · ${esc(r.probeKind)} (${esc(r.probePrecision)}) · ${esc(r.claudeDir)}</div>

  <div class="stats">
    <div class="stat"><b>${r.counts.live}</b><span>${tr('canlı oturum')}</span></div>
    <div class="stat"><b>${r.counts.registryEntries}</b><span>${tr('kayıt')}</span></div>
    <div class="stat"><b>${r.counts.dead}</b><span>${tr('ölü')}</span></div>
    <div class="stat${r.counts.reused > 0 ? ' alert' : ''}"><b>${r.counts.reused}</b><span>${tr('PID yeniden kullanım')}</span></div>
    <div class="stat"><b>${r.counts.projects}</b><span>${tr('proje')}</span></div>
    <div class="stat${r.counts.needsYou > 0 ? ' alert' : ''}"><b>${r.counts.needsYou}</b><span>${tr('seni bekliyor')}</span></div>
    <div class="stat"><b>${r.counts.ideWindows}</b><span>${tr('IDE penceresi')}</span></div>
  </div>

  <div class="caps">${Object.entries(r.capabilities)
    .map(
      ([k, v]) =>
        `<span class="cap ${v.ok ? 'ok' : 'bad'}" title="${esc(v.detail ?? '')}">${v.ok ? '✓' : '!'} ${esc(k)}</span>`,
    )
    .join('')}</div>

  ${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}

  ${
    waiting.length > 0
      ? `<h2>${tr('Seni bekleyenler')}</h2>
  <table>
    <tr><th>${tr('Proje')}</th><th>${tr('Oturum')}</th><th>${tr('Durum')}</th><th>${tr('Süre')}</th><th>${tr('Ne üzerinde')}</th></tr>
    ${waiting
      .map(
        ({ p, s }) => `<tr>
      <td>${esc(p.displayName)}</td>
      <td class="name">${esc(sessionLabel(s))}</td>
      <td>${stateChip(s)}</td>
      <td class="age">${esc(activityAge(s, now))}</td>
      <td class="title">${esc(truncate(s.title ?? s.lastPrompt ?? '—', 70))}</td>
    </tr>`,
      )
      .join('')}
  </table>`
      : ''
  }

  <h2>${tr('Projeler')}</h2>
  ${
    r.projects.length === 0
      ? `<p class="empty">${tr('Görünür oturum yok. Bir ajan oturumu başlat ve tekrar dene.')}</p>`
      : r.projects
          .map(
            (p) => `<div class="card">
    <h3>${esc(p.displayName)}
      <span class="pid">${esc(p.projectId)}${p.identityKind !== 'git_root' ? ' · ' + esc(p.identityKind) : ''}</span>
      <span class="flags">${p.flags.map((f) => `<span class="flag">${esc(flagText(f))}</span>`).join('')}</span>
    </h3>
    ${p.workspaces
      .map((w) => {
        const bits: string[] = [];
        if (w.branch) bits.push(w.branch);
        if (w.commitCount !== undefined) bits.push(t`${w.commitCount} commit`);
        if (w.dirtyCount !== undefined) bits.push(t`${w.dirtyCount} kirli`);
        if (w.isWorktree) bits.push('worktree');
        if (w.storageKind !== 'local') bits.push(w.storageKind);
        const label = p.workspaces.length > 1 && w.label ? `<b>${esc(w.label)}</b> · ` : '';
        return `<div class="ws">${label}${esc(w.normPath)}${bits.length ? ' — ' + esc(bits.join(' · ')) : ''}</div>`;
      })
      .join('')}
    <table>
      <tr><th>${tr('Oturum')}</th><th>${tr('Durum')}</th><th>${tr('Süre')}</th><th>${tr('Kanıt')}</th></tr>
      ${p.sessions
        .map(
          (s) => `<tr>
        <td class="name">${esc(sessionLabel(s))}<br><span class="pid">pid ${s.pid}${s.cliVersion ? ' · ' + esc(s.cliVersion) : ''}</span></td>
        <td>${stateChip(s)}</td>
        <td class="age">${esc(activityAge(s, now))}</td>
        <td class="ev">${esc(s.evidence.join(' · '))}${s.title ? `<br><span class="title">"${esc(truncate(s.title, 70))}"</span>` : ''}</td>
      </tr>`,
        )
        .join('')}
    </table>
  </div>`,
          )
          .join('')
  }

  <footer>
    ${tr('Anlık görüntü — canlı değil.')} <code>vt status</code> ${tr('ile yenile.')}
    ${tr('VibeTracker hiçbir projeye yazmaz ve hiçbir ajanla konuşmaz.')}
    ${tr('Anthropic, OpenAI, Google, Microsoft veya Cursor ile ilişkili değildir.')}
  </footer>
</div>
</body>
</html>
`;
}
