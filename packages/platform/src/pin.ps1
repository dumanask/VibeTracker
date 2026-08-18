# Keep one window above the others.
#
# The window belongs to a browser we launched, so we cannot ask it to pin
# itself -- a web page has no such power, and giving one that power would be a
# worse idea than the inconvenience it solves. Win32 does have the power, and
# it is two calls: find the window, then set its z-order band.
#
# Nothing here is destructive. `SetWindowPos` with SWP_NOMOVE|SWP_NOSIZE moves
# a window between z-order bands and changes nothing else; the user can still
# move, resize and close the window normally, and unpinning is a restart away.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [int]$TimeoutMs = 15000,
  [switch]$Unpin,
  # Report what is there without touching it. Used to tell "our window is
  # still open" from "that pid belongs to something else now" -- this product
  # exists partly because pids get recycled, so it had better not trust one.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace VtWin -Name Api -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
    int X, int Y, int cx, int cy, uint uFlags);
'@

$HWND_TOPMOST   = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE     = 0x0002
$SWP_NOSIZE     = 0x0001
$SWP_NOACTIVATE = 0x0010

# The browser forks and settles before it owns a window, so the handle is not
# there the instant the process is. Poll rather than sleep-and-hope: on a cold
# start this takes seconds, on a warm one milliseconds, and a fixed wait would
# be wrong in both directions.
$deadline = [Environment]::TickCount + $TimeoutMs
$handle = [IntPtr]::Zero
$title = ''
while ([Environment]::TickCount -lt $deadline) {
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
      $handle = $p.MainWindowHandle
      $title = $p.MainWindowTitle
      break
    }
  } catch {
    # The process is gone: nothing to pin, and that is not our error to raise.
    Write-Output '{"ok":false,"reason":"process-gone"}'
    exit 0
  }
  Start-Sleep -Milliseconds 120
}

if ($handle -eq [IntPtr]::Zero) {
  Write-Output '{"ok":false,"reason":"no-window"}'
  exit 0
}

$titleJson = ($title | ConvertTo-Json -Compress)

if ($CheckOnly) {
  Write-Output "{`"ok`":true,`"title`":$titleJson}"
  exit 0
}

$target = if ($Unpin) { $HWND_NOTOPMOST } else { $HWND_TOPMOST }
$flags = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE
$ok = [VtWin.Api]::SetWindowPos($handle, $target, 0, 0, 0, 0, $flags)

if ($ok) { Write-Output "{`"ok`":true,`"title`":$titleJson}" }
else { Write-Output '{"ok":false,"reason":"setwindowpos"}' }
