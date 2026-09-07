# Download Magisk (redroid fork) + LSPosed/Shamiko module zips for Windows Redroid.
# Outputs to vendor/magisk/ (gitignored). Run before creating a Magisk-preset instance:
#   .\scripts\fetch-magisk.ps1
# Optional overrides: -MagiskUrl / -LsposedUrl / -ShamikoUrl
param(
    [string]$MagiskUrl  = "https://github.com/ayasa520/Magisk/releases/download/v30.7/Magisk-v30.7.apk",
    [string]$MagiskMd5  = "0a31050fdcfaa15f47c9dd1eb8d04fc8",
    [string]$LsposedUrl = "",
    [string]$ShamikoUrl = ""
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $Root "vendor\magisk"
$ModDir = Join-Path $DestDir "modules"
New-Item -ItemType Directory -Force -Path $DestDir, $ModDir | Out-Null

function Resolve-GhLatest([string]$Repo, [string]$AssetPattern) {
    # Resolve the newest release asset URL matching a pattern via the GitHub API.
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
        $asset = $rel.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
        if ($asset) { return $asset.browser_download_url }
    } catch {
        Write-Warning "GitHub API lookup failed for $Repo ($($_.Exception.Message))"
    }
    return ""
}

function Get-File([string]$Url, [string]$Out) {
    if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 1MB)) {
        Write-Host "Already present: $Out ($([math]::Round((Get-Item $Out).Length/1MB,1)) MB)"
        return
    }
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
    Write-Host "Saved: $Out ($([math]::Round((Get-Item $Out).Length/1MB,1)) MB)"
}

# --- 1. Magisk fork APK (container-compatible lineage; md5 pinned like upstream redroid-script) ---
$Apk = Join-Path $DestDir "magisk.apk"
Get-File $MagiskUrl $Apk
if ($MagiskMd5) {
    $hash = (Get-FileHash -Algorithm MD5 $Apk).Hash.ToLower()
    if ($hash -ne $MagiskMd5) { throw "Magisk APK MD5 mismatch: $hash (expected $MagiskMd5)" }
    Write-Host "Magisk APK MD5 OK"
}

# --- 2. Extract native binaries from the APK ---
$BinDir = Join-Path $DestDir "magisk"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = Join-Path $env:TEMP ("rdc-magisk-" + [guid]::NewGuid().ToString("N"))
# Expand-Archive only accepts .zip — the APK is a zip, just with the wrong extension
$ApkZip = Join-Path $env:TEMP ("rdc-magisk-" + [guid]::NewGuid().ToString("N") + ".zip")
Copy-Item $Apk $ApkZip -Force
Expand-Archive -Path $ApkZip -DestinationPath $Tmp -Force
Remove-Item $ApkZip -Force -ErrorAction SilentlyContinue
$abi = "x86_64"
if (-not (Test-Path (Join-Path $Tmp "lib\$abi"))) { $abi = "arm64-v8a" }
$map = @{
    # Magisk v30+ fork layout: single magisk binary per ABI
    "libmagisk.so"       = "magisk"
    "libmagiskpolicy.so" = "magiskpolicy"
    "libmagiskboot.so"   = "magiskboot"
    "libbusybox.so"      = "busybox"
    "libmagiskinit.so"   = "magiskinit"
    "libinit-ld.so"      = "init-ld"
    # upstream (v25-v28) layout, kept for forward compatibility
    "libmagisk64.so"     = "magisk64"
    "libmagisk32.so"     = "magisk32"
}
foreach ($k in $map.Keys) {
    $src = Join-Path $Tmp "lib\$abi\$k"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $BinDir $map[$k]) -Force
        Write-Host "Extracted $($map[$k]) ($abi)"
    }
}
if (Test-Path (Join-Path $Tmp "assets\util_functions.sh")) {
    Copy-Item (Join-Path $Tmp "assets\util_functions.sh") (Join-Path $BinDir "util_functions.sh") -Force
    Write-Host "Extracted util_functions.sh"
}
Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
# Copy the APK next to the binaries too (baked into the image as magisk.apk)
Copy-Item $Apk (Join-Path $BinDir "magisk.apk") -Force

# --- 2b. Re-sign the manager APK with the local keystore + emit matching stub.apk ---
# magiskd (check-signature build) derives its trusted cert from /sbin/stub.apk
# (--setup-sbin source dir) and uninstalls any manager whose cert differs. The
# fork's release APK can never pass (no matching stub is published), so both
# artifacts are signed here with vendor/magisk/rdc-resign.keystore via apksig.
$Keystore = Join-Path $DestDir "rdc-resign.keystore"
$Signer = Join-Path $DestDir "SignApk.java"
$Apksig = Join-Path $DestDir "apksig.jar"
if (-not (Test-Path $Keystore)) {
    & keytool -genkeypair -keystore $Keystore -alias rdc -keyalg RSA -keysize 2048 `
        -validity 10950 -storepass rdc-redroid -keypass rdc-redroid `
        -dname "CN=Redroid Device Center,O=RDC,C=CN" -storetype PKCS12 | Out-Null
}
if (-not (Test-Path $Apksig)) {
    Invoke-WebRequest -Uri "https://dl.google.com/dl/android/maven2/com/android/tools/build/apksig/8.7.3/apksig-8.7.3.jar" -OutFile $Apksig -UseBasicParsing
}
& javac -cp $Apksig $Signer
if ($LASTEXITCODE -ne 0) { throw "SignApk.java compile failed" }
& java -cp "$Apksig;$DestDir" SignApk $Keystore rdc-redroid (Join-Path $BinDir "magisk.apk") (Join-Path $BinDir "magisk.apk.signed")
if ($LASTEXITCODE -ne 0) { throw "Magisk APK re-sign failed" }
Move-Item (Join-Path $BinDir "magisk.apk.signed") (Join-Path $BinDir "magisk.apk") -Force
Copy-Item (Join-Path $BinDir "magisk.apk") (Join-Path $BinDir "stub.apk") -Force
Write-Host "Magisk APK re-signed + stub.apk emitted (RDC keystore)"

# --- 3. LSPosed (Zygisk) + Shamiko module zips ---
if (-not $LsposedUrl -or -not $ShamikoUrl) {
    if (-not $LsposedUrl) { $LsposedUrl = Resolve-GhLatest "LSPosed/LSPosed" "zygisk-release\.zip$" }
    if (-not $ShamikoUrl) { $ShamikoUrl = Resolve-GhLatest "LSPosed/LSPosed.github.io" "^Shamiko-.*release\.zip$" }
}
if (-not $LsposedUrl) {
    # Pinned fallback (LSPosed final release, supports Android 13)
    $LsposedUrl = "https://github.com/LSPosed/LSPosed/releases/download/v1.9.2/LSPosed-v1.9.2-69725-zygisk-release.zip"
}
if ($LsposedUrl) {
    $lsName = ($LsposedUrl -split "/")[-1]
    if ($lsName -notlike "lsposed-*") { $lsName = "lsposed-$lsName" }
    Get-File $LsposedUrl (Join-Path $ModDir $lsName)
}
if ($ShamikoUrl) {
    $shName = ($ShamikoUrl -split "/")[-1]
    if ($shName -notlike "shamiko-*") { $shName = "shamiko-$shName" }
    Get-File $ShamikoUrl (Join-Path $ModDir $shName)
} else {
    Write-Warning "Shamiko URL unresolved; download a release zip manually into $ModDir"
}

Write-Host ""
Write-Host "Done. vendor/magisk/ contents:"
Get-ChildItem -Recurse $DestDir -File | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($DestDir.Length + 1)) }
