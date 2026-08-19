/**
 * The pinned note is a PowerShell script, so nothing compiles it and no
 * type checker reads it. What can be checked here is everything about it that
 * is a *contract* rather than a drawing decision — and each of these was a
 * real failure before it was a test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(fileURLToPath(new URL('../src/', import.meta.url)), 'note.ps1');
const source = readFileSync(SCRIPT, 'utf8');

/**
 * The whole reason the window exists is that a browser one could not do this.
 * If the form ever grows a border or loses TopMost, it stops being a sticky
 * note and nothing else would notice.
 */
test('the window is frameless and stays on top', () => {
  assert.match(source, /FormBorderStyle\s*=\s*FormBorderStyle\.None/);
  assert.match(source, /TopMost\s*=\s*true/);
});

test('all three sizes exist and can be reached', () => {
  assert.match(source, /enum Shape \{ Full = 0, Shade = 1, Badge = 2 \}/);
  // The badge has no room for buttons, so without a way out it is a state you
  // can enter with the mouse and only leave with the keyboard. Double-click
  // was that way out and did not work: handing the press to
  // `WM_NCLBUTTONDOWN` starts a modal drag loop inside DefWindowProc, and the
  // loop swallows the second click. So the badge is dragged by hand, and a
  // press that moved nothing counts as a click.
  assert.match(source, /if \(!badgeMoved\) Apply\(Shape\.Full\)/);
  assert.match(source, /MouseButtons\.Right.*Cycle\(\)/s);
  assert.ok(
    !source.includes('MouseDoubleClick'),
    'double-click cannot fire under a caption drag: see OnMouseDownH',
  );
});

/**
 * It renders the engine's summary. The moment it starts deciding what
 * "waiting" means, there are two answers to one question and the terminal and
 * the note can disagree about the same project.
 */
test('the note reads the summary rather than deriving one', () => {
  assert.match(source, /\$p\.summary/);
  for (const derived of ['WAITING_PERMISSION', 'ORPHANED', 'lastActivityAt']) {
    assert.ok(
      !source.includes(derived),
      `note.ps1 mentions ${derived}: it is re-deriving state instead of rendering it`,
    );
  }
});

/**
 * Every visible word arrives from the catalog. PowerShell 5.1 reads a
 * BOM-less script as the system codepage, so a Turkish string written here
 * would render as mojibake — which it did, the first time this ran.
 */
test('no Turkish is written into the script itself', () => {
  assert.match(source, /\$LabelsPath/);
  assert.match(source, /T\("waiting"/);
  // The locale trap: invariant uppercase turns "bekliyor" into "BEKLIYOR"
  // with a dotless I, which is a different letter.
  assert.ok(!source.includes('ToUpperInvariant'), 'locale-unsafe casing is back');
});

test('the script is pure ascii, so no encoding can mangle it', () => {
  const buf = readFileSync(SCRIPT);
  const bad = [...buf].findIndex((b) => b > 0x7f);
  assert.equal(bad, -1, `non-ascii byte at offset ${bad}`);
});

/**
 * The note polls the daemon and must survive it going away: a tracker that
 * disappears when the thing it tracks restarts is worse than no tracker.
 */
test('a daemon that stops is a state, not a crash', () => {
  assert.match(source, /\$note\.Connected = \$false/);
  assert.match(source, /nodaemon/);
});

/**
 * The columns are measured, not stacked.
 *
 * Every cell used to be placed relative to the width of the cell to its
 * right, one row at a time, so rows with different words put their numbers in
 * different places. The grid is what makes a twelve-project list scannable,
 * and it is invisible to every other test here.
 */
test('rows are drawn against one measured column layout', () => {
  assert.match(source, /Grid Measure\(Graphics g, List<Row> rows\)/);
  assert.match(source, /void PaintRow\(Graphics g, Row r, int y, Grid lay\)/);
  // Vertical centring too: three fonts on one row line up only if each is
  // placed by its own measured height.
  assert.match(source, /y \+ \(RowH - sz\.Height\) \/ 2f/);
});

/**
 * Waiting and running are simultaneous facts about a project. Naming one and
 * printing `live/total` beside it made a project with three sessions waiting
 * and one working read as "3 bekliyor  5/5".
 */
test('both counts are drawn, and neither is live/total', () => {
  assert.match(source, /string WaitText\(Row r\)/);
  assert.match(source, /string RunText\(Row r\)/);
  assert.ok(
    !/r\.Live \+ "\/" \+ r\.Total/.test(source),
    'the ambiguous live/total pair is back',
  );
});

/**
 * The chooser.
 *
 * A pinned window whose contents you cannot change is a window you eventually
 * stop looking at, so the `+` opens a list of every project the daemon knows —
 * not only the ones running, because the project you want to add is usually
 * the one you just closed.
 */
test('the note can choose which projects it follows', () => {
  assert.match(source, /public void TogglePicking\(\)/);
  assert.match(source, /rPick\.Contains\(e\.Location\)/);
  // The list and the tick state both arrive from the daemon: the window is no
  // more allowed to decide what "followed" means than what "waiting" means.
  assert.match(source, /api\/v1\/candidates/);
  assert.match(source, /api\/v1\/tracking/);
  assert.match(source, /\$x\.tracked/);
  // A delta, never a whole selection. This window lists what the daemon gave
  // it — six rows at 340 pixels — so posting its visible set as the truth
  // would silently unfollow every project it did not show.
  assert.match(source, /add = @\(\$note\.ToggledId\)/);
  assert.match(source, /remove = @\(\$note\.ToggledId\)/);
  assert.ok(!/selected = \$sel/.test(source), 'the note is posting a whole selection again');
});

test('choosing forces the full shape, and a poll cannot resize it mid-click', () => {
  // Picking through a one-line strip or an 84-pixel badge is not a smaller
  // version of the task.
  assert.match(source, /if \(Picking && OnPickOpen != null\) OnPickOpen\(\);/);
  assert.match(source, /TogglePicking\(\) \{[\s\S]*?Apply\(Shape\.Full\);/);
  assert.match(source, /if \(-not \$note\.Picking\) \{ \$note\.Fit\(\) \}/);
});

/**
 * The glow is a claim, and claims cost.
 *
 * A window pinned above your editor that burns a core to look alive is a
 * worse tool than a still one, so the beat is gated on there being something
 * to say: nothing waiting and nothing running means no repaints at all.
 */
test('the animation stops when there is nothing to animate', () => {
  assert.match(source, /bool Alive\(\)/);
  assert.match(source, /if \(!Alive\(\)\) return;/);
  assert.match(source, /if \(Picking\) return false;/);
});

/**
 * The trace next to each name.
 *
 * Its one real claim is about the gaps: `-1` marks a minute before anyone was
 * watching, and drawing that at zero would put a floor under a project that
 * never sat on one — a lie the eye reads instantly and cannot check.
 */
test('unwatched minutes break the trace instead of grounding it', () => {
  assert.match(source, /if \(v < 0\) \{ have = false; continue; \}/);
  // And the series itself is the daemon's, not something reconstructed here
  // from the counts on screen.
  assert.match(source, /\$p\.momentum/);
});

/**
 * Fleet load, not average completion.
 *
 * Averaging progress across projects is the most misleading number a tracker
 * can print, and the top strip is the most-read pixel in the window. It shows
 * the engine's `load` verbatim or it shows a dash.
 */
test('the top strip renders the engine load and does not compute one', () => {
  assert.match(source, /\$r\.load\.percent/);
  assert.match(source, /LoadPercent < 0 \|\| LoadLive == 0/);
  // Waiting and running are drawn as two lengths in one bar, because
  // "everything is running" and "everything is blocked" are the same load.
  assert.match(source, /int runW = .*LoadRunning/);
  assert.match(source, /int waitW = .*LoadWaiting/);
});

/**
 * Naming a directory.
 *
 * The chooser can only list what the transcript directory remembers, so this
 * is the only route for a repository no agent has opened. It must stay a
 * thing the user picks: nothing here may grow into a search of their disk.
 */
test('a folder can be named, and the daemon is the one that identifies it', () => {
  assert.match(source, /api\/v1\/projects\/path/);
  // No identity work in the window: no git, no package files, no path
  // normalisation of its own.
  for (const forbidden of ['rev-list', 'package.json', 'git:']) {
    assert.ok(!source.includes(forbidden), `note.ps1 mentions ${forbidden}: it is resolving identity itself`);
  }
});

/**
 * The dialog is the shell's own, modern one.
 *
 * `FolderBrowserDialog` is the tree from Windows 2000: no address bar, no
 * search, and no way to paste the path you already have — which is what people
 * actually do. `IFileOpenDialog` with `FOS_PICKFOLDERS` is what every other
 * application shows and what .NET Framework never exposed.
 *
 * The interop is declared by hand, and the one way to get it wrong is silent:
 * a COM interface is an array of function pointers, so omitting a method you
 * do not call shifts every method after it onto the wrong slot. Nothing type
 * checks this file, so the vtable is pinned here.
 */
test('the folder picker is the shell dialog, not the Windows 2000 tree', () => {
  assert.match(source, /IFileOpenDialog/);
  assert.match(source, /FOS_PICKFOLDERS\s*=\s*0x00000020/);
  // FORCEFILESYSTEM, or the shell returns libraries and cloud locations —
  // neither of which is a directory the scan can visit.
  assert.match(source, /FOS_FORCEFILESYSTEM\s*=\s*0x00000040/);
  assert.match(source, /DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7/i);

  // The vtable, in order. `GetResult` is the 18th slot of IFileDialog and the
  // only one whose position we depend on being right.
  const iface = /interface IFileOpenDialog \{([\s\S]*?)^\}/m.exec(source);
  assert.ok(iface, 'IFileOpenDialog declaration not found');
  const methods = [...iface[1]!.matchAll(/int (\w+)\(/g)].map((m) => m[1]!);
  assert.equal(methods[0], 'Show');
  assert.equal(methods.indexOf('GetResult'), 17);
  assert.equal(methods.length, 26);

  // The legacy dialog stays as a fallback, but only when the shell one could
  // not be created — never when the user simply pressed Cancel.
  assert.match(source, /if \(-not \[VibeTracker\.Folders\]::Unavailable\) \{ return \$picked \}/);
});

/**
 * Speech.
 *
 * Three rules keep it from becoming noise, and each was a way of being
 * annoying rather than useful. It announces a transition, so an hour-old
 * block is silent. It says nothing on the first poll, or a restart reads the
 * whole board aloud. And more than two at once becomes a count.
 */
test('speaking announces changes, never states', () => {
  assert.match(source, /\$now\[\$k\] -gt \$script:prevWaiting\[\$k\]/);
  assert.match(source, /if \(\$null -eq \$script:prevWaiting\) \{ \$script:prevWaiting = \$now; return \}/);
  assert.match(source, /if \(\$turned\.Count -le 2\)/);
  // The sentence is assembled from catalog text, like every other word here.
  assert.match(source, /\$note\.L\['speakWaiting'\]/);
  // And it is off until asked for: a window that starts talking on first run
  // is a window people uninstall.
  assert.match(source, /speak = \$false/);
});

/**
 * Rows are no longer a fixed height, because one of them can open to show
 * what the agent is actually doing. Every place that turns a y coordinate
 * into a row has to agree about that or clicks land on the wrong project.
 */
test('row geometry is computed in one place once rows can open', () => {
  assert.match(source, /int RowHeight\(Row r\)/);
  assert.match(source, /Row RowAt\(int y\)/);
  assert.match(source, /int ContentHeight\(\)/);
});

/**
 * What the agent is doing is free text it wrote. It is redacted in the engine
 * before it is ever sent, which is the only reason a window sitting above
 * everything else may show a prompt at all — so this window must not be
 * fetching that text from anywhere else.
 */
test('the detail line is the summary lead and nothing else', () => {
  assert.match(source, /\$row\.Lead = \[string\]\$s\.leadTitle/);
  // Never from a file. The redaction that makes this text safe to show runs
  // in the engine, on the way out of the transcript; a window that opened one
  // itself would be showing raw prompts on top of everything else.
  assert.ok(!/\.jsonl/.test(source), 'the note is opening transcripts');
  const renderer = source.split("$source = @'")[1]?.split(/^'@$/m)[0] ?? '';
  assert.ok(renderer.length > 1000, 'the C# block moved and this test stopped checking anything');
  assert.ok(!/System\.IO|System\.Net/.test(renderer), 'the renderer reads files or opens sockets');
});

/**
 * The window steps out of the way while the dialog is up.
 *
 * Ownership is not enough: a dialog owned by this window sits above it in the
 * ordinary z-order, but `TopMost` is `WS_EX_TOPMOST` and that outranks
 * ownership. The picker opened *behind* the note, which then went on receiving
 * the clicks meant for it — two projects were unfollowed that way before this
 * was understood. Restored in `finally`, because a note left below the editor
 * is a note that has stopped doing its one job.
 */
test('always-on-top is dropped for the length of a modal dialog', () => {
  assert.match(source, /\$wasTop = \$note\.TopMost/);
  assert.match(source, /\$note\.TopMost = \$false/);
  assert.match(source, /finally \{\s*\$note\.TopMost = \$wasTop\s*\}/);
});

/**
 * The one thing this window exists to do.
 *
 * `TopMost = true` in the constructor is not enough, and the way it fails is
 * worse than not setting it: assigning `Location` before the handle exists —
 * which is exactly what restoring a remembered position does — loses
 * `WS_EX_TOPMOST`. So the note comes up looking perfectly right and simply
 * stops staying above the editor, on every launch **after the first time you
 * move it**, with nothing on screen to say so.
 *
 * Measured by A/B on this machine, same daemon, same labels: with a remembered
 * position the window reported `ex=0x00050000`, with a fresh one
 * `ex=0x00050008`. Both halves of the fix are load-bearing — the property,
 * because WinForms consults it every time it rebuilds bounds, and the explicit
 * `SetWindowPos`, because the property setter is a no-op when the stored value
 * already matches the value being assigned.
 */
test('the note asserts its own z-order rather than trusting the constructor', () => {
  assert.match(source, /public void PinTop\(\)/);
  // The property, so WinForms' own belief is corrected...
  assert.match(source, /TopMost = false;\s*\n\s*TopMost = true;/);
  // ...and the call, so the window moves now.
  assert.match(source, /SetWindowPos\(Handle, new IntPtr\(-1\)/);
  // Asserted once the handle exists, and again on every shape change, because
  // a resize is the other moment WinForms rebuilds bounds.
  assert.match(source, /\$note\.PinTop\(\)/);
  assert.match(source, /scroll = 0;\s*\n\s*PinTop\(\);/);
});

/**
 * Four meters, four meanings, and none of them borrowing another's credibility.
 *
 * The note and the dashboard draw the same projects, and two surfaces of one
 * product disagreeing about the same number is what destroys trust in both.
 * When the dashboard learned to show a model's estimate the note still showed a
 * dash for it — so the same project read "70%" in one window and "no idea" in
 * the other.
 *
 * The fix is not to show it the same way. A counted number is filled and can
 * glow; a coarse one is outlined; a model's guess is outlined *in amber* and
 * never glows, because the travelling highlight is reserved for numbers that
 * came from counting something.
 */
test('a model estimate is drawn as one, and only when nothing was counted', () => {
  assert.match(source, /public bool Guess;/);
  // The counting engine wins; the model fills in behind it.
  assert.match(source, /\$p\.progress\.percent\) \{[\s\S]{0,200}?\} elseif \(\$p\.digest/);
  // Amber, outlined, no glow.
  assert.match(source, /if \(r\.Guess\) \{[\s\S]{0,300}?new Pen\(Amber\)\)/);
  // And the label says it is an estimate rather than a measurement.
  assert.match(source, /r\.Approximate \|\| r\.Guess \? "~"/);
  assert.match(source, /r\.Guess \? Amber : Ink/);
});

/**
 * A remembered position that is no longer a place.
 *
 * This is the failure it is for, observed rather than imagined: the note was
 * last put at x=2050 on a second display, the display went away, and the
 * window was recreated at (2050,514)-(2520,734) on a machine whose only screen
 * is 1920 wide. The process was alive, `IsWindowVisible` said true, the tray
 * menu had done its job -- and there was nothing on screen. From the outside
 * it looks exactly like a menu item that does nothing.
 *
 * The old test was `x -ge 0`, which is wrong twice: it accepts a position on a
 * monitor that is gone, and it rejects a monitor arranged to the left of the
 * primary one, whose coordinates are legitimately negative.
 *
 * Run rather than pattern-matched. The predicate is four lines and a text
 * assertion would have passed on the broken version too -- what needed proving
 * is that it answers correctly for a real screen layout.
 */
test('a position on a monitor that is gone is not restored', { skip: process.platform !== 'win32' ? 'PowerShell yok' : false }, () => {
  const fn = /function Test-OnScreen[\s\S]*?\n\}/.exec(source);
  assert.ok(fn, 'Test-OnScreen kayboldu');

  const probe = [
    fn[0],
    'Add-Type -AssemblyName System.Windows.Forms',
    '$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    // Far to the right of every screen: the exact shape of the real failure.
    '$far = Test-OnScreen ($wa.Right + 200) 514 470 220',
    // The primary screen's own corner, which must always be acceptable.
    '$home_ = Test-OnScreen ($wa.Left + 40) ($wa.Top + 40) 470 220',
    // Mostly off the right edge, with a sliver showing: not enough to grab.
    '$sliver = Test-OnScreen ($wa.Right - 20) ($wa.Top + 40) 470 220',
    'Write-Output ("$far $home_ $sliver")',
  ].join('\n');

  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probe],
    { encoding: 'utf8', timeout: 30_000 },
  ).trim();

  assert.equal(out, 'False True False', `Test-OnScreen yanlış cevap verdi: ${out}`);
});

test('the note comes home when a display disappears under it', () => {
  // The same rule at the other moment. Undocking a laptop strands the window
  // just as surely as restarting after the monitor was unplugged, and a note
  // that can only be rescued by deleting a JSON file is not rescued.
  assert.match(source, /SystemEvents\]::add_DisplaySettingsChanged/);
  assert.match(source, /Get-HomeCorner/);
  // Unhooked on close: SystemEvents holds a static reference, so a handler
  // left attached keeps the closed window's whole graph alive.
  assert.match(source, /remove_DisplaySettingsChanged/);
});
