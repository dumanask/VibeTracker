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
import { readRuntimeInfo } from '@vibetracker/daemon';
import { getLang, t, tr, trInto, type Lang } from '@vibetracker/core';
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
    waiting: tr('bekliyor'),
    running: tr('çalışıyor'),
    idle: tr('boşta'),
    off: tr('kapalı'),
    clear: tr('temiz'),
    choose: tr('izlenecekleri seç'),
    nopick: tr('proje bulunamadı'),
    empty: tr('izlenen proje yok'),
    nodaemon: tr('daemon yok'),
    product: 'VibeTracker',
    load: tr('sistem yükü'),
    addPath: tr('klasör seç'),
    chooseDir: tr('İzlenecek proje klasörünü seç'),
    pathAdded: tr('eklendi'),
    pathBad: tr('klasör eklenemedi'),
    // Spoken. The name goes in front, so these are the rest of the sentence.
    speakWaiting: tr('beklemeye geçti'),
    speakMany: tr('proje beklemeye geçti'),
    // The same two lines in the other language the catalog ships, because the
    // window may find no voice that speaks this one. Deciding here would be
    // wrong: only the window can see which voices are installed.
    speakWaitingAlt: trInto(altLang(), 'beklemeye geçti'),
    speakManyAlt: trInto(altLang(), 'proje beklemeye geçti'),
    voiceNone: tr('ses yok'),
    voiceMismatch: tr('dil eşleşmedi'),
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
    process.stderr.write(tr('Daemon çalışmıyor. Önce `vt daemon` çalıştır.\n'));
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
        process.stdout.write(tr('Açık bir post-it penceresi yok.') + '\n');
        return 3;
      }
      stopNote(open);
      process.stdout.write(tr('Post-it penceresi kapatıldı.') + '\n');
      return 0;
    }
    if (open !== null) {
      process.stdout.write(t`Post-it penceresi zaten açık (pid ${open}).\n`);
      return 0;
    }
    const started = startNote({
      url: dashboardUrl(info.port, info.token),
      token: info.token,
      labels: noteLabels(),
      shape: args.shape,
      // Which voice reads a project name aloud. The words themselves are in
      // the labels; this only says who should say them.
      lang: getLang(),
      langAlt: altLang(),
    });
    if (started.ok) {
      process.stdout.write(t`Post-it penceresi açıldı (pid ${started.pid}).\n`);
      process.stdout.write(
        tr('  Çerçevesiz ve üstte. Başlıkta: + seç / ♪ ses / tam görünüm / şerit / rozet / kapat.\n'),
      );
      return 0;
    }
    process.stdout.write(
      tr('Yerel pencere başlatılamadı; tarayıcı penceresine düşülüyor.\n'),
    );
  }

  // The hash never reaches the server — it is a view preference, and the
  // daemon has no business knowing which shape of the page you are looking at.
  const url = `${dashboardUrl(info.port, info.token)}#mini`;

  if (args.unpin) {
    const open = await existingWindow();
    if (open === null) {
      process.stdout.write(tr('Açık bir post-it penceresi yok.') + '\n');
      return 3;
    }
    const released = await pinWindow(open, { unpin: true, timeoutMs: 2000 });
    process.stdout.write(
      released.ok
        ? tr('Artık üstte tutulmuyor.') + '\n'
        : tr('Üstte tutma kaldırılamadı.') + '\n',
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
    process.stdout.write(t`Post-it penceresi zaten açık (pid ${already}).\n`);
    if (!again.ok && !args.noPin) {
      process.stdout.write(tr('Üstte tutulamadı.') + '\n');
    }
    return 0;
  }

  const browser = findBrowser();
  if (!browser) {
    process.stderr.write(
      tr('Chromium tabanlı bir tarayıcı bulunamadı (Edge, Chrome, Brave, Vivaldi).\n'),
    );
    process.stderr.write(tr('Paneli kendin açabilirsin:\n'));
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
    process.stderr.write(t`Pencere açılamadı: ${browser.path}\n`);
    return 70;
  }

  writeMiniState({ pid: win.pid, startedAt: Date.now() });
  process.stdout.write(t`Post-it penceresi açıldı · ${browser.family} · pid ${win.pid}\n`);

  if (args.noPin) {
    process.stdout.write(tr('Üstte tutulmuyor (--no-pin).\n'));
    return 0;
  }

  const pinned = await pinWindow(win.pid);
  if (pinned.ok) {
    process.stdout.write(tr('Diğer pencerelerin üstünde tutuluyor.\n'));
    return 0;
  }

  // Every failure here leaves a working window; only the pinning is missing.
  // Saying which part failed is the difference between a limitation and a bug.
  const why =
    pinned.reason === 'unsupported'
      ? tr('Üstte tutma şimdilik yalnızca Windows üzerinde çalışıyor.')
      : pinned.reason === 'no-window'
        ? tr('Pencere zamanında görünmedi — üstte tutulamadı.')
        : pinned.reason === 'process-gone'
          ? tr('Pencere açılır açılmaz kapandı.')
          : tr('Üstte tutulamadı.');
  process.stdout.write(`${why}\n`);
  process.stdout.write(tr('Pencere yine de açık; elle üstte tutabilirsin.\n'));
  return 0;
}
