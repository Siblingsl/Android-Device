$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'verify-auth-rotation.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "rotation rehearsal script is missing: $scriptPath"
}

$source = Get-Content -LiteralPath $scriptPath -Raw
if ($source -match 'RDC_AUTH_SIGNING_KEY') {
    throw 'rotation rehearsal must not read or mention the signing secret environment variable'
}

$missingBinary = Join-Path $env:TEMP 'rdc-auth-rotation-missing-qemu-center.exe'
$output = @()
$failed = $false
try {
    $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -BinaryPath $missingBinary 2>&1)
    $failed = $LASTEXITCODE -ne 0
}
catch {
    $output += $_
    $failed = $true
}
if (-not $failed) {
    throw 'rotation rehearsal must fail when a required release binary is missing'
}

$joined = ($output | Out-String)
if ($joined -match 'RDC_AUTH_SIGNING_KEY|BEGIN (RSA|OPENSSH|PRIVATE) KEY') {
    throw 'rotation rehearsal output must not expose signing-secret material'
}

Write-Output 'rotation rehearsal contract passed'
