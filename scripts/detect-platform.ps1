#Requires -Version 5.1
<#
.SYNOPSIS
  Detect OS + CPU arch and print platform key for kernel/binder install.

.OUTPUTS
  JSON object (default) or plain platform key with -KeyOnly

.EXAMPLE
  .\detect-platform.ps1
  .\detect-platform.ps1 -KeyOnly
#>
param(
  [switch]$KeyOnly,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Get-OsId {
  if ($IsLinux) { return "linux" }
  if ($IsMacOS) { return "darwin" }
  # Windows PowerShell 5.1 has no $IsWindows
  return "windows"
}

function Get-ArchId {
  # Prefer env (works on Win PS 5.1)
  $pa = $env:PROCESSOR_ARCHITECTURE
  $paArch = $env:PROCESSOR_ARCHITEW6432
  $raw = if ($paArch) { $paArch } else { $pa }

  if (-not $raw -and (Get-Command uname -ErrorAction SilentlyContinue)) {
    $raw = (& uname -m 2>$null)
  }

  switch -Regex ("$raw".ToLowerInvariant()) {
    '^(amd64|x86_64|x64)$' { return "x64" }
    '^(arm64|aarch64)$'    { return "arm64" }
    '^(armv7|armv7l|arm)$' { return "armv7" }
    '^(riscv64)$'          { return "riscv64" }
    default {
      if ($raw) { return "$raw".ToLowerInvariant() }
      return "unknown"
    }
  }
}

$os = Get-OsId
$arch = Get-ArchId
$platform = "$os-$arch"

$needsWslKernel = ($os -eq "windows")
$supported = $false
$strategy = "unsupported"

switch ($platform) {
  "windows-x64" {
    $supported = $true
    $strategy = "wsl-prebuilt-or-build"
  }
  "windows-arm64" {
    $supported = $true
    $strategy = "wsl-prebuilt-or-build"
  }
  "linux-x64" {
    $supported = $true
    $strategy = "host-binder"
    $needsWslKernel = $false
  }
  "linux-arm64" {
    $supported = $true
    $strategy = "host-binder"
    $needsWslKernel = $false
  }
  default {
    $supported = $false
    $strategy = "unsupported"
    $needsWslKernel = $false
  }
}

$assetBz = $null
$assetCfg = $null
if ($platform -eq "windows-x64") {
  $assetBz = "wsl-kernel-binder-windows-x64-bzImage"
  $assetCfg = "wsl-kernel-binder-windows-x64-config"
} elseif ($platform -eq "windows-arm64") {
  $assetBz = "wsl-kernel-binder-windows-arm64-bzImage"
  $assetCfg = "wsl-kernel-binder-windows-arm64-config"
}

$info = [ordered]@{
  platform           = $platform
  os                 = $os
  arch               = $arch
  supported          = $supported
  needsWslKernel     = [bool]$needsWslKernel
  strategy           = $strategy
  releaseAssetBzImage = $assetBz
  releaseAssetConfig  = $assetCfg
  processorArchitecture = $env:PROCESSOR_ARCHITECTURE
  processArchitew6432   = $env:PROCESSOR_ARCHITEW6432
}

if ($KeyOnly) {
  Write-Output $platform
  exit 0
}

$json = $info | ConvertTo-Json -Compress
if (-not $Quiet) {
  Write-Host "platform=$platform os=$os arch=$arch strategy=$strategy supported=$supported" -ForegroundColor Cyan
}
Write-Output $json
