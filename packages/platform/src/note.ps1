# The pinned note: a frameless, always-on-top readout of the board.
#
# Why this is not a browser window. Chromium draws its own title bar inside
# the client area of an `--app` window, so no amount of Win32 style stripping
# removes it -- measured, not assumed -- and a 32-pixel browser chrome on top of
# a 76-pixel badge is absurd. Collapsing to icon size therefore requires a
# window we own. WinForms is already on every Windows machine, so owning one
# costs no dependency.
#
# What keeps it from becoming a second product: this file contains no logic.
# It renders `/api/v1/overview` and nothing else. Every number on screen --
# what a project's agents are doing, how far it has got, whether it is being
# tracked -- was decided by the engine and is drawn here verbatim. When the
# rules change, they change in one place and this follows without being edited.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$StatePath = '',
  # Every visible word comes from here. The file is written by the CLI from
  # the same catalog the terminal and the dashboard use, which is what keeps
  # this window from becoming a third place where English quietly wins and
  # Turkish quietly loses its diacritics.
  [string]$LabelsPath = '',
  [string]$Mode = '',
  # Which voice to prefer when reading a project name out loud. Two letters,
  # matched against the installed voices' cultures.
  [string]$Lang = '',
  # The other language the labels were shipped in. Used only when no installed
  # voice speaks `-Lang`: the sentence is then said in this one, because a
  # voice that cannot pronounce the interface language will mangle it, and a
  # correctly-read English line beats a mauled Turkish one.
  [string]$LangAlt = '',
  # Where the daemon publishes the port and token it is currently using.
  #
  # The window is launched with both as arguments, and for the length of one
  # daemon that is enough. It is not enough for the length of one *window*: the
  # daemon rotates nothing now, but it can move port, and it can be reinstalled
  # under this window while the window is still up. Re-reading the file after a
  # refusal costs one file read on a path that was already failing, and turns
  # "the post-it went dead at some point last night" into a two-second gap.
  [string]$RuntimePath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace VibeTracker {

/// <summary>One project's row, exactly as the engine described it.</summary>
public class Row {
  public string Name = "";
  public string Kind = "none";     // waiting | running | idle | none
  public int Waiting, Running, Live, Total, Urgency;
  public double Percent = -1;      // negative means "no honest number"
  public bool Approximate;
  public string Lead = "";
  /// <summary>
  /// The last twenty-four minutes, oldest first: how many sessions this
  /// project had engaged in each. `-1` marks a minute before anyone was
  /// watching, and is drawn as a gap rather than as a floor.
  /// </summary>
  public int[] Spark = new int[0];
}

/// <summary>One project you could choose to follow.</summary>
public class Pick {
  public string Id = "";
  public string Name = "";
  public bool On;
}

/// <summary>
/// The three sizes, in Winamp's vocabulary: the full list, the "windowshade"
/// strip, and a badge. Each is a different answer to "how much screen is this
/// worth right now", not a different program.
/// </summary>
public enum Shape { Full = 0, Shade = 1, Badge = 2 }

// -- the folder picker ---------------------------------------------------
//
// `FolderBrowserDialog` is the tree from Windows 2000: no address bar, no
// search, no way to paste or type a path, no recent places, and the actual
// disk sitting under a scrolling list of shell namespace entries. It is not a
// styling complaint -- the dialog cannot do the thing people do, which is
// paste the path they already have.
//
// Every other application on the machine shows `IFileOpenDialog` with
// `FOS_PICKFOLDERS`. It has shipped since Vista; .NET Framework simply never
// exposed it, and .NET Core's `AutoUpgradeEnabled` came far too late for the
// runtime that is already on every Windows box. So it is declared by hand.
// The interop is the price of the dialog people expect, and it costs no
// dependency at all: the shell is already there.

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  [PreserveSig] int BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  [PreserveSig] int GetParent(out IShellItem ppsi);
  [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
  [PreserveSig] int GetAttributes(uint mask, out uint attribs);
  [PreserveSig] int Compare(IShellItem psi, uint hint, out int order);
}

/// <summary>
/// Declared flat and in vtable order, including the twenty methods we never
/// call. A COM interface is an array of function pointers: leaving one out
/// does not remove it, it shifts every method after it onto the wrong slot.
/// </summary>
[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
  [PreserveSig] int Show(IntPtr parent);
  [PreserveSig] int SetFileTypes(uint count, IntPtr types);
  [PreserveSig] int SetFileTypeIndex(uint index);
  [PreserveSig] int GetFileTypeIndex(out uint index);
  [PreserveSig] int Advise(IntPtr events, out uint cookie);
  [PreserveSig] int Unadvise(uint cookie);
  [PreserveSig] int SetOptions(uint options);
  [PreserveSig] int GetOptions(out uint options);
  [PreserveSig] int SetDefaultFolder(IShellItem psi);
  [PreserveSig] int SetFolder(IShellItem psi);
  [PreserveSig] int GetFolder(out IShellItem ppsi);
  [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
  [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  [PreserveSig] int GetResult(out IShellItem ppsi);
  [PreserveSig] int AddPlace(IShellItem psi, int place);
  [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
  [PreserveSig] int Close(int hr);
  [PreserveSig] int SetClientGuid(ref Guid guid);
  [PreserveSig] int ClearClientData();
  [PreserveSig] int SetFilter(IntPtr filter);
  [PreserveSig] int GetResults(out IntPtr enumerator);
  [PreserveSig] int GetSelectedItems(out IntPtr items);
}

public static class Folders {
  static readonly Guid CLSID_FileOpenDialog =
    new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");

  const uint FOS_PICKFOLDERS     = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint FOS_PATHMUSTEXIST   = 0x00000800;
  const uint SIGDN_FILESYSPATH   = 0x80058000;

  /// <summary>
  /// True when the shell dialog could not even be created, as opposed to the
  /// user having pressed Cancel. The caller falls back only on the first.
  /// </summary>
  public static bool Unavailable;

  /// <summary>The chosen directory, or null if the user chose nothing.</summary>
  public static string Pick(IntPtr owner, string title) {
    Unavailable = false;
    object com = null;
    try {
      Type t = Type.GetTypeFromCLSID(CLSID_FileOpenDialog);
      com = t == null ? null : Activator.CreateInstance(t);
      IFileOpenDialog dlg = com as IFileOpenDialog;
      if (dlg == null) { Unavailable = true; return null; }

      uint options;
      dlg.GetOptions(out options);
      // A folder; a real one on disk; one that exists. Without
      // FORCEFILESYSTEM the shell will happily return a library or a cloud
      // location, and neither is a directory a scan can visit.
      dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);

      // Owned by the note, so the dialog sits above a window that is itself
      // always-on-top instead of behind it.
      if (dlg.Show(owner) != 0) return null;   // cancel is 0x800704C7

      IShellItem item;
      if (dlg.GetResult(out item) != 0 || item == null) return null;
      try {
        IntPtr buf;
        if (item.GetDisplayName(SIGDN_FILESYSPATH, out buf) != 0) return null;
        try { return Marshal.PtrToStringUni(buf); }
        finally { Marshal.FreeCoTaskMem(buf); }
      } finally {
        Marshal.ReleaseComObject(item);
      }
    } catch {
      Unavailable = true;
      return null;
    } finally {
      if (com != null && Marshal.IsComObject(com)) Marshal.ReleaseComObject(com);
    }
  }
}

public class Note : Form {
  // -- palette ----------------------------------------------------------
  // Dark, flat, phosphor accents: a readout rather than a document. The
  // greens and ambers are the ones a CRT actually produced, which is what
  // makes the look read as an instrument instead of a themed web page.
  //
  // Four colours carry meaning and nothing else may borrow them: amber is
  // waiting, red is waiting at a permission gate, green is working, cyan is
  // progress. Progress is deliberately *not* green even though the mockup is
  // prettier that way -- a green bar beside a green count puts two different
  // claims in one colour, and the whole value of the row is that it is read
  // without stopping.
  static readonly Color Ink      = Color.FromArgb(0xE6, 0xF2, 0xEC);
  static readonly Color Base     = Color.FromArgb(0x07, 0x0A, 0x0F);
  static readonly Color Panel    = Color.FromArgb(0x0D, 0x12, 0x1A);
  static readonly Color Edge     = Color.FromArgb(0x1D, 0x26, 0x33);
  static readonly Color Bevel    = Color.FromArgb(0x2A, 0x36, 0x46);
  static readonly Color Dim      = Color.FromArgb(0x6B, 0x7A, 0x8C);
  static readonly Color Phosphor = Color.FromArgb(0x3F, 0xE8, 0x9C);
  static readonly Color Amber    = Color.FromArgb(0xFF, 0xB2, 0x4A);
  static readonly Color Alarm    = Color.FromArgb(0xFF, 0x5C, 0x4A);
  static readonly Color Cyan     = Color.FromArgb(0x4A, 0xE8, 0xD0);
  static readonly Color Trough   = Color.FromArgb(0x16, 0x1E, 0x29);

  static readonly int RowH   = 34;
  static readonly int SubH   = 18;  // the detail line under an opened row
  static readonly int BarH   = 26;  // title strip, inside the window
  static readonly int LoadH  = 22;  // the fleet-load strip under it
  static readonly int PadX   = 10;
  static readonly int GapX   = 10;  // between columns
  static readonly int MeterW = 78;  // 10 segments of 6 with 2 between
  static readonly int SparkW = 48;
  static readonly int MinW   = 320;
  static readonly int MaxH   = 460;

  /// <summary>Room for the running pip and the air after it.</summary>
  static readonly int PipLead = 12;

  /// <summary>Display strings, supplied by the caller. No text is coined here.</summary>
  public Dictionary<string, string> L = new Dictionary<string, string>();
  string T(string key, string fallback) {
    string v;
    return L.TryGetValue(key, out v) && v.Length > 0 ? v : fallback;
  }

  public List<Row> Rows = new List<Row>();
  /// <summary>
  /// The chooser's contents, filled by the caller from the daemon.
  ///
  /// Every project ever seen, not only the ones running now: the project you
  /// want to add is usually the one you just closed, and a chooser that offers
  /// only live projects cannot be used to add it.
  /// </summary>
  public List<Pick> Picks = new List<Pick>();
  /// <summary>
  /// Why the chooser is empty, when it is empty for a reason.
  ///
  /// An empty list and a list that could not be fetched look identical and mean
  /// opposite things, and for a while this window told the user the first when
  /// it meant the second: the daemon restarts on its own, the token it was
  /// launched with stopped being accepted, and the chooser -- whose fetch
  /// swallowed every error -- reported "no projects found". That is an
  /// assertion about the user's disk, made at the one moment we knew nothing
  /// about it. Empty stays empty; a failure says so.
  /// </summary>
  public string PickError = "";
  public bool Picking = false;
  public int NeedsYou = 0;
  public bool Connected = false;
  /// <summary>
  /// Fleet load: sessions alive right now, and how many of them are engaged.
  ///
  /// Not an average of the progress bars. Averaging completion across projects
  /// is the most misleading number a tracker can print -- a plan that grows
  /// makes it fall while work is being done -- so the strip along the top
  /// answers something that has an answer instead.
  /// </summary>
  public int LoadLive, LoadWaiting, LoadRunning;
  public double LoadPercent = -1;
  public Shape Form_ = Shape.Full;
  /// <summary>Which project's detail line is open, by name. Empty for none.</summary>
  public string Opened = "";
  /// <summary>A short-lived line in the title strip: what just happened.</summary>
  public string Notice = "";
  /// <summary>Whether transitions into waiting are announced out loud.</summary>
  public bool Speaking = false;
  /// <summary>
  /// The width the list and the strip use.
  ///
  /// Held apart from ClientSize because the badge is 84 pixels wide: without
  /// this, one trip through the badge silently reset a window the user had
  /// widened, and there was no way to get the size back except by resizing
  /// again.
  /// </summary>
  public int WideW = 400;

  Font fName, fMono, fSmall, fLcd;
  Rectangle rShade, rBadge, rClose, rFull, rPick, rSpeak, rAdd;
  /// <summary>
  /// Which title-bar button the pointer is over, by label key. Empty for none.
  ///
  /// The buttons are fourteen pixels square with a mark in them, and until now
  /// they gave no sign of being buttons at all: no lift under the pointer and
  /// no name anywhere. Both are answered by this one field -- the mark
  /// brightens, and the strip says the word.
  /// </summary>
  string hover = "";
  int scroll = 0;
  bool sizing;
  Point sizeFrom;
  int sizeW;
  // The badge is dragged by hand rather than by handing the press to
  // DefWindowProc: its modal drag loop eats the release, and the release is
  // what tells a click apart from a move.
  bool badgeDrag, badgeMoved;
  Point badgeFrom, badgeDown;
  static readonly int Grip = 12;

  // -- the beat ---------------------------------------------------------
  // One phase angle, advanced on a timer, from which every animated thing is
  // derived. It runs only while something is actually waiting or working: an
  // idle board repaints never, and a window pinned over your editor that
  // burned a core to look alive would be a worse tool than a still one.
  Timer beat;
  float phase = 0f;
  static readonly float Step = 0.22f;

  public Action<Shape> OnShape;
  public Action OnOpenFull;
  /// <summary>Asked to fetch the candidate list before the chooser opens.</summary>
  public Action OnPickOpen;
  /// <summary>
  /// A row was toggled. `ToggledId` and `ToggledOn` say which and which way.
  ///
  /// One project, not the whole selection. This window lists what the daemon
  /// gave it and nothing else, so sending its visible set as the whole truth
  /// would quietly unfollow every project it did not happen to show.
  /// </summary>
  public Action OnToggle;
  public string ToggledId = "";
  public bool ToggledOn;
  /// <summary>
  /// The user asked to name a directory.
  ///
  /// The chooser can only offer what the agent's transcript directory
  /// remembers, so a repository no agent has ever opened is reachable no other
  /// way. The handler picks the folder and tells the daemon; this window does
  /// not resolve paths, because identity is a git probe and there must not be
  /// a second implementation of it.
  /// </summary>
  public Action OnAddPath;
  /// <summary>Speaking was switched on or off and should be remembered.</summary>
  public Action OnSpeakToggle;

  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, int wp, int lp);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after,
    int x, int y, int cx, int cy, uint flags);

  /// <summary>
  /// Put this window back on top of everything, whatever WinForms believes.
  ///
  /// `TopMost = true` in the constructor is not enough, and the way it fails is
  /// worse than not setting it at all. Assigning `Location` before the handle
  /// exists -- which is what restoring a remembered position does -- loses
  /// `WS_EX_TOPMOST`, so the window comes up looking exactly right and simply
  /// does not stay on top. Measured by A/B: the same script with a remembered
  /// position gives `ex=0x00050000`, with a fresh one `ex=0x00050008`.
  ///
  /// Which means the defect only appears **after you have moved the note
  /// once**, on every launch from then on, silently. The one thing this window
  /// exists to do is sit above the editor, so it is asserted here rather than
  /// inferred from a property, and asserted again on every shape change,
  /// because a resize is the other moment WinForms rebuilds bounds.
  /// </summary>
  public void PinTop() {
    if (!IsHandleCreated) return;
    // Both halves, and both are needed. The property is what WinForms consults
    // whenever it rebuilds bounds, so leaving its belief at false means the
    // next resize quietly puts the window back down; the explicit call is what
    // actually moves it now. Assigning false first is not redundant -- the
    // setter is a no-op when the value already matches, and after the
    // handle-creation quirk the stored value is already `true` while the
    // window's style says otherwise.
    TopMost = false;
    TopMost = true;
    // NOMOVE | NOSIZE | NOACTIVATE: position, size and focus are all somebody
    // else's business; this call is only about the z-order band.
    SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
  }

  public Note() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = true;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    BackColor = Base;
    DoubleBuffered = true;
    // Without this the form repaints only the rectangle it already had, so
    // growing the window -- which happens every time the chooser opens or a
    // project appears -- left the new strip painted black.
    SetStyle(ControlStyles.ResizeRedraw, true);
    Text = "VibeTracker";
    KeyPreview = true;

    fName  = new Font("Segoe UI", 9.5f, FontStyle.Bold);
    fMono  = new Font("Consolas", 9f);
    fSmall = new Font("Segoe UI", 7.5f);
    fLcd   = new Font("Consolas", 20f, FontStyle.Bold);

    beat = new Timer();
    beat.Interval = 90;
    beat.Tick += OnBeat;
    beat.Start();

    MouseDown += OnMouseDownH;
    // A borderless window has no edge to grab, so the corner is drawn and
    // handled by hand. Width only: height follows the number of projects, and
    // letting it be dragged would just reintroduce empty space below the last
    // row.
    MouseMove += (s, e) => {
      if (sizing) {
        WideW = Math.Max(MinW, Math.Min(1000, sizeW + (e.X - sizeFrom.X)));
        ClientSize = new Size(WideW, ClientSize.Height);
        Invalidate();
        return;
      }
      if (badgeDrag) {
        Point p = PointToScreen(e.Location);
        Location = new Point(p.X - badgeFrom.X, p.Y - badgeFrom.Y);
        if (Math.Abs(p.X - badgeDown.X) + Math.Abs(p.Y - badgeDown.Y) > 4) badgeMoved = true;
        return;
      }
      Cursor = InGrip(e.Location) ? Cursors.SizeWE : Cursors.Default;
      string was = hover;
      hover = ButtonAt(e.Location);
      if (hover != was) Invalidate();
    };
    // Leaving by the edge never produces a move inside, so without this the
    // last button stays lit and the strip keeps naming it after the pointer
    // has gone somewhere else entirely.
    MouseLeave += (s, e) => { if (hover.Length > 0) { hover = ""; Invalidate(); } };
    MouseUp += (s, e) => {
      if (sizing) { sizing = false; if (OnShape != null) OnShape(Form_); return; }
      if (badgeDrag) {
        badgeDrag = false;
        // A press that did not move the window was a click, and a click on
        // the badge means "give me the list back". Dragging still works
        // because the badge is also the only thing there is to grab.
        if (!badgeMoved) Apply(Shape.Full); else if (OnShape != null) OnShape(Form_);
      }
    };
    MouseWheel += (s, e) => { scroll -= Math.Sign(e.Delta) * RowH; Clamp(); Invalidate(); };
    KeyDown += (s, e) => {
      if (e.KeyCode == Keys.Escape) Close();
      if (e.KeyCode == Keys.Space) Cycle();
    };
  }

  /// <summary>
  /// Is anything on screen worth animating?
  ///
  /// The glow means "this is live". On a board where nothing waits and nothing
  /// runs it would mean nothing, so it stops -- and that is the whole of the
  /// animation's cost control. There is no frame budget here, only the
  /// question of whether there is something to say.
  /// </summary>
  bool Alive() {
    if (Form_ == Shape.Badge) return NeedsYou > 0;
    if (Picking) return false;
    foreach (Row r in Rows) if (r.Kind == "waiting" || r.Kind == "running") return true;
    return false;
  }

  void OnBeat(object sender, EventArgs e) {
    if (!Alive()) return;
    phase += Step;
    if (phase > 6.2831853f) phase -= 6.2831853f;
    Invalidate();
  }

  /// <summary>Breathing between `lo` and 1, offset so rows do not blink in lockstep.</summary>
  float Breath(float lo, float offset) {
    float v = (float)((Math.Sin(phase + offset) + 1.0) / 2.0);
    return lo + (1f - lo) * v;
  }

  int RowHeight(Row r) { return r.Name == Opened && r.Lead.Length > 0 ? RowH + SubH : RowH; }

  int ListTop() { return BarH + LoadH; }

  int ContentHeight() {
    if (Picking) return Picks.Count * RowH;
    int h = 0;
    foreach (Row r in Rows) h += RowHeight(r);
    return h;
  }

  void Clamp() {
    int visible = ClientSize.Height - ListTop();
    int max = Math.Max(0, ContentHeight() - visible);
    if (scroll > max) scroll = max;
    if (scroll < 0) scroll = 0;
  }

  void Cycle() {
    Shape next = Form_ == Shape.Full ? Shape.Shade : Form_ == Shape.Shade ? Shape.Badge : Shape.Full;
    Apply(next);
  }

  /// <summary>
  /// Open or close the chooser.
  ///
  /// Choosing is a list-sized job, so it forces the full shape: picking
  /// projects through a one-line strip or an 84-pixel badge is not a smaller
  /// version of the task, it is an impossible one.
  /// </summary>
  public void TogglePicking() {
    Picking = !Picking;
    scroll = 0;
    if (Picking && OnPickOpen != null) OnPickOpen();
    Apply(Shape.Full);
  }

  /// <summary>Rows changed: in Full mode the window follows them.</summary>
  public void Fit() {
    if (Form_ == Shape.Full) Apply(Shape.Full);
    else Invalidate();
  }

  public void Apply(Shape shape) {
    Form_ = shape;
    // The window resizes rather than scaling: a badge is not a small copy of
    // the list, it is a different amount of information.
    // Full mode is as tall as it needs to be, up to a ceiling: a note with
    // empty space below the last project is a note claiming there is more.
    if (shape == Shape.Full) {
      int want = ListTop() + Math.Max(RowH, ContentHeight()) + 2;
      ClientSize = new Size(WideW, Math.Min(MaxH, want));
    }
    if (shape == Shape.Shade) ClientSize = new Size(WideW, ListTop() + RowH);
    if (shape == Shape.Badge) ClientSize = new Size(84, 84);
    scroll = 0;
    PinTop();
    if (OnShape != null) OnShape(shape);
    Invalidate();
  }

  bool InGrip(Point p) {
    if (Form_ == Shape.Badge) return false;
    return p.X >= ClientSize.Width - Grip && p.Y >= ClientSize.Height - Grip;
  }

  /// <summary>Which button is under this point, by label key. Empty for none.</summary>
  string ButtonAt(Point p) {
    if (Form_ == Shape.Badge) return "";
    if (rClose.Contains(p)) return "btnClose";
    if (rBadge.Contains(p)) return "btnBadge";
    if (rShade.Contains(p)) return "btnShade";
    if (rFull.Contains(p))  return "btnFull";
    if (rSpeak.Contains(p)) return "btnSpeak";
    if (rPick.Contains(p))  return "btnPick";
    return "";
  }

  void OnMouseDownH(object sender, MouseEventArgs e) {
    if (e.Button == MouseButtons.Right) { Cycle(); return; }
    if (e.Button != MouseButtons.Left) return;
    if (InGrip(e.Location)) { sizing = true; sizeFrom = e.Location; sizeW = ClientSize.Width; return; }
    if (Form_ == Shape.Badge) {
      badgeDrag = true;
      badgeMoved = false;
      badgeFrom = e.Location;
      badgeDown = PointToScreen(e.Location);
      return;
    }
    if (rClose.Contains(e.Location)) { Close(); return; }
    if (rPick.Contains(e.Location)) { TogglePicking(); return; }
    if (rSpeak.Contains(e.Location)) {
      Speaking = !Speaking;
      if (OnSpeakToggle != null) OnSpeakToggle();
      Invalidate();
      return;
    }
    if (Picking) {
      // The strip that would carry fleet load holds the one action the chooser
      // needs and its list cannot provide.
      if (rAdd.Contains(e.Location)) { if (OnAddPath != null) OnAddPath(); return; }
      if (e.Y >= ListTop()) {
        int i = (e.Y - ListTop() + scroll) / RowH;
        if (i >= 0 && i < Picks.Count) {
          // Saved on the click rather than on a separate "apply". The note has
          // no room for a dialog and no business holding unsaved state: you
          // clicked it, it is followed.
          Picks[i].On = !Picks[i].On;
          ToggledId = Picks[i].Id;
          ToggledOn = Picks[i].On;
          if (OnToggle != null) OnToggle();
          Invalidate();
        }
        return;
      }
    }
    if (rShade.Contains(e.Location)) { Apply(Form_ == Shape.Shade ? Shape.Full : Shape.Shade); return; }
    if (rBadge.Contains(e.Location)) { Apply(Form_ == Shape.Badge ? Shape.Full : Shape.Badge); return; }
    if (rFull.Contains(e.Location) && OnOpenFull != null) { OnOpenFull(); return; }
    // The left third of a row opens it. What the agent is actually doing is
    // the one thing the row has no width for, and it is also the thing you
    // want the moment a project turns amber.
    if (!Picking && Form_ == Shape.Full && e.Y >= ListTop() && e.X < ClientSize.Width / 3) {
      Row hit = RowAt(e.Y);
      if (hit != null && hit.Lead.Length > 0) {
        Opened = Opened == hit.Name ? "" : hit.Name;
        Apply(Shape.Full);
        return;
      }
    }
    // Winamp let you drag the whole skin, and so does this: on a window with
    // no title bar, any other rule means hunting for the one place that works.
    ReleaseCapture();
    SendMessage(Handle, 0xA1, 2, 0); // WM_NCLBUTTONDOWN, HTCAPTION
  }

  Row RowAt(int y) {
    int top = ListTop() - scroll;
    foreach (Row r in Rows) {
      int h = RowHeight(r);
      if (y >= top && y < top + h) return r;
      top += h;
    }
    return null;
  }

  Color KindColor(Row r) {
    if (r.Kind == "waiting") return r.Urgency >= 3 ? Alarm : Amber;
    if (r.Kind == "running") return Phosphor;
    return Dim;
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.None;
    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    g.Clear(Base);

    if (Form_ == Shape.Badge) { PaintBadge(g); Scanlines(g); PaintEdge(g); return; }
    PaintBar(g);
    if (Picking) { PaintAddRow(g); PaintPicks(g); } else { PaintLoad(g); PaintRows(g); }
    Scanlines(g);
    PaintGrip(g);
    PaintEdge(g);
  }

  /// <summary>
  /// Colour bleeding outwards from a shape.
  ///
  /// Three one-pixel outlines at falling alpha rather than a real blur: a blur
  /// would mean an off-screen bitmap per meter per frame, and at this size
  /// nobody can tell the difference. `k` is the beat, so the same call gives a
  /// steady glow or a breathing one depending on what it is drawn around.
  /// </summary>
  void Glow(Graphics g, Rectangle r, Color c, float k) {
    SmoothingMode was = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    for (int i = 1; i <= 3; i++) {
      int a = (int)(70f * k / (i * i));
      if (a <= 2) continue;
      using (Pen p = new Pen(Color.FromArgb(Math.Min(a, 255), c.R, c.G, c.B)))
        g.DrawRectangle(p, r.X - i, r.Y - i, r.Width + i * 2 - 1, r.Height + i * 2 - 1);
    }
    g.SmoothingMode = was;
  }

  /// <summary>Three hatch marks: the only hint that the corner does anything.</summary>
  void PaintGrip(Graphics g) {
    using (Pen p = new Pen(Bevel))
      for (int i = 1; i <= 3; i++)
        g.DrawLine(p, ClientSize.Width - 2 - i * 3, ClientSize.Height - 3,
                      ClientSize.Width - 3, ClientSize.Height - 2 - i * 3);
  }

  /// <summary>
  /// Faint horizontal lines over everything.
  ///
  /// Two alpha steps out of 255: enough that the surface reads as a readout
  /// rather than a small web page, far too little to interfere with text.
  /// Anything heavier would be costume, and this window has to be legible at
  /// a glance or it has no reason to be on top of your work.
  /// </summary>
  void Scanlines(Graphics g) {
    using (Pen p = new Pen(Color.FromArgb(14, 255, 255, 255)))
      for (int y = 0; y < ClientSize.Height; y += 3) g.DrawLine(p, 0, y, ClientSize.Width, y);
  }

  void PaintEdge(Graphics g) {
    using (Pen p = new Pen(Edge))
      g.DrawRectangle(p, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
  }

  /// <summary>The badge: the one number that justifies being on top.</summary>
  void PaintBadge(Graphics g) {
    Color c = NeedsYou > 0 ? Alarm : Phosphor;
    string n = NeedsYou.ToString();
    SizeF sz = g.MeasureString(n, fLcd);
    // The digit brightens and dims rather than being drawn inside a halo.
    // `Glow` outlines a rectangle, which around a 20-point numeral reads as a
    // stray box -- a frame nobody asked for, not a glow.
    float k = NeedsYou > 0 ? Breath(0.55f, 0f) : 1f;
    using (Brush b = new SolidBrush(Color.FromArgb((int)(255 * k), c.R, c.G, c.B)))
      g.DrawString(n, fLcd, b,
        (ClientSize.Width - sz.Width) / 2f, (ClientSize.Height - sz.Height) / 2f - 6);
    string label = NeedsYou > 0 ? T("waiting", "bekliyor") : T("clear", "temiz");
    SizeF ls = g.MeasureString(label, fSmall);
    g.DrawString(label, fSmall, new SolidBrush(Dim),
      (ClientSize.Width - ls.Width) / 2f, ClientSize.Height - ls.Height - 8);
    // A hairline that reads as a signal meter rather than decoration. It
    // breathes with the digit, so the badge is legible as "something wants
    // you" from the corner of an eye that is not reading the number.
    using (Pen p = new Pen(Color.FromArgb((int)(140 * k), c.R, c.G, c.B)))
      g.DrawLine(p, 10, 8, ClientSize.Width - 10, 8);
    // Corner brackets: the badge's only claim that it is a folded window
    // rather than a picture. Without something here, "click me to come back"
    // is knowledge the user has to already have.
    using (Pen p = new Pen(Bevel)) {
      int w = ClientSize.Width, h = ClientSize.Height, kk = 6;
      g.DrawLine(p, 4, h - 4 - kk, 4, h - 4); g.DrawLine(p, 4, h - 4, 4 + kk, h - 4);
      g.DrawLine(p, w - 5, h - 4 - kk, w - 5, h - 4);
      g.DrawLine(p, w - 5 - kk, h - 4, w - 5, h - 4);
    }
  }

  /// <summary>Draw a string one glyph at a time, with air between them.</summary>
  void Spaced(Graphics g, string s, Font f, Color c, float x, float y, float extra) {
    using (Brush b = new SolidBrush(c))
      foreach (char ch in s) {
        string one = ch.ToString();
        g.DrawString(one, f, b, x, y);
        x += g.MeasureString(one, f, 1000, StringFormat.GenericTypographic).Width + extra;
      }
  }

  /// <summary>
  /// The strip, drawn inside the window rather than above it: the whole point
  /// of owning the window is that there is no bar outside our control.
  /// </summary>
  void PaintBar(Graphics g) {
    using (Brush b = new SolidBrush(Panel)) g.FillRectangle(b, 0, 0, ClientSize.Width, BarH);
    Color rule = NeedsYou > 0 ? (Rows.Count > 0 && Rows[0].Urgency >= 3 ? Alarm : Amber) : Bevel;
    using (Pen p = new Pen(rule)) g.DrawLine(p, 0, BarH - 1, ClientSize.Width, BarH - 1);

    Color dot = Connected ? (NeedsYou > 0 ? Alarm : Phosphor) : Dim;
    Rectangle led = new Rectangle(PadX, BarH / 2 - 3, 6, 6);
    if (Connected && NeedsYou > 0) Glow(g, led, dot, Breath(0.25f, 0f));
    using (Brush b = new SolidBrush(dot)) g.FillRectangle(b, led);

    // Deliberately not uppercased. Invariant casing turns Turkish "bekliyor"
    // into "BEKLIYOR" with a dotless I, which is a different letter and reads
    // as a typo to anyone who speaks the language. The catalog text is what
    // gets drawn, exactly as written -- only spaced out, which turns no letter
    // into another one.
    string title = Picking ? T("choose", "izlenecekleri sec") : T("product", "VibeTracker");
    Spaced(g, title, fSmall, Picking ? Phosphor : Dim, PadX + 14, 6f, 1.6f);

    // Buttons: small, square, clustered right -- Winamp's grammar, and it
    // survives because at this size anything else is unhittable.
    int bw = 14, by = 5, x = ClientSize.Width - PadX - bw;
    rClose = new Rectangle(x, by, bw, bw); x -= bw + 4;
    rBadge = new Rectangle(x, by, bw, bw); x -= bw + 4;
    rShade = new Rectangle(x, by, bw, bw); x -= bw + 4;
    rFull  = new Rectangle(x, by, bw, bw); x -= bw + 4;
    rSpeak = new Rectangle(x, by, bw, bw); x -= bw + 4;
    rPick  = new Rectangle(x, by, bw, bw);

    // Glyphs as escapes, never as literal bytes: this file has to stay pure
    // ASCII on disk, because PowerShell 5.1 reads a BOM-less script as the
    // system codepage and would mangle anything else.
    Btn(g, rPick,  Picking ? "\u2713" : "+", Picking ? Phosphor : Dim, "btnPick");
    Btn(g, rSpeak, Speaking ? "\u266a" : "\u00b7", Speaking ? Cyan : Dim, "btnSpeak");
    Btn(g, rFull,  "\u2197", Dim, "btnFull");                                   // the full dashboard
    Btn(g, rShade, Form_ == Shape.Shade ? "\u25a1" : "\u2500", Dim, "btnShade"); // windowshade
    Btn(g, rBadge, "\u25aa", Dim, "btnBadge");
    Btn(g, rClose, "\u00d7", Dim, "btnClose");

    // Between the title and the buttons: whatever just happened, or how many
    // agents are waiting. The notice wins while it lasts, because it answers
    // something the user did a second ago.
    // What the strip says, in falling order of how recently it became true:
    // something that just happened, then what the pointer is resting on, then
    // the standing count. A notice wins because the user caused it a second
    // ago; hovering wins over the count because it is a question being asked
    // right now.
    string right = Notice.Length > 0
      ? Notice
      : hover.Length > 0 ? T(hover, "")
      : NeedsYou > 0 ? NeedsYou + " " + T("waiting", "bekliyor") : "";
    if (right.Length > 0) {
      SizeF sz = g.MeasureString(right, fSmall);
      float rx = rPick.X - GapX - sz.Width;
      if (rx > PadX + 60) {
        Color rc = Notice.Length > 0 ? Cyan : hover.Length > 0 ? Ink : Amber;
        using (Brush rb = new SolidBrush(rc)) g.DrawString(right, fSmall, rb, rx, 6f);
      }
    }
  }

  /// <summary>
  /// One title-bar button.
  ///
  /// `key` is its label key, and a button whose key matches the pointer is
  /// drawn lit: the well fills with the trough colour, the frame takes the
  /// button's own colour instead of the bevel, and the mark goes to full ink.
  /// Fourteen pixels is too small to grow on hover without the whole row
  /// shifting, so the feedback is entirely in brightness.
  /// </summary>
  void Btn(Graphics g, Rectangle r, string glyph, Color c, string key) {
    bool lit = key.Length > 0 && hover == key;
    using (Brush b = new SolidBrush(lit ? Trough : Base)) g.FillRectangle(b, r);
    using (Pen p = new Pen(lit ? (c == Dim ? Ink : c) : (c == Dim ? Bevel : c)))
      g.DrawRectangle(p, r);
    SizeF sz = g.MeasureString(glyph, fSmall);
    using (Brush b = new SolidBrush(lit && c == Dim ? Ink : c))
      g.DrawString(glyph, fSmall, b,
        r.X + (r.Width - sz.Width) / 2f, r.Y + (r.Height - sz.Height) / 2f);
  }

  /// <summary>
  /// Fleet load: of the sessions alive right now, what share is engaged.
  ///
  /// Two colours in one bar, because "everything is running" and "everything
  /// is blocked" are the same load and opposite situations. When nothing is
  /// alive the channel is drawn empty and dashed and the number is a dash --
  /// the same grammar the progress meters use for "nobody measured this", for
  /// the same reason.
  /// </summary>
  void PaintLoad(Graphics g) {
    int y = BarH, h = LoadH;
    using (Brush b = new SolidBrush(Panel)) g.FillRectangle(b, 0, y, ClientSize.Width, h);

    string label = T("load", "sistem yuku");
    SizeF ls = g.MeasureString(label, fSmall);
    g.DrawString(label, fSmall, new SolidBrush(Dim), PadX, y + (h - ls.Height) / 2f);

    string pct = LoadPercent < 0 ? "\u2014" : "%" + (int)Math.Round(LoadPercent);
    SizeF ps = g.MeasureString(pct, fMono);
    float px = ClientSize.Width - PadX - ps.Width;
    g.DrawString(pct, fMono, new SolidBrush(LoadPercent < 0 ? Dim : Ink), px, y + (h - ps.Height) / 2f);

    int x0 = PadX + (int)ls.Width + GapX;
    int x1 = (int)px - GapX;
    int w = x1 - x0;
    if (w < 24) return;
    Rectangle track = new Rectangle(x0, y + h / 2 - 3, w, 6);

    if (LoadPercent < 0 || LoadLive == 0) {
      using (Pen p = new Pen(Bevel)) {
        p.DashStyle = DashStyle.Dot;
        g.DrawRectangle(p, track);
      }
      return;
    }
    using (Brush b = new SolidBrush(Trough)) g.FillRectangle(b, track);
    int runW = (int)Math.Round(w * (double)Math.Min(LoadRunning, LoadLive) / LoadLive);
    int waitW = (int)Math.Round(w * (double)Math.Min(LoadWaiting, LoadLive) / LoadLive);
    if (runW + waitW > w) waitW = Math.Max(0, w - runW);
    if (runW > 0) {
      Rectangle r = new Rectangle(x0, track.Y, runW, track.Height);
      using (Brush b = new SolidBrush(Phosphor)) g.FillRectangle(b, r);
      Glow(g, r, Phosphor, 0.7f);
    }
    if (waitW > 0) {
      Rectangle r = new Rectangle(x0 + runW, track.Y, waitW, track.Height);
      Color c = Rows.Count > 0 && Rows[0].Urgency >= 3 ? Alarm : Amber;
      using (Brush b = new SolidBrush(c)) g.FillRectangle(b, r);
      Glow(g, r, c, Breath(0.3f, 0f));
    }
  }

  /// <summary>
  /// The chooser's one action: name a directory.
  ///
  /// It sits where the load strip goes, fixed rather than scrolled, because it
  /// is not one of the candidates -- it is the answer for when none of them is
  /// the project you meant.
  /// </summary>
  void PaintAddRow(Graphics g) {
    rAdd = new Rectangle(0, BarH, ClientSize.Width, LoadH);
    using (Brush b = new SolidBrush(Panel)) g.FillRectangle(b, rAdd);
    using (Pen p = new Pen(Edge))
      g.DrawLine(p, PadX, BarH + LoadH - 1, ClientSize.Width - PadX, BarH + LoadH - 1);
    string s = "+  " + T("addPath", "klasor sec");
    SizeF sz = g.MeasureString(s, fSmall);
    g.DrawString(s, fSmall, new SolidBrush(Cyan), PadX, BarH + (LoadH - sz.Height) / 2f);
  }

  /// <summary>
  /// The chooser: one line per project, ticked when followed.
  ///
  /// Drawn in the window rather than in a menu because a stock context menu
  /// arrives in the system's light grey with the system's fonts, and half the
  /// reason this window exists is that it does not look like a dialog.
  /// </summary>
  void PaintPicks(Graphics g) {
    int top = ListTop();
    if (Picks.Count == 0) {
      bool failed = PickError.Length > 0;
      Cell(g, failed ? PickError : T("nopick", "proje bulunamadi"),
        fSmall, failed ? Alarm : Dim, PadX, top,
        ClientSize.Width - PadX * 2, false);
      return;
    }
    int y = top - scroll;
    foreach (Pick pk in Picks) {
      if (y + RowH > top && y < ClientSize.Height) {
        Rectangle box = new Rectangle(PadX, y + RowH / 2 - 5, 10, 10);
        using (Pen p = new Pen(pk.On ? Phosphor : Bevel)) g.DrawRectangle(p, box);
        if (pk.On) {
          using (Brush b = new SolidBrush(Phosphor))
            g.FillRectangle(b, box.X + 3, box.Y + 3, 5, 5);
        }
        Cell(g, pk.Name, fName, pk.On ? Ink : Dim, PadX + 18, y,
          ClientSize.Width - PadX * 2 - 18, false);
      }
      y += RowH;
    }
  }

  void PaintRows(Graphics g) {
    List<Row> rows = Rows;
    int top = ListTop();
    if (rows.Count == 0) { Empty(g, top); return; }

    Grid lay = Measure(g, rows);
    if (Form_ == Shape.Shade) {
      // One line: whatever is most urgent. If nothing is, say so rather than
      // showing an arbitrary project.
      PaintRow(g, rows[0], top, lay);
      return;
    }

    int y = top - scroll;
    foreach (Row r in rows) {
      int h = RowHeight(r);
      if (y + h > top && y < ClientSize.Height) PaintRow(g, r, y, lay);
      y += h;
    }
    // Scroll position as a hairline on the right edge, not a scrollbar: a
    // scrollbar at this size costs more pixels than the rows it reveals.
    int need = ContentHeight(), visible = ClientSize.Height - top;
    if (need > visible) {
      float frac = (float)visible / need;
      int hh = Math.Max(12, (int)(visible * frac));
      int ty = top + (int)((visible - hh) * ((float)scroll / Math.Max(1, need - visible)));
      using (Brush b = new SolidBrush(Bevel))
        g.FillRectangle(b, ClientSize.Width - 3, ty, 2, hh);
    }
  }

  void Empty(Graphics g, int y) {
    Cell(g, Connected ? T("empty", "izlenen proje yok") : T("nodaemon", "daemon yok"),
      fSmall, Dim, PadX, y, ClientSize.Width - PadX * 2, false);
  }

  /// <summary>Where each column begins. See <see cref="Measure"/>.</summary>
  class Grid {
    public int NameX, NameW, SparkX, SparkW, WaitX, WaitW, RunX, RunW, MeterX, PctX, PctW;
  }

  /// <summary>
  /// Column positions, measured once across every row about to be drawn.
  ///
  /// Each cell used to be placed relative to the width of the cell to its
  /// right, one row at a time. That is not a grid: "3 bekliyor" and
  /// "calisiyor" are different widths, so every row put its numbers somewhere
  /// slightly different and the eye had to re-find each column on every line.
  /// Measuring the widest cell per column and drawing all rows against the
  /// same coordinates is the whole of the fix -- and it is done per paint
  /// rather than once, because the words change with the counts and with the
  /// language.
  ///
  /// The trace is the first thing to go when the window is narrow. Everything
  /// else on the row is a number somebody needs; the trace is context, and
  /// context is what you drop first.
  /// </summary>
  Grid Measure(Graphics g, List<Row> rows) {
    int w = 0, r2 = 0, pc = 0;
    foreach (Row r in rows) {
      w  = Math.Max(w,  Ceil(g.MeasureString(WaitText(r), fSmall).Width));
      r2 = Math.Max(r2, Ceil(g.MeasureString(RunText(r), fSmall).Width));
      pc = Math.Max(pc, Ceil(g.MeasureString(PctText(r), fMono).Width));
    }
    Grid lay = new Grid();
    lay.WaitW = w;
    lay.RunW = r2 + PipLead;
    lay.PctW = pc;
    lay.PctX = ClientSize.Width - PadX - pc;
    lay.MeterX = lay.PctX - GapX - MeterW;
    lay.RunX = lay.MeterX - GapX - lay.RunW;
    lay.WaitX = lay.RunX - GapX - w;
    lay.NameX = PadX + 16;
    lay.SparkW = SparkW;
    lay.SparkX = lay.WaitX - GapX - lay.SparkW;
    if (lay.SparkX - GapX - lay.NameX < 70) {
      lay.SparkW = 0;
      lay.SparkX = lay.WaitX;
    }
    lay.NameW = Math.Max(24, lay.SparkX - GapX - lay.NameX);
    return lay;
  }

  static int Ceil(float f) { return (int)Math.Ceiling(f); }

  /// <summary>
  /// Waiting and running, always both.
  ///
  /// The row used to name one state and print `live/total` beside it, which
  /// read as "running of total" while meaning "alive of ever seen": a project
  /// with three sessions waiting and one working announced "3 bekliyor  5/5".
  /// Two counts answering two questions is the only compact form that cannot
  /// be misread. Zero is drawn as a dash rather than left blank, because an
  /// empty column and a broken renderer look the same.
  /// </summary>
  string WaitText(Row r) {
    return r.Waiting > 0 ? r.Waiting + " " + T("waiting", "bekliyor") : "\u2014";
  }

  string RunText(Row r) {
    if (r.Running > 0) return r.Running + " " + T("running", "calisiyor");
    // Nothing waiting and nothing running is still two situations: a session
    // with nothing to do, and no session at all.
    if (r.Waiting == 0) return r.Live > 0 ? T("idle", "bosta") : T("off", "kapali");
    return "\u2014";
  }

  string PctText(Row r) {
    if (r.Percent < 0) return "\u2014";
    return (r.Approximate ? "~" : "") + "%" + (int)Math.Round(r.Percent);
  }

  /// <summary>One string, vertically centred in the row band.</summary>
  void Cell(Graphics g, string s, Font f, Color c, int x, int y, int w, bool rightAlign) {
    SizeF sz = g.MeasureString(s, f);
    float tx = rightAlign ? x + w - sz.Width : x;
    using (Brush b = new SolidBrush(c)) g.DrawString(s, f, b, tx, y + (RowH - sz.Height) / 2f);
  }

  /// <summary>
  /// The last half hour, as a line.
  ///
  /// The counts say what is happening now; they cannot say whether a project
  /// has been busy or has been sitting there, and that is most of what you
  /// want to know about the ones that are not currently shouting. Minutes
  /// nobody watched are left blank rather than drawn at zero: a floor the
  /// project never sat on is a lie the eye reads instantly and cannot check.
  /// </summary>
  void PaintSpark(Graphics g, Row r, int x, int y, int w, Color c) {
    if (w <= 0) return;
    int h = 14;
    int top = y + RowH / 2 - h / 2;
    int n = r.Spark.Length;
    if (n < 2) {
      // No history at all -- a one-shot reader, or a project first seen just
      // now. A dotted floor says "nothing recorded", which is true.
      using (Pen p = new Pen(Color.FromArgb(105, Bevel.R, Bevel.G, Bevel.B))) {
        p.DashStyle = DashStyle.Dot;
        g.DrawLine(p, x, top + h - 1, x + w, top + h - 1);
      }
      return;
    }
    int max = 1;
    foreach (int v in r.Spark) if (v > max) max = v;

    SmoothingMode was = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    float step = (float)w / (n - 1);

    // The axis is always the full twenty-four minutes, so that two rows can
    // be compared -- a trace whose time span changed with how much history it
    // happened to have would be unreadable. The minutes before this project
    // was watched get the dotted rule instead, which is the same thing the
    // progress meter draws for "nobody measured this", and for the same
    // reason: a blank stretch and a broken renderer look identical.
    int firstSeen = n;
    for (int i = 0; i < n; i++) if (r.Spark[i] >= 0) { firstSeen = i; break; }
    if (firstSeen > 0) {
      using (Pen p = new Pen(Color.FromArgb(105, Bevel.R, Bevel.G, Bevel.B))) {
        p.DashStyle = DashStyle.Dot;
        g.DrawLine(p, x, top + h - 1, x + Math.Min(firstSeen, n - 1) * step, top + h - 1);
      }
    }
    bool active = r.Kind == "waiting" || r.Kind == "running";
    Color line = active ? c : Dim;
    int alpha = active ? 210 : 110;
    using (Pen p = new Pen(Color.FromArgb(alpha, line.R, line.G, line.B), 1.4f)) {
      float px = 0, py = 0;
      bool have = false;
      int drawn = 0;
      for (int i = 0; i < n; i++) {
        int v = r.Spark[i];
        if (v < 0) { have = false; continue; }  // before anyone was watching
        float cx = x + i * step;
        float cy = top + h - 1 - (h - 2) * ((float)v / max);
        if (have) { g.DrawLine(p, px, py, cx, cy); drawn++; }
        px = cx; py = cy; have = true;
      }
      // One observed minute is a line with no length, and a line with no
      // length draws nothing -- which looked exactly like "no data" for the
      // first minute after every daemon restart. A tick mark says the
      // difference: we have watched this project, once.
      if (drawn == 0 && have) g.DrawLine(p, px - 2, py, px, py);
    }
    g.SmoothingMode = was;
  }

  /// <summary>
  /// The meter, in three distinct pictures.
  ///
  /// Filled blocks are a counted number, hollow blocks an inferred one, and
  /// an empty dashed channel means nobody measured anything -- which is a
  /// different statement from "nothing is done yet". Drawing all three the
  /// same way is how a dashboard ends up lying at a glance while every
  /// individual number on it is true.
  ///
  /// The travelling highlight is the only purely decorative thing in this
  /// window, and it is confined to segments that are already lit: it can make
  /// a bar look alive, it cannot make one look longer.
  /// </summary>
  void PaintMeter(Graphics g, Row r, int x, int y) {
    int segs = 10, segGap = 2, segW = 6;
    int top = y + RowH / 2 - 4;
    if (r.Percent < 0) {
      using (Pen p = new Pen(Bevel)) {
        p.DashStyle = DashStyle.Dot;
        g.DrawRectangle(p, x, top, MeterW - 1, 8);
      }
      return;
    }
    int lit = (int)Math.Round(r.Percent / 100.0 * segs);
    bool active = r.Kind == "waiting" || r.Kind == "running";
    int trav = active ? (int)(phase / 6.2831853f * (segs * 2)) % (segs * 2) : -1;
    for (int i = 0; i < segs; i++) {
      Rectangle seg = new Rectangle(x + i * (segW + segGap), top, segW, 8);
      if (i < lit) {
        if (r.Approximate) {
          using (Pen p = new Pen(Cyan)) g.DrawRectangle(p, seg);
        } else {
          using (Brush b = new SolidBrush(Cyan)) g.FillRectangle(b, seg);
          if (i == trav) Glow(g, seg, Cyan, 1f);
          else if (active) Glow(g, seg, Cyan, 0.25f);
        }
      } else {
        using (Brush b = new SolidBrush(Trough)) g.FillRectangle(b, seg);
      }
    }
  }

  void PaintRow(Graphics g, Row r, int y, Grid lay) {
    Color c = KindColor(r);
    bool open = r.Name == Opened && r.Lead.Length > 0;

    // The accent: a bar down the left edge in the row's own colour. It is the
    // only thing on the row visible from across the desk, which is most of
    // what makes the window worth pinning, and it breathes while something is
    // blocked so that "waiting" is legible without reading a word.
    if (r.Kind != "none") {
      Rectangle accent = new Rectangle(0, y + 3, 3, RowH - 6);
      if (r.Kind == "waiting") {
        float k = Breath(r.Urgency >= 3 ? 0.15f : 0.45f, r.Name.Length * 0.6f);
        Glow(g, accent, c, k);
        using (Brush b = new SolidBrush(Color.FromArgb((int)(160 + 95 * k), c.R, c.G, c.B)))
          g.FillRectangle(b, accent);
      } else {
        using (Brush b = new SolidBrush(c)) g.FillRectangle(b, accent);
        if (r.Kind == "running") Glow(g, accent, c, 0.5f);
      }
    }

    // The chevron. Nearly invisible when there is nothing behind it, so a row
    // that cannot be opened does not invite the click.
    Color chev = r.Lead.Length > 0 ? Dim : Color.FromArgb(0x1E, 0x27, 0x33);
    int cy = y + RowH / 2;
    using (Brush b = new SolidBrush(chev)) {
      Point[] tri = open
        ? new Point[] { new Point(PadX - 1, cy - 2), new Point(PadX + 7, cy - 2), new Point(PadX + 3, cy + 3) }
        : new Point[] { new Point(PadX + 1, cy - 4), new Point(PadX + 6, cy), new Point(PadX + 1, cy + 4) };
      SmoothingMode was = g.SmoothingMode;
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.FillPolygon(b, tri);
      g.SmoothingMode = was;
    }

    // The name gets whatever the columns left, and is clipped rather than
    // allowed to push the numbers around.
    using (StringFormat sf = new StringFormat())
    using (Brush b = new SolidBrush(r.Kind == "none" ? Dim : Ink)) {
      sf.Trimming = StringTrimming.EllipsisCharacter;
      sf.FormatFlags = StringFormatFlags.NoWrap;
      sf.LineAlignment = StringAlignment.Center;
      g.DrawString(r.Name, fName, b, new Rectangle(lay.NameX, y, lay.NameW, RowH), sf);
    }

    PaintSpark(g, r, lay.SparkX, y, lay.SparkW, c);

    // Colour belongs to the cell, not the row: a project both waiting and
    // working should read as doing both.
    // Right-aligned, both of them: the words are the constant part and the
    // counts are one or two digits, so the trailing edge is what the eye can
    // actually use as a column. Left-aligning left a dash stranded at the far
    // side of a column sized for "1 calisiyor", with a hole after it.
    Cell(g, WaitText(r), fSmall, r.Waiting > 0 ? (r.Urgency >= 3 ? Alarm : Amber) : Bevel,
      lay.WaitX, y, lay.WaitW, true);

    string run = RunText(r);
    SizeF rs = g.MeasureString(run, fSmall);
    float runX = lay.RunX + lay.RunW - rs.Width;
    Color runC = r.Running > 0 ? Phosphor : Dim;
    using (Brush b = new SolidBrush(runC))
      g.DrawString(run, fSmall, b, runX, y + (RowH - rs.Height) / 2f);
    // The pip rides with the text rather than sitting at the column start, so
    // the two cannot drift apart as the count changes width.
    Rectangle pip = new Rectangle((int)runX - PipLead + 3, y + RowH / 2 - 3, 6, 6);
    if (r.Running > 0) {
      using (Brush b = new SolidBrush(runC)) g.FillRectangle(b, pip);
      Glow(g, pip, runC, 0.6f);
    } else {
      using (Pen p = new Pen(Bevel)) g.DrawRectangle(p, pip.X, pip.Y, 5, 5);
    }

    PaintMeter(g, r, lay.MeterX, y);

    // A refused number gets the same room and near-enough the same weight as
    // a real one. "We measured nothing here" is an answer; a blank is not --
    // and it is drawn in Dim rather than Bevel, because at Bevel the dash
    // disappeared into the background and the row looked broken.
    Cell(g, PctText(r), fMono, r.Percent < 0 ? Dim : Ink, lay.PctX, y, lay.PctW, true);

    // What the agent is actually doing, once you ask for it. The text is
    // redacted before it ever leaves the engine, which is the only reason a
    // window pinned above everything else is allowed to show a prompt at all.
    if (open) {
      using (StringFormat sf = new StringFormat())
      using (Brush b = new SolidBrush(Dim)) {
        sf.Trimming = StringTrimming.EllipsisCharacter;
        sf.FormatFlags = StringFormatFlags.NoWrap;
        sf.LineAlignment = StringAlignment.Center;
        g.DrawString(r.Lead, fSmall, b,
          new Rectangle(lay.NameX, y + RowH - 2, ClientSize.Width - lay.NameX - PadX, SubH), sf);
      }
    }
  }
}
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing -Language CSharp

# -- state: where the note sits, how big it is, whether it talks -----------
$state = @{ x = -1; y = -1; w = 400; h = 260; mode = 'Full'; speak = $false }
if ($StatePath -and (Test-Path $StatePath)) {
  try {
    $j = Get-Content $StatePath -Raw | ConvertFrom-Json
    foreach ($k in 'x', 'y', 'w', 'h', 'mode', 'speak') { if ($null -ne $j.$k) { $state[$k] = $j.$k } }
  } catch { }
}
if ($Mode) { $state.mode = $Mode }

$note = New-Object VibeTracker.Note
$note.WideW = [Math]::Max(320, [Math]::Min(1000, [int]$state.w))
$note.Speaking = [bool]$state.speak
if ($LabelsPath -and (Test-Path $LabelsPath)) {
  try {
    $lj = Get-Content $LabelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($prop in $lj.PSObject.Properties) { $note.L[$prop.Name] = [string]$prop.Value }
  } catch { }
}
$note.ClientSize = New-Object System.Drawing.Size([int]$state.w, [int]$state.h)
if ([int]$state.x -ge 0) {
  $note.Location = New-Object System.Drawing.Point([int]$state.x, [int]$state.y)
} else {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $note.Location = New-Object System.Drawing.Point(($wa.Right - [int]$state.w - 24), ($wa.Top + 24))
}

$script:savedState = ''

function Save-State {
  if (-not $StatePath) { return }
  try {
    $json = @{ x = $note.Location.X; y = $note.Location.Y
               w = $note.WideW; h = $note.ClientSize.Height
               mode = $note.Form_.ToString(); speak = $note.Speaking } |
      ConvertTo-Json -Compress
    # Only when it actually changed. Every poll calls Fit(), Fit() re-applies
    # the shape so the window can follow the row count, and applying a shape
    # reports it -- so an unguarded save rewrote this file every two seconds
    # for as long as the window was open, which on a laptop is a disk kept
    # awake to record that nothing happened.
    if ($json -eq $script:savedState) { return }
    $script:savedState = $json
    Set-Content -Path $StatePath -Value $json -Encoding utf8
  } catch { }
}

$note.OnShape = [Action[VibeTracker.Shape]] { param($s) Save-State }
$note.OnSpeakToggle = [Action] {
  Save-State
  # Only on the way on. Naming the voice when speech is switched off would be
  # answering a question nobody asked.
  if ($note.Speaking) { Set-Notice (Voice-Notice) }
}
$note.OnOpenFull = [Action] {
  # The full dashboard is the browser's job; the note never grows into it.
  try { Start-Process $Url } catch { }
}
$note.Add_FormClosing({ Save-State })

# -- saying it out loud ---------------------------------------------------
# The window is already the surface you do not have to switch to; speech is
# the same idea for the seconds you are not looking at the screen either.
#
# Three rules keep it from becoming noise. It announces a *transition* into
# waiting, never a state, so a project blocked for an hour stays silent. It
# says nothing on the first poll, because everything is a transition when
# there is nothing to compare against and a restart would otherwise read the
# whole board aloud. And more than two at once collapses into a count --
# nobody needs to hear five project names in a row.
$script:prevWaiting = $null
# What we ended up able to say, and in which language. Null until the first
# attempt; @{ engine = 'none' } once we have tried and failed.
$script:voice = $null

# -- two engines, because they see different voices -----------------------
#
# `System.Speech` (SAPI5) is part of the .NET Framework, so reaching it costs
# no dependency. But it only sees voices registered under
# `Speech\Voices\Tokens`, and the voices Windows installs through
# *Settings -> Time & language -> Speech* are written to
# `Speech_OneCore\Voices\Tokens` instead, which SAPI5 does not read. Measured
# here: SAPI5 sees two voices, WinRT sees three -- the same two plus one.
#
# That gap is the whole reason this is not one engine. The obvious way for a
# user to add Turkish produces a voice the old engine cannot use, so the note
# would keep reading Turkish in an English accent no matter what the user
# installed. WinRT is tried first for exactly that reason, and SAPI5 remains
# the fallback for machines where the WinRT projection is missing and for
# third-party voices that only register the old way.
#
# WinRT is reached through PowerShell's own type projection rather than through
# the C# block: `Add-Type` would have to be handed the Windows metadata to
# compile against, and this needs no compiling.
function Init-Voice {
  if ($null -ne $script:voice) { return }

  $want = if ($Lang) { $Lang } else { '' }
  $alt = if ($LangAlt) { $LangAlt } else { '' }

  # -- WinRT ---------------------------------------------------------------
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    # WinRT returns IAsyncOperation, which PowerShell cannot await. The
    # projection helper is a generic method that has to be found by signature
    # -- there is no non-reflective way to name it.
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
    if ($null -eq $script:asTask) { throw 'no AsTask' }
    $synthType = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
    $script:streamType = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media, ContentType = WindowsRuntime]
    $null = [Windows.Media.Core.MediaSource, Windows.Media, ContentType = WindowsRuntime]
    $null = [Windows.Media.Playback.MediaPlayer, Windows.Media, ContentType = WindowsRuntime]

    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $all = @($synthType::AllVoices)
    $pick = $null
    $useAlt = $false
    # The voice the user chose in Windows wins when it already speaks the
    # right language: someone who set a default had a reason, and there can be
    # several voices per language.
    if ($want -and $synth.Voice -and $synth.Voice.Language.StartsWith($want, 'OrdinalIgnoreCase')) {
      $pick = $synth.Voice
    }
    if (-not $pick -and $want) {
      $pick = $all | Where-Object { $_.Language.StartsWith($want, 'OrdinalIgnoreCase') } | Select-Object -First 1
    }
    # Nothing speaks the interface language. Rather than read Turkish in an
    # English accent, say the English sentence -- which that voice can
    # actually pronounce. The window stays in the interface language; only the
    # spoken line moves, and only because no voice can carry it.
    if (-not $pick -and $alt) {
      $pick = $all | Where-Object { $_.Language.StartsWith($alt, 'OrdinalIgnoreCase') } | Select-Object -First 1
      if ($pick) { $useAlt = $true }
    }
    if ($pick) { $synth.Voice = $pick }
    if ($all.Count -eq 0) { throw 'no voices' }

    $script:voice = @{
      engine  = 'winrt'
      synth   = $synth
      player  = (New-Object Windows.Media.Playback.MediaPlayer)
      name    = $synth.Voice.DisplayName
      lang    = $synth.Voice.Language
      matched = [bool]($want -and $synth.Voice.Language.StartsWith($want, 'OrdinalIgnoreCase'))
      useAlt  = $useAlt
    }
    return
  } catch { }

  # -- SAPI5 ---------------------------------------------------------------
  try {
    Add-Type -AssemblyName System.Speech
    $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $installed = @($sp.GetInstalledVoices() | Where-Object { $_.Enabled })
    if ($installed.Count -eq 0) { throw 'no voices' }
    $useAlt = $false
    $pick = $installed | Where-Object {
      $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $want } | Select-Object -First 1
    if (-not $pick -and $alt) {
      $pick = $installed | Where-Object {
        $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $alt } | Select-Object -First 1
      if ($pick) { $useAlt = $true }
    }
    if ($pick) { $sp.SelectVoice($pick.VoiceInfo.Name) }
    $script:voice = @{
      engine  = 'sapi'
      synth   = $sp
      name    = $sp.Voice.Name
      lang    = $sp.Voice.Culture.Name
      matched = [bool]($want -and $sp.Voice.Culture.TwoLetterISOLanguageName -eq $want)
      useAlt  = $useAlt
    }
    return
  } catch { }

  # No speech engine, no voices, a locked audio device: here they all mean the
  # same thing, which is that the window carries on being a window.
  $script:voice = @{ engine = 'none' }
}

function Speak([string]$text) {
  if (-not $note.Speaking -or -not $text) { return }
  Init-Voice
  try {
    if ($script:voice.engine -eq 'winrt') {
      # Synthesis is waited on rather than continued from: measured at 25 ms
      # for a sentence this length, against 103 ms to start playback, and a
      # scriptblock-as-delegate continuation would run in a runspace of its
      # own for no gain. Playback itself does not block.
      $op = $script:voice.synth.SynthesizeTextToStreamAsync($text)
      $task = $script:asTask.MakeGenericMethod($script:streamType).Invoke($null, @($op))
      if (-not $task.Wait(5000)) { return }
      $stream = $task.Result
      $script:voice.player.Source =
        [Windows.Media.Core.MediaSource]::CreateFromStream($stream, $stream.ContentType)
      $script:voice.player.Play()
    } elseif ($script:voice.engine -eq 'sapi') {
      # Async: speaking blocks for seconds, and this is called from the poll
      # that repaints the window.
      $script:voice.synth.SpeakAsyncCancelAll()
      $script:voice.synth.SpeakAsync($text) | Out-Null
    } else {
      $note.Speaking = $false
    }
  } catch {
    $note.Speaking = $false
  }
}

# What the strip says when speech is switched on. Turning it on and hearing
# nothing -- or hearing the wrong accent -- is the moment the user needs to be
# told which voice answered, and it is the only moment they are asking.
function Voice-Notice {
  Init-Voice
  if ($script:voice.engine -eq 'none') { return [string]$note.L['voiceNone'] }
  if ($script:voice.matched) { return [string]$script:voice.name }
  return ([string]$script:voice.name + ' - ' + [string]$note.L['voiceMismatch'])
}

function Announce($rows) {
  $now = @{}
  foreach ($r in $rows) { $now[$r.Name] = [int]$r.Waiting }
  if ($null -eq $script:prevWaiting) { $script:prevWaiting = $now; return }
  $turned = @()
  foreach ($k in $now.Keys) {
    if ($script:prevWaiting.ContainsKey($k) -and $now[$k] -gt $script:prevWaiting[$k]) {
      $turned += $k
    }
  }
  $script:prevWaiting = $now
  if ($turned.Count -eq 0) { return }
  Init-Voice
  # Which wording the installed voice can actually pronounce. `useAlt` is set
  # only when no voice speaks the interface language at all.
  $one = if ($script:voice.useAlt) { $note.L['speakWaitingAlt'] } else { $note.L['speakWaiting'] }
  $many = if ($script:voice.useAlt) { $note.L['speakManyAlt'] } else { $note.L['speakMany'] }
  if ($turned.Count -le 2) {
    foreach ($k in $turned) { Speak ($k + ' ' + $one) }
  } else {
    Speak ([string]$turned.Count + ' ' + $many)
  }
}

# -- polling --------------------------------------------------------------
# Plain polling, not SSE: this is a readout that redraws twice a second at
# most, and a streaming client here would be more code holding more state for
# no visible difference.
$script:token = $Token
$script:base = ($Url -replace '\?.*$', '').TrimEnd('/')
$script:headers = @{ 'X-VT-Token' = $script:token }
$script:api = $script:base + '/api/v1/overview'
$script:noticeTicks = 0

# Re-read the daemon's published port and token.
#
# Returns true only when something actually changed, so a caller can tell
# "there is a new daemon, try again" from "the daemon is simply down" without
# retrying in a loop.
function Reconnect-Daemon {
  if (-not $RuntimePath) { return $false }
  try {
    $rt = Get-Content -LiteralPath $RuntimePath -Raw -ErrorAction Stop | ConvertFrom-Json
  } catch { return $false }
  if (-not $rt.port -or -not $rt.token) { return $false }
  $newBase = 'http://127.0.0.1:' + [string]$rt.port
  if ($newBase -eq $script:base -and [string]$rt.token -eq $script:token) { return $false }
  $script:base = $newBase
  $script:token = [string]$rt.token
  $script:headers = @{ 'X-VT-Token' = $script:token }
  $script:api = $script:base + '/api/v1/overview'
  return $true
}

# One GET, with a single reconnect-and-retry when it fails.
function Get-Api([string]$path, [int]$timeout = 4) {
  try {
    return Invoke-RestMethod -Uri ($script:base + $path) -Headers $script:headers `
      -TimeoutSec $timeout -ErrorAction Stop
  } catch {
    if (-not (Reconnect-Daemon)) { throw }
    return Invoke-RestMethod -Uri ($script:base + $path) -Headers $script:headers `
      -TimeoutSec $timeout -ErrorAction Stop
  }
}

function Send-Api([string]$path, [string]$body, [int]$timeout = 4) {
  try {
    return Invoke-RestMethod -Uri ($script:base + $path) -Headers $script:headers -Method Post `
      -Body $body -ContentType 'application/json' -TimeoutSec $timeout -ErrorAction Stop
  } catch {
    if (-not (Reconnect-Daemon)) { throw }
    return Invoke-RestMethod -Uri ($script:base + $path) -Headers $script:headers -Method Post `
      -Body $body -ContentType 'application/json' -TimeoutSec $timeout -ErrorAction Stop
  }
}

function Set-Notice([string]$text) {
  $note.Notice = $text
  $script:noticeTicks = 4   # about eight seconds at this poll interval
  $note.Invalidate()
}

function Refresh {
  if ($script:noticeTicks -gt 0) {
    $script:noticeTicks--
    if ($script:noticeTicks -eq 0) { $note.Notice = '' }
  }
  try {
    $r = Get-Api '/api/v1/overview'
    $rows = New-Object 'System.Collections.Generic.List[VibeTracker.Row]'
    foreach ($p in $r.projects) {
      if (-not $p.tracked) { continue }
      $row = New-Object VibeTracker.Row
      $row.Name = [string]$p.displayName
      $s = $p.summary
      if ($s) {
        $row.Kind = [string]$s.kind
        $row.Waiting = [int]$s.waiting; $row.Running = [int]$s.running
        $row.Live = [int]$s.live; $row.Total = [int]$s.total
        $row.Urgency = [int]$s.urgency
        if ($s.leadTitle) { $row.Lead = [string]$s.leadTitle }
      }
      if ($p.progress -and $null -ne $p.progress.percent) {
        $row.Percent = [double]$p.progress.percent
        $row.Approximate = [bool]$p.progress.approximate
      }
      # Absent for a one-shot reader with no past; drawn as a gap, not a floor.
      if ($p.momentum) { $row.Spark = [int[]]$p.momentum }
      $rows.Add($row)
    }
    # Most urgent first, same rule the other two surfaces obey.
    $sorted = $rows | Sort-Object -Property `
      @{ Expression = { if ($_.Kind -eq 'waiting') { 1000 + $_.Urgency * 10 } elseif ($_.Kind -eq 'running') { 500 } elseif ($_.Kind -eq 'idle') { 100 } else { 0 } } ; Descending = $true }, `
      @{ Expression = { $_.Name } }
    $note.Rows = New-Object 'System.Collections.Generic.List[VibeTracker.Row]'
    foreach ($x in $sorted) { $note.Rows.Add($x) }
    $note.NeedsYou = [int]$r.counts.needsYou
    # Fleet load, computed in the engine beside the counts it is made of.
    if ($r.load) {
      $note.LoadLive = [int]$r.load.live
      $note.LoadWaiting = [int]$r.load.waiting
      $note.LoadRunning = [int]$r.load.running
      if ($null -ne $r.load.percent) { $note.LoadPercent = [double]$r.load.percent }
      else { $note.LoadPercent = -1 }
    }
    $note.Connected = $true
    Announce $note.Rows
    if (-not $note.Picking) { $note.Fit() }
  } catch {
    # A daemon that stopped is a state to display, not a crash: the note keeps
    # the last rows and greys its indicator.
    $note.Connected = $false
  }
  $note.Invalidate()
}

# -- the chooser ----------------------------------------------------------
# Two calls, both to the daemon. The window itself decides nothing: which
# projects exist and which are followed are both answers it is given, and its
# only contribution is which line you clicked.
function Get-Picks {
  $list = New-Object 'System.Collections.Generic.List[VibeTracker.Pick]'
  $err = ''
  try {
    $c = Get-Api '/api/v1/candidates'
    foreach ($x in $c.candidates) {
      $pk = New-Object VibeTracker.Pick
      $pk.Id = [string]$x.projectId
      $pk.Name = [string]$x.displayName
      $pk.On = [bool]$x.tracked
      $list.Add($pk)
    }
  } catch {
    # Not "there are no projects" -- that is a claim about the user's disk we
    # are in no position to make from here. The daemon either refused us or is
    # not there, and those are the two things worth saying.
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $err = if ($code -eq 401 -or $code -eq 403) { $note.L['pickDenied'] } else { $note.L['pickFail'] }
    $list.Clear()
  }
  $note.PickError = [string]$err
  $note.Picks = $list
}

$note.OnPickOpen = [Action] { Get-Picks }

$note.OnToggle = [Action] {
  # A change, not a state. The daemon merges it into whatever is configured,
  # so a project this window never listed keeps whatever the user chose for it
  # somewhere else.
  if ($note.ToggledOn) {
    $body = @{ add = @($note.ToggledId) } | ConvertTo-Json -Compress
  } else {
    $body = @{ remove = @($note.ToggledId) } | ConvertTo-Json -Compress
  }
  try {
    Send-Api '/api/v1/tracking' $body | Out-Null
  } catch {
    # The tick already moved on screen, so failing quietly would leave the
    # window asserting a change that never reached the config.
    Set-Notice ([string]$note.L['pickFail'])
    Get-Picks
  }
}

# Naming a directory. The dialog is the system's own, because the only thing a
# hand-rolled path field would add is the chance to mistype -- and the daemon,
# not this window, decides what the directory turns out to be.
#
# `IFileOpenDialog` first: the Explorer-shaped one, with an address bar you can
# paste into. `FolderBrowserDialog` only if the shell dialog could not be
# created at all -- not when the user simply pressed Cancel.
function Select-ProjectFolder {
  # Stop being always-on-top for the length of the dialog.
  #
  # Ownership is not enough. A dialog owned by this window is kept above *it*,
  # but `TopMost` is `WS_EX_TOPMOST` and that outranks ownership: the picker
  # opened behind the note, and the note went on swallowing the clicks meant
  # for it -- which is how two projects got quietly unfollowed while the dialog
  # sat there waiting. Restored in `finally`, so a failure cannot leave the
  # note sunk behind the editor it exists to sit above.
  $wasTop = $note.TopMost
  $note.TopMost = $false
  try {
    $picked = [VibeTracker.Folders]::Pick($note.Handle, [string]$note.L['chooseDir'])
    if (-not [VibeTracker.Folders]::Unavailable) { return $picked }
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
      $dlg.Description = [string]$note.L['chooseDir']
      $dlg.ShowNewFolderButton = $false
      if ($dlg.ShowDialog($note) -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
      return $null
    } finally {
      $dlg.Dispose()
    }
  } finally {
    $note.TopMost = $wasTop
  }
}

$note.OnAddPath = [Action] {
  $path = Select-ProjectFolder
  if (-not $path) { return }
  try {
    $body = @{ path = $path } | ConvertTo-Json -Compress
    $res = Send-Api '/api/v1/projects/path' $body 20
    Set-Notice ([string]$res.displayName + ' ' + $note.L['pathAdded'])
    Get-Picks
    $note.Fit()
  } catch {
    # Three different failures used to arrive as one sentence. A directory that
    # is not there, a daemon that will not talk to us, and a config we could not
    # write are three different things for the person holding the mouse.
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $why = if ($code -eq 404) { $note.L['pathNotDir'] }
           elseif ($code -eq 401 -or $code -eq 403) { $note.L['pickDenied'] }
           elseif ($code -eq 0) { $note.L['pickFail'] }
           else { $note.L['pathBad'] }
    Set-Notice ([string]$why)
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Refresh })

$note.Add_Shown({
  # Before anything else: the window is up, the handle exists, and this is the
  # first moment the z-order can actually be set. See PinTop.
  $note.PinTop()
  $note.Apply([VibeTracker.Shape]::Full)
  if ($state.mode -ne 'Full') { $note.Apply([Enum]::Parse([VibeTracker.Shape], $state.mode)) }
  Refresh
  $timer.Start()
})

[System.Windows.Forms.Application]::Run($note)
