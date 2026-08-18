# Persistent process-probe host for VibeTracker (Windows).
#
# Why a long-lived host: Node cannot read a process's *start time* or
# cumulative CPU time natively on Windows, and spawning PowerShell per poll
# costs ~200 ms. This process is started once and answers one JSON line per
# request, covering every requested PID in a single Get-Process call (~50 ms).
#
# Protocol (one JSON object per line, in and out):
#   in : {"id":1,"cmd":"procs","pids":[123,456]}   |  {"id":2,"cmd":"tree"}  |  {"cmd":"quit"}
#   out: {"ok":true,"id":1,"procs":[{"pid":123,"startTime":"1343...","cpuNs":...,"rss":...}]}
#   out: {"ok":true,"id":2,"tree":[{"pid":123,"ppid":456,"startMs":1787000000000}]}
#   out: {"ok":false,"id":1,"error":"..."}
#
# startTime is a Win32 FILETIME rendered as a decimal string. It is compared
# for equality only, never parsed -- it is the PID-reuse guard.
#
# The `tree` reply carries pid, parent pid and start time and NOTHING else. In
# particular it never carries CommandLine: that is where API keys and tokens
# live, and a monitoring tool must not put them in memory, let alone in a log.

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $reqId = $null
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    if ($req.cmd -eq 'quit') { break }

    if ($req.cmd -eq 'tree') {
      $nodes = New-Object System.Collections.ArrayList
      # Select only these three properties. CommandLine is deliberately absent.
      foreach ($w in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction SilentlyContinue)) {
        $ms = $null
        try { if ($null -ne $w.CreationDate) { $ms = [long][Math]::Floor(($w.CreationDate.ToUniversalTime() - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds) } } catch { $ms = $null }
        [void]$nodes.Add([pscustomobject]@{
            pid     = [int]$w.ProcessId
            ppid    = [int]$w.ParentProcessId
            startMs = $ms
          })
      }
      $resp = [pscustomobject]@{ ok = $true; id = $reqId; tree = @($nodes) }
      [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 5))
      continue
    }

    $ids = @()
    if ($null -ne $req.pids) { $ids = @($req.pids) }

    $out = New-Object System.Collections.ArrayList
    if ($ids.Count -gt 0) {
      foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
        # Any of these can throw for protected or exiting processes.
        $st = ''
        try { $st = $p.StartTime.ToFileTime().ToString() } catch { $st = '' }
        $cpu = [long]0
        try { $cpu = [long]($p.TotalProcessorTime.Ticks * 100) } catch { $cpu = [long]0 }
        $ws = [long]0
        try { $ws = [long]$p.WorkingSet64 } catch { $ws = [long]0 }
        [void]$out.Add([pscustomobject]@{
            pid       = [int]$p.Id
            startTime = $st
            cpuNs     = $cpu
            rss       = $ws
          })
      }
    }

    $resp = [pscustomobject]@{ ok = $true; id = $reqId; procs = @($out) }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 5))
  } catch {
    $resp = [pscustomobject]@{ ok = $false; id = $reqId; error = $_.Exception.Message }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 3))
  }
}
