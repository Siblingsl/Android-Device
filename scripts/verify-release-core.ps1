[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$BinaryPath
)

$runnerBodyMarkers = @(
    "import copy`nimport http.client",
    "def android_version(props):",
    "class UnixHTTP(http.client.HTTPConnection):",
    "def clone_config(inspected, image, old_volume, new_volume):",
    "__RDC_EXECUTION_RELEASE_URL__",
    "__RDC_AUTH_PUBLIC_KEYS__"
)

$violations = @()
foreach ($path in $BinaryPath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $violations += "missing release binary: $path"
        continue
    }

    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $path))
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    $matched = @($runnerBodyMarkers | Where-Object {
        $text.IndexOf([string]$_, [System.StringComparison]::Ordinal) -ge 0
    })
    if ($matched.Count -gt 0) {
        $violations += "$path contains protected runner body marker(s): $($matched -join ', ')"
    }
    else {
        Write-Output "clean: $path"
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    exit 1
}
