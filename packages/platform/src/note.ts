/**
 * Launching and tracking the native note window.
 *
 * The window itself is `note.ps1` — a frameless, always-on-top WinForms form
 * that renders `/api/v1/overview` and nothing else. This module is the Node
 * side of it: start it, remember it, stop it.
 *
 * Two things are deliberately kept out of the PowerShell:
 *
 * - **Words.** Every string it draws is handed to it in a JSON file written
 *   from the same catalog the terminal and the dashboard read. A window that
 *   coined its own labels would be a third place for a translation to go
 *   missing, and the first casualty would be Turkish diacritics — the script
 *   has to be pure ASCII, because PowerShell 5.1 reads a BOM-less `.ps1` as
 *   the system codepage and mangles anything else.
 * - **Judgement.** It draws the summary the engine computed. It does not
 *   decide what "waiting" means.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './dirs.ts';

const NOTE_SCRIPT = fileURLToPath(new URL('./note.ps1', import.meta.url));

export type NoteShape = 'Full' | 'Shade' | 'Badge';

export interface NoteState {
  pid: number;
  startedAt: number;
}

export function noteStatePath(): string {
  return join(dataDir(), 'note.json');
}

/** Window geometry and shape, owned by the note and persisted across runs. */
export function noteWindowStatePath(): string {
  return join(dataDir(), 'note-window.json');
}

export function noteLabelsPath(): string {
  return join(dataDir(), 'note-labels.json');
}

export function readNoteState(): NoteState | null {
  try {
    const parsed = JSON.parse(readFileSync(noteStatePath(), 'utf8')) as Partial<NoteState>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export function clearNoteState(): void {
  try {
    unlinkSync(noteStatePath());
  } catch {
    /* already gone */
  }
}

/** Is the note we launched still running? */
export function noteAlive(): number | null {
  const state = readNoteState();
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
    return state.pid;
  } catch {
    clearNoteState();
    return null;
  }
}

export interface NoteLabels {
  waiting: string;
  running: string;
  idle: string;
  off: string;
  clear: string;
  empty: string;
  nodaemon: string;
  product: string;
  choose: string;
  nopick: string;
  /** The fleet-load strip along the top. */
  load: string;
  /** The chooser's one action, and the folder dialog's own prompt. */
  addPath: string;
  chooseDir: string;
  /** What the title strip says after a directory was, or was not, accepted. */
  pathAdded: string;
  pathBad: string;
  /** The named directory is not a directory. */
  pathNotDir: string;
  /**
   * Why the chooser is empty, when it is empty for a reason.
   *
   * Two of them, because they call for different things from the person
   * reading: a daemon that is not answering is waited out, a daemon that
   * refuses us is a credential that has to be replaced. Neither of them is
   * "you have no projects", which is what the window used to say for both.
   */
  pickFail: string;
  pickDenied: string;
  /**
   * Spoken, not drawn. Read out after the project's name, so the sentence is
   * assembled in the catalog's own word order rather than in the window's:
   * "Saspera beklemeye gecti" and "Saspera is now waiting" put the name in
   * the same place, and a language that does not can translate around it.
   */
  speakWaiting: string;
  speakMany: string;
  /**
   * The same two sentences in the other language the catalog ships.
   *
   * Spoken only when no installed voice speaks the interface language. A voice
   * that cannot pronounce Turkish does not decline to read it — it reads it
   * with English phonetics, which is worse than saying the English sentence in
   * the accent it was written for. Measured here: SAPI5 sees two voices and
   * WinRT three, all `en-US`, so on this machine that is not a corner case.
   */
  speakWaitingAlt: string;
  speakManyAlt: string;
  /** Said by the strip, not by the voice: which voice answered, and whether it fits. */
  voiceNone: string;
  voiceMismatch: string;
  /**
   * What each title-bar button does, said in the strip while the pointer is
   * over it.
   *
   * The buttons are 14 pixels square and their glyphs are a plus, a note, an
   * arrow, a dash, a square and a cross — legible as marks, not as meanings.
   * The command line printed the key once at launch, which helps the first
   * time and never again. A tooltip would be the usual answer and the wrong
   * one here: a floating yellow box over a chromeless instrument, in a window
   * that already has a line for saying what just happened.
   */
  btnPick: string;
  btnSpeak: string;
  btnFull: string;
  btnShade: string;
  btnBadge: string;
  btnClose: string;
}

export interface StartNoteOptions {
  url: string;
  token: string;
  /**
   * Where the daemon publishes the port and token it is using now.
   *
   * The window is handed both at launch, which is enough for as long as the
   * daemon that published them keeps running -- and no longer. Passing the file
   * as well lets a window that has been refused go and look again instead of
   * spending the rest of its life talking to a daemon that no longer exists.
   */
  runtimePath?: string;
  labels: NoteLabels;
  shape?: NoteShape;
  /**
   * Two-letter language tag, used only to pick a speech voice.
   *
   * Not a second copy of the locale: every word the window draws still comes
   * from the labels. This says which of the installed voices should read them,
   * because a Turkish sentence in an English voice is worse than silence.
   */
  lang?: string;
  /**
   * The language of `speakWaitingAlt` / `speakManyAlt`.
   *
   * The window falls back to those words when nothing installed speaks `lang`.
   * Passed separately because the choice is the window's to make — it is the
   * only side that can see which voices exist.
   */
  langAlt?: string;
}

export type StartNoteResult =
  | { ok: true; pid: number }
  | { ok: false; reason: 'unsupported' | 'failed' };

/** Quote one value for a PowerShell single-quoted string literal. */
function psQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Start the note.
 *
 * Launched through PowerShell's own `Start-Process` rather than directly with
 * `spawn(..., { detached: true })`, which does not survive here: measured, a
 * directly-spawned child dies the instant this command exits, before running
 * its first line, because it still shares our console and that console goes
 * away with us. `detached` plus `windowsHide` does not fix it — the two flags
 * ask for conflicting things on Windows.
 *
 * `Start-Process -PassThru` gives back the real pid, which is what makes the
 * window stoppable later; a launcher we could not identify afterwards would
 * leave the user with a window only the task manager can close.
 */
export function startNote(opts: StartNoteOptions): StartNoteResult {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };

  try {
    mkdirSync(dataDir(), { recursive: true });
    // Written as UTF-8 and read back with an explicit encoding: this is the
    // one channel by which non-ASCII text reaches the window at all.
    writeFileSync(noteLabelsPath(), JSON.stringify(opts.labels, null, 2), 'utf8');
  } catch {
    return { ok: false, reason: 'failed' };
  }

  const inner = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    NOTE_SCRIPT,
    '-Url',
    opts.url,
    '-Token',
    opts.token,
    '-StatePath',
    noteWindowStatePath(),
    '-LabelsPath',
    noteLabelsPath(),
  ];
  if (opts.runtimePath) inner.push('-RuntimePath', opts.runtimePath);
  if (opts.shape) inner.push('-Mode', opts.shape);
  if (opts.lang) inner.push('-Lang', opts.lang);
  if (opts.langAlt) inner.push('-LangAlt', opts.langAlt);

  // `-WindowStyle Hidden` hides the launcher's console, not the note: the
  // script hosts a WinForms message loop, so its terminal would otherwise sit
  // behind the window doing nothing.
  const launcher =
    `$p = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden ` +
    `-ArgumentList @(${inner.map(psQuote).join(',')}); ` +
    `[Console]::Out.Write($p.Id)`;

  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    const pid = Number((r.stdout ?? '').trim());
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'failed' };
    writeFileSync(
      noteStatePath(),
      `${JSON.stringify({ pid, startedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    );
    return { ok: true, pid };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Close the note. Unlike the browser window, this process is entirely ours. */
export function stopNote(pid: number): boolean {
  let ok = false;
  try {
    process.kill(pid);
    ok = true;
  } catch {
    ok = false;
  }
  if (process.platform === 'win32' && !ok) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    ok = r.status === 0;
  }
  clearNoteState();
  return ok;
}

/** Whether the native note can run here at all. */
export function noteSupported(): boolean {
  return process.platform === 'win32' && existsSync(NOTE_SCRIPT);
}
