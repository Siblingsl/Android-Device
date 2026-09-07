#Requires -Version 5.1
<#
.SYNOPSIS
  Install prebuilt WSL binder kernel for this machine's arch (download or local file).

.DESCRIPTION
  1. detect-platform → windows-x64 | windows-arm64
  2. Copy/download bzImage → C:\wsl-kernel\bzImage
  3. Optionally switch .wslconfig + wsl --shutdown

  Does nothing useful on Linux (use setup-linux-binder.sh).

.PARAMETER Source
  auto     — try LocalPath, then GitHub Release, then fail with build hint
  local    — only LocalPath / project vendor/
  download — only GitHub Release

.PARAMETER LocalPath
  Path to a bzImage file already on disk

.PARAMETER Owner / Repo / Tag
  Override platform-assets.json github fields

.PARAMETER Apply
  switch-wsl-kernel.ps1 -Mode custom -Apply

.EXAMPLE
  .\install-wsl-kernel.ps1 -Apply
  .\install-wsl-kernel.ps1 -Source local -LocalPath .\dist\wsl-kernel-binder-windows-x64-bzImage -Apply
  .\install-wsl-kernel.ps1 -Owner myorg -Repo Android-Device -Tag wsl-kernel-v1 -Apply
#>
param(
  [ValidateSet("auto", "local", "download")]
  [string]$Source = "auto",

  [string]$LocalPath = "",
  [string]$Owner = "",
  [string]$Repo = "",
  [string]$Tag = "",
  [string]$InstallDir = "C:\wsl-kernel",
  [switch]$Apply,
  [switch]$SkipSwitch
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ScriptDir "platform-assets.json"
$DetectPs1 = Join-Path $ScriptDir "detect-platform.ps1"
$SwitchPs1 = Join-Path $ScriptDir "switch-wsl-kernel.ps1"

function Write-Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "WARN $m" -ForegroundColor Yellow }

# ---- platform ----
$platJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $DetectPs1 -Quiet | Select-Object -Last 1
$plat = $platJson | ConvertFrom-Json
Write-Info "Detected platform=$($plat.platform) strategy=$($plat.strategy)"

if ($plat.os -ne "windows") {
  throw "This script is for Windows only. On Linux run: bash scripts/setup-linux-binder.sh"
}
if (-not $plat.supported) {
  throw "Unsupported platform: $($plat.platform)"
}
if (-not $plat.releaseAssetBzImage) {
  throw "No Release asset name for $($plat.platform)"
}

# ---- manifest ----
$owner = $Owner
$repo = $Repo
$tag = $Tag
if (Test-Path -LiteralPath $ManifestPath) {
  $man = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if (-not $owner) { $owner = $man.github.owner }
  if (-not $repo)  { $repo  = $man.github.repo }
  if (-not $tag)   { $tag   = $man.github.tag }
}

$assetName = $plat.releaseAssetBzImage
$configName = $plat.releaseAssetConfig
$destBz = Join-Path $InstallDir "bzImage"
$destCfg = Join-Path $InstallDir "config-wsl-binder"

function Find-LocalCandidate {
  $cands = @()
  if ($LocalPath) { $cands += $LocalPath }
  $cands += @(
    (Join-Path $ScriptDir "..\vendor\wsl-kernel\$assetName"),
    (Join-Path $ScriptDir "..\vendor\wsl-kernel\bzImage"),
    (Join-Path $InstallDir $assetName),
    (Join-Path $InstallDir "bzImage"),
    (Join-Path $env:USERPROFILE "Downloads\$assetName")
  )
  foreach ($c in $cands) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      return (Resolve-Path -LiteralPath $c).Path
    }
  }
  return $null
}

function Get-ReleaseDownloadUrl([string]$o, [string]$r, [string]$t, [string]$name) {
  if (-not $o -or $o -eq "YOUR_GITHUB_ORG" -or -not $r -or -not $t) {
    return $null
  }
  # Public release asset URL pattern
  return "https://github.com/$o/$r/releases/download/$t/$name"
}

function Download-File([string]$url, [string]$out) {
  Write-Info "Downloading $url"
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  # Prefer curl.exe (Windows 10+); fallback Invoke-WebRequest
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -fsSL -L -o $out $url
    if ($LASTEXITCODE -ne 0) { throw "curl failed: $url" }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  }
  if (-not (Test-Path -LiteralPath $out) -or (Get-Item $out).Length -lt 1MB) {
    throw "Download looks invalid: $out"
  }
}

$resolved = $null

if ($Source -eq "local" -or $Source -eq "auto") {
  $resolved = Find-LocalCandidate
  if ($resolved) {
    Write-Ok "Using local file: $resolved"
  } elseif ($Source -eq "local") {
    throw "No local bzImage found. Place at vendor\wsl-kernel\$assetName or pass -LocalPath"
  }
}

if (-not $resolved -and ($Source -eq "download" -or $Source -eq "auto")) {
  $url = Get-ReleaseDownloadUrl $owner $repo $tag $assetName
  if (-not $url) {
    Write-Warn "GitHub owner/repo not configured in platform-assets.json"
  } else {
    $tmp = Join-Path $env:TEMP $assetName
    try {
      Download-File $url $tmp
      $resolved = $tmp
      # optional config
      $cfgUrl = Get-ReleaseDownloadUrl $owner $repo $tag $configName
      if ($cfgUrl) {
        try { Download-File $cfgUrl (Join-Path $env:TEMP $configName) } catch { Write-Warn "config download skipped: $_" }
      }
    } catch {
      Write-Warn "Download failed: $_"
      $resolved = $null
    }
  }
}

if (-not $resolved) {
  Write-Host ""
  Write-Host "No prebuilt kernel for $($plat.platform)." -ForegroundColor Yellow
  Write-Host "Build on this machine (10-40 min):" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$ScriptDir\setup-wsl-binder-oneclick.ps1`" -Apply" -ForegroundColor White
  Write-Host ""
  Write-Host "Or set platform-assets.json github.owner/repo and publish Release asset:" -ForegroundColor DarkGray
  Write-Host "  $assetName" -ForegroundColor DarkGray
  throw "Kernel install aborted (no file / no download)"
}

# ---- install ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath $resolved -Destination $destBz -Force
Write-Ok "Installed $destBz ($([math]::Round((Get-Item $destBz).Length/1MB,1)) MB)"

$cfgSrc = $null
if ($configName) {
  $cfgCands = @(
    (Join-Path (Split-Path $resolved) $configName),
    (Join-Path $env:TEMP $configName),
    (Join-Path $ScriptDir "..\vendor\wsl-kernel\$configName"),
    (Join-Path $InstallDir $configName)
  )
  foreach ($c in $cfgCands) {
    if (Test-Path -LiteralPath $c) { $cfgSrc = $c; break }
  }
}
if ($cfgSrc) {
  Copy-Item -LiteralPath $cfgSrc -Destination $destCfg -Force
  Write-Ok "Installed $destCfg"
}

if (-not $SkipSwitch) {
  $sw = @{ Mode = "custom"; KernelPath = $destBz }
  if ($Apply) { $sw.Apply = $true }
  & $SwitchPs1 @sw
} else {
  Write-Info "SkipSwitch: files installed only"
}

Write-Ok "Done for platform $($plat.platform)"
