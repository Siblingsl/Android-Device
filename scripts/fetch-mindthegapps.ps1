# Download MindTheGapps x86_64 zip for Windows Redroid (not committed).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $Root "vendor\gapps"
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

$Url = "https://github.com/MindTheGapps/13.0.0-x86_64/releases/download/MindTheGapps-13.0.0-x86_64-20231025_201203/MindTheGapps-13.0.0-x86_64-20231025_201203.zip"
$Out = Join-Path $DestDir "MindTheGapps-13.0.0-x86_64-20231025_201203.zip"

if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 10MB)) {
    Write-Host "Already present: $Out ($([math]::Round((Get-Item $Out).Length/1MB,1)) MB)"
    exit 0
}

Write-Host "Downloading MindTheGapps 13 x86_64 (~188 MB)..."
Write-Host $Url
Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
Write-Host "Saved: $Out ($([math]::Round((Get-Item $Out).Length/1MB,1)) MB)"
