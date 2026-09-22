[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$BinaryPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseVerifier = Join-Path $repoRoot 'scripts/verify-release-core.ps1'

foreach ($path in $BinaryPath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "required release binary is missing: $path"
    }
}
if (-not (Test-Path -LiteralPath $releaseVerifier -PathType Leaf)) {
    throw "release core verifier is missing: $releaseVerifier"
}

$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$authManifest = Join-Path $repoRoot 'authorization-service/Cargo.toml'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$CommandArguments
    )

    Write-Output "[rotation] $Label"
    & $FilePath @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

Invoke-Checked `
    -Label 'old/new signing-key protocol test' `
    -FilePath $cargo `
    -CommandArguments @(
        'test', '--manifest-path', $authManifest, '--test', 'protocol',
        'restarting_with_next_signing_key_keeps_execution_grants_bound_to_their_authority', '--', '--nocapture'
    )

Invoke-Checked `
    -Label 'runner generation renderer test' `
    -FilePath $cargo `
    -CommandArguments @(
        'test', '--manifest-path', $authManifest, '--bin', 'rdc-auth-admin',
        'runner_rendering_replaces_trusted_key_and_consume_url_placeholders', '--', '--nocapture'
    )

Write-Output '[rotation] release protected-core scan'
& $releaseVerifier -BinaryPath $BinaryPath
if ($LASTEXITCODE -ne 0) {
    throw "release protected-core scan failed with exit code $LASTEXITCODE"
}

Write-Output 'rotation rehearsal passed; production TLS, secret-manager, account, cross-device, and live-guest checks remain manual'
