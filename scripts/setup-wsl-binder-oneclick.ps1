#Requires -Version 5.1
<#
.SYNOPSIS
  One-click: build binder WSL kernel inside Ubuntu and switch Windows to it.

.DESCRIPTION
  1. Detects WSL + a Linux distro (prefers Ubuntu*)
  2. Copies/runs scripts/build-wsl-binder-kernel.sh inside that distro
  3. Switches %USERPROFILE%\.wslconfig to C:\wsl-kernel\bzImage
  4. Optionally shuts down WSL so the new kernel loads

.PARAMETER Distro
  WSL distro name (default: auto-detect Ubuntu)

.PARAMETER SkipBuild
  Only switch kernel if bzImage already exists

.PARAMETER SkipSwitch
  Only build, do not edit .wslconfig

.PARAMETER Apply
  Run wsl --shutdown after switch

.PARAMETER Jobs
  Parallel make jobs (default: nproc inside WSL)

.EXAMPLE
  .\setup-wsl-binder-oneclick.ps1 -Apply
  .\setup-wsl-binder-oneclick.ps1 -SkipBuild -Apply
#>
param(
  [string]$Distro = "",
  [switch]$SkipBuild,
  [switch]$SkipSwitch,
  [switch]$Apply,
  [int]$Jobs = 0,
  [string]$KernelPath = "C:\wsl-kernel\bzImage"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildSh = Join-Path $ScriptDir "build-wsl-binder-kernel.sh"
$SwitchPs1 = Join-Path $ScriptDir "switch-wsl-kernel.ps1"

function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "ERR $msg" -ForegroundColor Red }

# ---- prerequisites ----
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
  throw "WSL not found. Install: wsl --install"
}

$wslList = & wsl -l -q 2>$null
if (-not $wslList) {
  # fallback older wsl
  $raw = & wsl -l 2>&1 | Out-String
  if ($raw -notmatch "Ubuntu|Debian|openSUSE|kali") {
    throw "No WSL distro found. Install Ubuntu from Microsoft Store, then re-run."
  }
}

function Get-WslDistros {
  $names = @()
  $bytes = & wsl.exe -l -q 2>$null
  # wsl -l outputs UTF-16LE on many systems
  if ($bytes -is [array]) {
    foreach ($n in $bytes) {
      $s = "$n".Trim()
      if ($s) { $names += $s }
    }
  } else {
    $text = (& wsl.exe -l -q 2>&1 | Out-String) -replace "`0", ""
    foreach ($line in ($text -split "`r?`n")) {
      $s = $line.Trim()
      if ($s) { $names += $s }
    }
  }
  # Also parse verbose list for robustness
  if ($names.Count -eq 0) {
    $verbose = (& wsl.exe -l -v 2>&1 | Out-String) -replace "`0", ""
    foreach ($line in ($verbose -split "`r?`n")) {
      if ($line -match '^\s*\*?\s*(\S+)\s+(Running|Stopped)') {
        $names += $Matches[1]
      }
    }
  }
  return $names | Select-Object -Unique
}

$distros = @(Get-WslDistros)
Write-Info "WSL distros: $($distros -join ', ')"

if (-not $Distro) {
  $Distro = $distros | Where-Object { $_ -match '^Ubuntu' } | Select-Object -First 1
  if (-not $Distro) {
    $Distro = $distros | Where-Object { $_ -notmatch 'docker-desktop' } | Select-Object -First 1
  }
}
if (-not $Distro) {
  throw "Could not pick a WSL distro. Pass -Distro 'Ubuntu-22.04'"
}
Write-Info "Using distro: $Distro"

if (-not (Test-Path -LiteralPath $BuildSh)) {
  throw "Missing build script: $BuildSh"
}

# Convert Windows path to /mnt/c/... for WSL
function ConvertTo-WslPath([string]$WinPath) {
  $p = (Resolve-Path -LiteralPath $WinPath).Path
  if ($p -match '^([A-Za-z]):\\(.*)$') {
    $drive = $Matches[1].ToLowerInvariant()
    $rest = ($Matches[2] -replace '\\', '/')
    return "/mnt/$drive/$rest"
  }
  return $p -replace '\\', '/'
}

# ---- build ----
if (-not $SkipBuild) {
  $buildWsl = ConvertTo-WslPath $BuildSh
  $jobArg = ""
  if ($Jobs -gt 0) { $jobArg = "--jobs $Jobs" }

  Write-Info "Building kernel inside WSL ($Distro). This takes 10–40 minutes..."
  Write-Host "    script: $buildWsl" -ForegroundColor DarkGray

  # Ensure executable + run with bash (handles CRLF via sed)
  $remoteCmd = @"
set -e
BUILD_SH='$buildWsl'
if [ ! -f "`$BUILD_SH" ]; then echo "Build script not found: `$BUILD_SH"; exit 1; fi
# Strip CRLF if script was checked out on Windows
sed -i 's/\r$//' "`$BUILD_SH" 2>/dev/null || true
chmod +x "`$BUILD_SH"
bash "`$BUILD_SH" $jobArg
"@

  & wsl.exe -d $Distro -e bash -lc $remoteCmd
  if ($LASTEXITCODE -ne 0) {
    throw "Kernel build failed (exit $LASTEXITCODE)"
  }
  Write-Ok "Build finished"
} else {
  Write-Info "SkipBuild: not compiling"
}

if (-not (Test-Path -LiteralPath $KernelPath)) {
  throw "Kernel image missing after build: $KernelPath"
}
Write-Ok "Kernel image: $KernelPath ($([math]::Round((Get-Item $KernelPath).Length / 1MB, 1)) MB)"

# ---- switch ----
if (-not $SkipSwitch) {
  Write-Info "Switching .wslconfig to custom kernel..."
  $switchArgs = @{
    Mode = "custom"
    KernelPath = $KernelPath
  }
  if ($Apply) { $switchArgs.Apply = $true }
  & $SwitchPs1 @switchArgs
} else {
  Write-Info "SkipSwitch: .wslconfig not modified"
}

Write-Host ""
Write-Ok "Done."
if (-not $Apply) {
  Write-Host "Apply when ready:" -ForegroundColor Yellow
  Write-Host "  wsl --shutdown" -ForegroundColor Yellow
  Write-Host "  (then start Docker Desktop)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Verify binder after restart:" -ForegroundColor Cyan
Write-Host "  wsl -d $Distro -e bash -c `"uname -r; zcat /proc/config.gz | grep BINDER`"" -ForegroundColor DarkGray
Write-Host "  docker info" -ForegroundColor DarkGray
