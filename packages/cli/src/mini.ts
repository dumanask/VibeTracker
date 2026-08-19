/**
 * `vt mini` — the board as a sticky note.
 *
 * A tracker you have to switch windows to read is a tracker you stop reading.
 * This opens the same dashboard in a small chromeless window and asks Windows
 * to keep it above whatever you are working on, so "is anything waiting for
 * me" is answered by glancing at a corner of the screen.
 *
 * It is the same page and the same data — mini mode is a view of the dashboard,
 * not a second implementation — so nothing can drift between the two.
 */
import {
  openMiniWindow,
  pinWindow,
  findBrowser,
  readMiniState,
  writeMiniState,
  clearMiniState,
  startNote,
  stopNote,
  noteAlive,
  noteSupported,
  type NoteLabels,
  type NoteShape,
} from '@vibetracker/platform';
import { readRuntimeInfo, runtimeFilePath } from '@vibetracker/daemon';
import { fmtPercent, getLang, t, tr, trInto, type Lang } from '@vibetracker/core';
import { dashboardUrl } from './daemon-cmd.ts';

export interface MiniArgs {
  /** Leave the window in the normal z-order. */
  noPin: boolean;
  /** Release an already-pinned window instead of opening one. */
  unpin?: boolean;
  /** Use the browser window even where the native note is available. */
  browser?: boolean;
  /** Which shape to open in. */
  shape?: NoteShape;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 260;

/**
 * The window title Chromium gives an `--app` window, taken from the page.
 *
 * Checked before reusing a remembered pid, because pids get recycled — the
 * defect this whole product was built to catch. Pinning whatever inherited
 * that number would put a stranger's window on top of everything.
 */
const WINDOW_TITLE = 'VibeTracker';

/** The window we opened earlier, if it is still ours and still open. */
async function existingWindow(): Promise<number | null> {
  const state = readMiniState();
  if (!state) return null;
  const found = await pinWindow(state.pid, { checkOnly: true, timeoutMs: 400 });
  if (!found.ok) {
    clearMiniState();
    return null;
  }
  if (found.title !== WINDOW_TITLE) {
    clearMiniState();
    return null;
  }
  return state.pid;
}

/**
 * The words the note draws.
 *
 * Handed over rather than hardcoded: the window is a pure renderer, and this
 * is the only route by which non-ASCII text reaches it. PowerShell 5.1 reads
 * a BOM-less script as the system codepage, so `note.ps1` has to stay pure
 * ASCII and cannot hold a single Turkish diacritic of its own.
 */
function noteLabels(): NoteLabels {
  return {
    waiting: tr('waiting'),
    running: tr('running'),
    idle: tr('idle'),
    off: tr('off'),
    clear: tr('clear'),
    choose: tr('choose what to track'),
    nopick: tr('project not found'),
    empty: tr('no projects tracked'),
    nodaemon: tr('no daemon'),
    product: 'VibeTracker',
    load: tr('system load'),
    addPath: tr('add a folder'),
    chooseDir: tr('Choose the project folder to track'),
    pathAdded: tr('added'),
    pathBad: tr('could not add that folder'),
    pathNotDir: tr('no such directory'),
    pickFail: tr('daemon not answering'),
    pickDenied: tr('daemon refused us'),
    // Spoken. The name goes in front, so these are the rest of the sentence.
    speakWaiting: tr('is now waiting for you'),
    speakMany: tr('projects are now waiting for you'),
    // The same two lines in the other language the catalog ships, because the
    // window may find no voice that speaks this one. Deciding here would be
    // wrong: only the window can see which voices are installed.
    speakWaitingAlt: trInto(altLang(), 'is now waiting for you'),
    speakManyAlt: trInto(altLang(), 'projects are now waiting for you'),
    // `fmtPercent` is the authority on which side the sign goes; asked here
    // with a stand-in number so the window gets the shape, not one answer.
    percent: fmtPercent(0).replace('0', '{0}'),
    voiceNone: tr('no voice'),
    voiceMismatch: tr('language mismatch'),
    // Shown in the title strip while the pointer rests on a button.
    btnPick: tr('choose what to track'),
    btnSpeak: tr('voice alerts'),
    btnFull: tr('full dashboard'),
    btnShade: tr('shade'),
    btnBadge: tr('badge'),
    btnClose: tr('close'),
  };
}

/**
 * The language the note falls back to when nothing speaks the interface
 * language. There are two, so "the other one" is a complete answer; a third
 * would turn this into a preference list.
 */
function altLang(): Lang {
  return getLang() === 'tr' ? 'en' : 'tr';
}

export async function runMini(args: MiniArgs): Promise<number> {
  const info = readRuntimeInfo();
  if (!info) {
    process.stderr.write(tr('The daemon is not running. Start it with `vt daemon`.\n'));
    return 3;
  }

  // ── the native note ──────────────────────────────────────────────
  // Preferred wherever it runs, because the browser cannot give us what this
  // window is for: Chromium draws its own title bar inside the client area of
  // an `--app` window, so it can never be frameless and can never shrink to a
  // badge. That was measured, not assumed — stripping WS_CAPTION changes
  // nothing, and reparenting it into a borderless host renders black.
  if (noteSupported() && !args.browser) {
    const open = noteAlive();
    if (args.unpin) {
      if (open === null) {
        process.stdout.write(tr('No sticky-note window is open.') + '\n');
        return 3;
      }
      stopNote(open);
      process.stdout.write(tr('Sticky-note window closed.') + '\n');
      return 0;
    }
    if (open !== null) {
      process.stdout.write(t`The sticky-note window is already open (pid ${open}).\n`);
      return 0;
    }
    const started = startNote({
      // Neither the url nor the token is handed over: both live in the runtime
      // file the window is pointed at, so neither reaches a command line.
      runtimePath: runtimeFilePath(),
      labels: noteLabels(),
      shape: args.shape,
      // Which voice reads a project name aloud. The words themselves are in
      // the labels; this only says who should say them.
      lang: getLang(),
      langAlt: altLang(),
    });
    if (started.ok) {
      process.stdout.write(t`Sticky-note window opened (pid ${started.pid}).\n`);
      process.stdout.write(
        tr('  Frameless and on top. In the strip: + choose / ♪ voice / full view / shade / badge / close.\n'),
      );
      return 0;
    }
    process.stdout.write(
      tr('Could not start the native window; falling back to the browser one.\n'),
    );
  }

  // The hash never reaches the server — it is a view preference, and the
  // daemon has no business knowing which shape of the page you are looking at.
  const url = `${dashboardUrl(info.port, info.token)}#mini`;

  if (args.unpin) {
    const open = await existingWindow();
    if (open === null) {
      process.stdout.write(tr('No sticky-note window is open.') + '\n');
      return 3;
    }
    const released = await pinWindow(open, { unpin: true, timeoutMs: 2000 });
    process.stdout.write(
      released.ok
        ? tr('No longer kept on top.') + '\n'
        : tr('Could not release it from the top.') + '\n',
    );
    return released.ok ? 0 : 70;
  }

  // A second `vt mini` means "show me the note", not "open another one".
  // Chromium would hand the launch to the process that already owns the
  // profile and exit, leaving nothing to pin — so reuse is not an
  // optimisation here, it is the difference between working and not.
  const already = await existingWindow();
  if (already !== null) {
    const again = await pinWindow(already, { timeoutMs: 2000 });
    process.stdout.write(t`The sticky-note window is already open (pid ${already}).\n`);
    if (!again.ok && !args.noPin) {
      process.stdout.write(tr('Could not keep it on top.') + '\n');
    }
    return 0;
  }

  const browser = findBrowser();
  if (!browser) {
    process.stderr.write(
      tr('No Chromium-based browser found (Edge, Chrome, Brave, Vivaldi).\n'),
    );
    process.stderr.write(tr('You can open the dashboard yourself:\n'));
    process.stdout.write(`${url}\n`);
    return 3;
  }

  const win = openMiniWindow({
    url,
    width: args.width ?? DEFAULT_WIDTH,
    height: args.height ?? DEFAULT_HEIGHT,
    x: args.x,
    y: args.y,
  });
  if (!win) {
    process.stderr.write(t`Could not open the window: ${browser.path}\n`);
    return 70;
  }

  writeMiniState({ pid: win.pid, startedAt: Date.now() });
  process.stdout.write(t`Sticky-note window opened · ${browser.family} · pid ${win.pid}\n`);

  if (args.noPin) {
    process.stdout.write(tr('Not kept on top (--no-pin).\n'));
    return 0;
  }

  const pinned = await pinWindow(win.pid);
  if (pinned.ok) {
    process.stdout.write(tr('Kept above your other windows.\n'));
    return 0;
  }

  // Every failure here leaves a working window; only the pinning is missing.
  // Saying which part failed is the difference between a limitation and a bug.
  const why =
    pinned.reason === 'unsupported'
      ? tr('Pinning a browser window on top is only possible on Windows.')
      : pinned.reason === 'no-window'
        ? tr('The window did not appear in time — it could not be pinned.')
        : pinned.reason === 'process-gone'
          ? tr('The window closed as soon as it opened.')
          : tr('Could not keep it on top.');
  process.stdout.write(`${why}\n`);
  // The honest alternative, not a shrug. Pinning a *browser* window needs
  // SetWindowPos, and that is Win32 -- but the desktop app owns its own
  // windows and can ask for always-on-top on all three platforms. Saying so
  // here is the difference between a limitation and a dead end.
  if (pinned.reason === 'unsupported') {
    process.stdout.write(
      tr('For a real always-on-top sticky note, install the desktop app: tray menu -> Post-it.\n'),
    );
  }
  process.stdout.write(tr('The window is open anyway; you can pin it yourself.\n'));
  return 0;
}
