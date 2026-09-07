#Requires -Version 5.1
<#
.SYNOPSIS
  Switch WSL2 between custom binder kernel and Microsoft default kernel.

.DESCRIPTION
  Edits %USERPROFILE%\.wslconfig [wsl2] kernel= line.
  Does NOT call wsl --shutdown unless -Apply is passed (so Docker Desktop
  and open distros can be closed deliberately).

.PARAMETER Mode
  custom  — use C:\wsl-kernel\bzImage (or -KernelPath)
  default — remove/comment kernel= so WSL uses stock Microsoft kernel

.PARAMETER KernelPath
  Path to custom bzImage (default: C:\wsl-kernel\bzImage)

.PARAMETER Apply
  Run `wsl --shutdown` after writing config

.EXAMPLE
  .\switch-wsl-kernel.ps1 -Mode custom -Apply
  .\switch-wsl-kernel.ps1 -Mode default -Apply
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("custom", "default")]
  [string]$Mode,

  [string]$KernelPath = "C:\wsl-kernel\bzImage",

  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$wslconfig = Join-Path $env:USERPROFILE ".wslconfig"
$backup = Join-Path $env:USERPROFILE (".wslconfig.bak-rdc-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "WARN $msg" -ForegroundColor Yellow }

if ($Mode -eq "custom") {
  if (-not (Test-Path -LiteralPath $KernelPath)) {
    throw "Custom kernel not found: $KernelPath`nBuild it first: scripts\setup-wsl-binder-oneclick.ps1"
  }
  $full = (Resolve-Path -LiteralPath $KernelPath).Path
  # .wslconfig wants doubled backslashes or forward slashes
  $kernelLine = "kernel=" + ($full -replace '\\', '\\')
} else {
  $kernelLine = $null
}

# Load existing content
$lines = @()
if (Test-Path -LiteralPath $wslconfig) {
  Copy-Item -LiteralPath $wslconfig -Destination $backup -Force
  Write-Info "Backed up existing config to $backup"
  $lines = Get-Content -LiteralPath $wslconfig
} else {
  Write-Info "Creating new $wslconfig"
}

# Parse / rebuild [wsl2] section
$out = New-Object System.Collections.Generic.List[string]
$inWsl2 = $false
$wsl2Seen = $false
$kernelWritten = $false

foreach ($line in $lines) {
  $trim = $line.Trim()

  if ($trim -match '^\[(.+)\]$') {
    $section = $Matches[1].Trim().ToLowerInvariant()
    if ($inWsl2 -and -not $kernelWritten -and $Mode -eq "custom") {
      $out.Add($kernelLine)
      $kernelWritten = $true
    }
    $inWsl2 = ($section -eq "wsl2")
    if ($inWsl2) { $wsl2Seen = $true }
    $out.Add($line)
    continue
  }

  if ($inWsl2 -and ($trim -match '^(#\s*)?kernel\s*=')) {
    if ($Mode -eq "custom") {
      $out.Add($kernelLine)
      $kernelWritten = $true
    } else {
      # default: comment out kernel line
      if ($trim -notmatch '^#') {
        $out.Add("# " + $line.TrimStart())
      } else {
        $out.Add($line)
      }
    }
    continue
  }

  $out.Add($line)
}

if ($inWsl2 -and -not $kernelWritten -and $Mode -eq "custom") {
  $out.Add($kernelLine)
  $kernelWritten = $true
}

if (-not $wsl2Seen) {
  if ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -ne "") {
    $out.Add("")
  }
  $out.Add("[wsl2]")
  if ($Mode -eq "custom") {
    $out.Add($kernelLine)
  } else {
    $out.Add("# kernel=  (using Microsoft default)")
  }
}

# Ensure sensible defaults for Redroid/Docker if missing
$contentText = ($out -join "`n")
$ensure = @(
  @{ Key = "networkingMode"; Value = "networkingMode=mirrored" },
  @{ Key = "dnsTunneling"; Value = "dnsTunneling=true" },
  @{ Key = "firewall"; Value = "firewall=true" },
  @{ Key = "autoProxy"; Value = "autoProxy=true" }
)
# Only add defaults when creating minimal config; do not force-overwrite user choices
if (-not (Test-Path -LiteralPath $wslconfig) -or $lines.Count -lt 3) {
  foreach ($e in $ensure) {
    if ($contentText -notmatch [regex]::Escape($e.Key)) {
      # insert after [wsl2]
      $newOut = New-Object System.Collections.Generic.List[string]
      foreach ($l in $out) {
        $newOut.Add($l)
        if ($l.Trim().ToLowerInvariant() -eq "[wsl2]") {
          $newOut.Add($e.Value)
        }
      }
      $out = $newOut
      $contentText = ($out -join "`n")
    }
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($wslconfig, $out.ToArray(), $utf8NoBom)
Write-Ok "Wrote $wslconfig (mode=$Mode)"

if ($Mode -eq "custom") {
  Write-Info "Active kernel path: $KernelPath"
} else {
  Write-Info "Using Microsoft default WSL kernel (kernel= commented/removed)"
}

Write-Host ""
Write-Host "Current .wslconfig:" -ForegroundColor DarkGray
Get-Content -LiteralPath $wslconfig | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

if ($Apply) {
  Write-Info "Running wsl --shutdown (Docker Desktop may need restart)..."
  & wsl --shutdown
  Write-Ok "WSL shut down. Reopen Docker Desktop / Ubuntu to load the kernel."
} else {
  Write-Warn "Config updated but not applied yet. Run: wsl --shutdown"
}
