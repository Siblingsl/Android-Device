#Requires -Version 5.1
<#
.SYNOPSIS
  Rename local C:\wsl-kernel build outputs to GitHub Release asset names.

.EXAMPLE
  .\publish-wsl-kernel-assets.ps1 -OutDir .\dist\wsl-kernel
  # then: gh release upload wsl-kernel-latest .\dist\wsl-kernel\*
#>
param(
  [string]$KernelPath = "C:\wsl-kernel\bzImage",
  [string]$ConfigPath = "C:\wsl-kernel\config-wsl-binder",
  [string]$OutDir = "",
  [string]$Platform = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Platform) {
  $Platform = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "detect-platform.ps1") -KeyOnly
}
$Platform = "$Platform".Trim()

if ($Platform -notmatch '^windows-(x64|arm64)$') {
  throw "Publish assets only for windows-x64 / windows-arm64 (got: $Platform)"
}

if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path $ScriptDir) "dist\wsl-kernel"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Test-Path -LiteralPath $KernelPath)) {
  throw "Missing kernel: $KernelPath — build first"
}

$bzName = "wsl-kernel-binder-$Platform-bzImage"
$cfgName = "wsl-kernel-binder-$Platform-config"

Copy-Item -LiteralPath $KernelPath -Destination (Join-Path $OutDir $bzName) -Force
if (Test-Path -LiteralPath $ConfigPath) {
  Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $OutDir $cfgName) -Force
}

Write-Host "Prepared Release assets in $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir | ForEach-Object {
  Write-Host ("  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB))
}
Write-Host ""
Write-Host "Upload example:" -ForegroundColor Cyan
Write-Host "  gh release create wsl-kernel-latest --title `"WSL binder kernel`" --notes `"prebuilt`" `"$OutDir\$bzName`""
Write-Host "  # or upload into existing tag:"
Write-Host "  gh release upload wsl-kernel-latest `"$OutDir\$bzName`" `"$OutDir\$cfgName`" --clobber"
Write-Host ""
Write-Host "Then set scripts\platform-assets.json github.owner / repo" -ForegroundColor DarkGray
