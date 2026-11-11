# wifilt-update.ps1 -- updates WIFILT on Windows to the newest published build,
# reporting every step to the web interface (status.json, read by wifilt as
# /update/status). The Windows counterpart of wifilt-update.sh.
#
# Started by wifilt.exe itself (detached), never by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File wifilt-update.ps1 `
#     -Action check|update -ExeDir <dir> -StateDir <dir> -Port <n> -Id <id> [-Dry]
#
# The parameters come from wifilt, not from the web: the page can only ask for
# "check" or "update". What gets installed is the channel's newest build of this
# edition, checked against the SHA256 in latest.json.
#
# Windows cannot replace a running .exe, so the order is: download and verify
# while wifilt still runs (the page shows the progress), then ask wifilt to quit
# cleanly (/update/quit logs the radio out), replace the files, start it again.
# The previous files are kept in .prev\ and put back if the new version does
# not answer.

param(
  [ValidateSet('check', 'update')][string]$Action = 'check',
  [Parameter(Mandatory = $true)][string]$ExeDir,
  [Parameter(Mandatory = $true)][string]$StateDir,
  [int]$Port = 80,
  [string]$Id = '',
  [switch]$Dry
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Status  = Join-Path $StateDir 'status.json'
$Check   = Join-Path $StateDir 'check.json'
$LogFile = Join-Path $StateDir 'update.log'
$DlDir   = Join-Path $StateDir 'dl'
$Cancel  = Join-Path $StateDir 'cancel'
$Prev    = Join-Path $ExeDir '.prev'
$Platform = 'windows-x64'
# Assembled, so this file never contains the extension mark itself: the page
# publisher refuses any public archive in which the literal appears.
$EditionMark = 'WIFILT-' + 'ADDONS'

New-Item -ItemType Directory -Force -Path $StateDir, $DlDir | Out-Null

function Now { [int][double]::Parse((Get-Date -UFormat %s)) }

# ------------------------------------------------------------------ channel --
$Channel = @{ KIND = 'pages'; BASE = 'https://ok1hra.github.io/wifilt/'; REPO = ''; TOKEN = 'none' }
$chFile = Join-Path $ExeDir 'update-channel.conf'
if (Test-Path $chFile) {
  foreach ($line in Get-Content $chFile) {
    if ($line -match '^(KIND|BASE|REPO|TOKEN)=(.*)$') {
      $k = $Matches[1]; $v = $Matches[2].Trim()
      switch ($k) {
        'KIND'  { if ($v -in 'pages', 'gh-release') { $Channel.KIND = $v } }
        'BASE'  { if ($v -match '^https?://[A-Za-z0-9._:/~-]+/$') { $Channel.BASE = $v } }
        'REPO'  { if ($v -match '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { $Channel.REPO = $v } }
        'TOKEN' { if ($v -in 'required', 'none') { $Channel.TOKEN = $v } }
      }
    }
  }
}
if ($env:WIFILT_UPDATE_BASE) { $Channel.KIND = 'pages'; $Channel.BASE = $env:WIFILT_UPDATE_BASE }

function Get-Token {
  $f = Join-Path (Split-Path $StateDir -Parent) 'update-token'
  if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
  return ''
}

$script:GhAssets = @{}
function Get-Latest {
  if ($Channel.KIND -eq 'pages') {
    return Invoke-RestMethod -UseBasicParsing -Uri ($Channel.BASE + 'latest.json') -TimeoutSec 30
  }
  $tok = Get-Token
  if ($Channel.TOKEN -eq 'required' -and -not $tok) { throw 'token-missing' }
  $h = @{ Accept = 'application/vnd.github+json' }
  if ($tok) { $h.Authorization = "Bearer $tok" }
  $rel = Invoke-RestMethod -UseBasicParsing -Headers $h -TimeoutSec 30 `
    -Uri "https://api.github.com/repos/$($Channel.REPO)/releases/latest"
  foreach ($a in $rel.assets) { $script:GhAssets[$a.name] = $a.url }
  if (-not $script:GhAssets['latest.json']) { throw 'release has no latest.json' }
  $h.Accept = 'application/octet-stream'
  return Invoke-RestMethod -UseBasicParsing -Headers $h -Uri $script:GhAssets['latest.json'] -TimeoutSec 30
}

function Get-InstalledRev {
  $f = Join-Path $ExeDir 'VERSION'
  if (Test-Path $f) { return ((Get-Content $f -Raw) -replace '[^0-9]', '') }
  return ''
}

# ------------------------------------------------------------------- status --
$Phases  = @('check', 'download', 'verify', 'backup', 'stop', 'install', 'start', 'health', 'done')
$Weights = @(2, 40, 8, 5, 5, 20, 5, 15, 0)
$S = [ordered]@{
  id = $Id; from = (Get-InstalledRev); to = ''; platform = $Platform; mode = 'windows'
  state = 'running'; dry = [int][bool]$Dry; phase = 'check'; phaseIdx = 0; phases = $Phases
  phasePct = 0; pct = 0; bytes = 0; total = 0; msg = ''; error = ''
  startedAt = (Now); ts = (Now); log = @()
}

function Write-Log([string]$text) {
  $line = (Get-Date -Format 'HH:mm:ss') + ' ' + $text
  Add-Content -Path $LogFile -Value $line
}

function Write-Status {
  $sum = ($Weights | Measure-Object -Sum).Sum
  $doneW = 0
  for ($i = 0; $i -lt $S.phaseIdx; $i++) { $doneW += $Weights[$i] }
  $p = [int](($doneW * 100 + $Weights[$S.phaseIdx] * $S.phasePct) / $sum)
  if ($S.state -eq 'done') { $p = 100 }
  $S.pct = [Math]::Min(100, $p)
  $S.ts = Now
  $S.log = @(if (Test-Path $LogFile) { Get-Content $LogFile -Tail 30 })
  $tmp = "$Status.tmp"
  ($S | ConvertTo-Json -Compress -Depth 4) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force $tmp $Status
}

function Set-Phase([string]$name, [string]$msg) {
  $S.phaseIdx = [Array]::IndexOf($Phases, $name)
  $S.phase = $name; $S.phasePct = 0; $S.msg = $msg
  Write-Log "[$name] $msg"
  Write-Status
}

function Fail([string]$why) {
  $S.state = 'failed'; $S.error = $why
  Write-Log "ERROR: $why"
  Write-Status
}

# -------------------------------------------------------------------- check --
function Invoke-Check {
  $err = ''; $rev = ''; $name = ''; $size = 0; $sha = ''
  try {
    $m = Get-Latest
    $rev = [string]$m.rev
    $a = $m.assets.$Platform
    if ($a) { $name = [string]$a.name; $size = [long]$a.size; $sha = [string]$a.sha256 }
    elseif ($rev) { $err = "no build for $Platform in REV $rev" }
    else { $err = 'latest.json without rev' }
  } catch {
    $err = if ($_.Exception.Message -eq 'token-missing') { 'token-missing' } else { $_.Exception.Message }
  }
  $o = [ordered]@{
    rev = $rev; installed = (Get-InstalledRev); platform = $Platform; asset = $name; size = $size
    sha256 = $sha; channel = $Channel.KIND; tokenNeeded = ($Channel.TOKEN -eq 'required')
    checkedAt = (Now); error = $err
  }
  ($o | ConvertTo-Json -Compress) | Set-Content -Path "$Check.tmp" -Encoding UTF8
  Move-Item -Force "$Check.tmp" $Check
  return $o
}

# ------------------------------------------------------------------- update --
function Test-Health([string]$rev, [int]$limit) {
  $t0 = Now
  while ((Now) - $t0 -lt $limit) {
    try {
      $b = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/health.json").Content
      if ($b -like "*`"rev`":`"$rev`"*") { return $true }
    } catch { }
    $S.phasePct = [int](((Now) - $t0) * 100 / $limit); $S.msg = "waiting for WIFILT $rev on port $Port"
    Write-Status
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-Wifilt {
  $argsFile = Join-Path $StateDir 'restart-args.txt'
  $argList = @()
  if (Test-Path $argsFile) { $argList = @(Get-Content $argsFile | Where-Object { $_ -ne '' }) }
  if ($argList.Count -eq 0) { $argList = @('--data-dir', (Join-Path $ExeDir 'data')) }
  $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  Start-Process -FilePath (Join-Path $ExeDir 'wifilt.exe') -ArgumentList $quoted -WorkingDirectory $ExeDir
}

function Start-LocalTrx {
  $env:LOCAL_TRX_SKIP_AUTO_OPEN = '1'
  Start-Process -FilePath (Join-Path $ExeDir 'local-trx.exe') -WorkingDirectory $ExeDir
}

function Restore-Previous([bool]$ltx) {
  Write-Log "restoring the previous version from $Prev"
  Get-Process wifilt, local-trx -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($ExeDir, 'OrdinalIgnoreCase') } | Stop-Process -Force
  Start-Sleep -Seconds 1
  Copy-Item -Path (Join-Path $Prev '*') -Destination $ExeDir -Recurse -Force
  Start-Wifilt
  if ($ltx) { Start-LocalTrx }
}

function Invoke-Update {
  Remove-Item -Force -ErrorAction SilentlyContinue $Cancel
  Set-Content -Path $LogFile -Value ''
  Write-Log "----- wifilt-update.ps1 $(Get-Date -Format s) dry=$([int][bool]$Dry) -----"

  Set-Phase 'check' 'looking for the newest build'
  $c = Invoke-Check
  if ($c.error) { Fail "check failed: $($c.error)"; return }
  $S.to = $c.rev
  if ($c.sha256 -notmatch '^[0-9a-f]{64}$') { Fail "latest.json has no valid SHA256 for $Platform"; return }
  if (-not $Dry -and $S.from -and ([long]$S.to -le [long]$S.from)) {
    Fail "REV $($S.to) is not newer than the installed $($S.from)"; return
  }
  Write-Log "installed $($S.from), newest $($S.to) ($($c.asset), $($c.size) B)"

  # download, streamed so the bar moves
  Set-Phase 'download' "downloading $($c.asset)"
  $file = Join-Path $DlDir $c.asset
  Get-ChildItem $DlDir -Filter 'wifilt-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force
  $S.total = $c.size; $S.bytes = 0
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromMinutes(30)
  $url = $Channel.BASE + $c.asset
  if ($Channel.KIND -eq 'gh-release') {
    $url = $script:GhAssets[$c.asset]
    $client.DefaultRequestHeaders.Add('Accept', 'application/octet-stream')
    $tok = Get-Token
    if ($tok) { $client.DefaultRequestHeaders.Add('Authorization', "Bearer $tok") }
    $client.DefaultRequestHeaders.Add('User-Agent', 'wifilt-update')
  }
  try {
    $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
    if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode)" }
    $in = $resp.Content.ReadAsStreamAsync().Result
    $out = [IO.File]::Create($file)
    $buf = New-Object byte[] 65536
    $last = [DateTime]::UtcNow
    try {
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n)
        $S.bytes += $n
        if (([DateTime]::UtcNow - $last).TotalMilliseconds -ge 700) {
          $last = [DateTime]::UtcNow
          if ($S.total -gt 0) { $S.phasePct = [Math]::Min(99, [int]($S.bytes * 100 / $S.total)) }
          Write-Status
          if (Test-Path $Cancel) { throw 'cancelled' }
          if ($Dry) { Start-Sleep -Milliseconds 150 }
        }
      }
    } finally { $out.Close(); $in.Close() }
  } catch {
    if ($_.Exception.Message -eq 'cancelled' -or $_.Exception.InnerException.Message -eq 'cancelled') {
      $S.state = 'cancelled'; Write-Log 'cancelled during download'; Write-Status; return
    }
    Fail "download failed: $($_.Exception.Message)"; return
  }
  Write-Log "downloaded $($S.bytes) B"

  Set-Phase 'verify' 'checking SHA256 and the package'
  $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($got -ne $c.sha256) { Fail "SHA256 mismatch: got $got, expected $($c.sha256)"; return }
  $S.phasePct = 40; $S.msg = 'SHA256 ok'; Write-Status
  $work = Join-Path $DlDir 'pkg'
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
  Expand-Archive -Path $file -DestinationPath $work -Force
  $pkg = Get-ChildItem $work -Directory | Select-Object -First 1
  if (-not $pkg -or -not (Test-Path (Join-Path $pkg.FullName 'wifilt.exe'))) { Fail 'package is incomplete'; return }
  $pkg = $pkg.FullName
  $pkgRev = ''
  if (Test-Path (Join-Path $pkg 'VERSION')) { $pkgRev = (Get-Content (Join-Path $pkg 'VERSION') -Raw) -replace '[^0-9]', '' }
  if ($pkgRev -ne $S.to) { Fail "package VERSION '$pkgRev' does not match REV $($S.to)"; return }
  $edOld = [bool](Select-String -Path (Join-Path $ExeDir 'wifilt.exe') -SimpleMatch $EditionMark -Quiet)
  $edNew = [bool](Select-String -Path (Join-Path $pkg 'wifilt.exe') -SimpleMatch $EditionMark -Quiet)
  if ($edOld -ne $edNew) { Fail 'the package is a different edition than the installed one -- refused'; return }
  $S.phasePct = 100; $S.msg = 'package ok'; Write-Status
  if (Test-Path $Cancel) { $S.state = 'cancelled'; Write-Log 'cancelled'; Write-Status; return }

  Set-Phase 'backup' 'saving the current version'
  if (-not $Dry) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Prev
    New-Item -ItemType Directory -Force -Path $Prev | Out-Null
    Get-ChildItem $ExeDir -Force | Where-Object { $_.Name -ne '.prev' } |
      Copy-Item -Destination $Prev -Recurse -Force
  } else { Start-Sleep -Seconds 1 }

  Set-Phase 'stop' 'stopping WIFILT (the page will reconnect)'
  $ltx = [bool](Get-Process local-trx -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($ExeDir, 'OrdinalIgnoreCase') })
  Write-Log "local-trx running before: $ltx"
  $S.state = 'offline'; Write-Status
  if (-not $Dry) {
    try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 5 -Uri "http://127.0.0.1:$Port/update/quit" | Out-Null } catch { }
    $t0 = Now
    while ((Get-Process wifilt -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($ExeDir, 'OrdinalIgnoreCase') }) -and ((Now) - $t0 -lt 15)) {
      Start-Sleep -Milliseconds 300
    }
    Get-Process wifilt, local-trx -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($ExeDir, 'OrdinalIgnoreCase') } | Stop-Process -Force
    Start-Sleep -Seconds 1
  } else { Start-Sleep -Seconds 2 }

  Set-Phase 'install' "installing REV $($S.to)"
  if (-not $Dry) {
    try {
      $dataDir = Join-Path $ExeDir 'data'
      if (Test-Path (Join-Path $pkg 'data')) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dataDir }
      Copy-Item -Path (Join-Path $pkg '*') -Destination $ExeDir -Recurse -Force
    } catch {
      Fail "install failed: $($_.Exception.Message)"; Restore-Previous $ltx; return
    }
  } else { Start-Sleep -Seconds 3 }

  Set-Phase 'start' 'starting WIFILT'
  if (-not $Dry) {
    Start-Wifilt
    if ($ltx) { Start-LocalTrx }
  }

  Set-Phase 'health' 'waiting for the new version to answer'
  $expect = if ($Dry) { $S.from } else { $S.to }
  if (-not (Test-Health $expect 60)) {
    Fail 'the new version did not answer within 60 s'
    if (-not $Dry) { Restore-Previous $ltx }
    Write-Status; return
  }
  $S.state = 'done'
  Set-Phase 'done' $(if ($Dry) { 'dry run finished, nothing was changed' } else { "updated to REV $($S.to)" })
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work, $file
  if (-not $Dry) { Invoke-Check | Out-Null }
}

# --------------------------------------------------------------------- main --
$mutex = New-Object System.Threading.Mutex($false, 'Local\wifilt-update')
if (-not $mutex.WaitOne(0)) { exit 1 }
try {
  if ($Action -eq 'check') { Invoke-Check | Out-Null }
  else {
    try { Invoke-Update }
    catch { Fail "updater error: $($_.Exception.Message)" }
  }
} finally { $mutex.ReleaseMutex() }
