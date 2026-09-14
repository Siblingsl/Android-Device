#!/usr/bin/env bash
#
# Build RDC NativeCloak (Zygisk module) — cross-compile x86_64 + arm64-v8a
# with the Android NDK and package a flashable Magisk module zip.
#
# Requirements:
#   * Android NDK r25+ ($ANDROID_NDK_HOME or $ANDROID_NDK_ROOT, or pass the
#     path as the first argument).
#   * zip / unzip for packaging.
#
# Output:
#   dist/x86_64/librdc_nativecloak.so
#   dist/arm64-v8a/librdc_nativecloak.so
#   dist/RDC-NativeCloak.zip   (Magisk module: module/ + zygisk/<abi>.so)
#
# NOTE: this repository's CI/desktop environment has no NDK — this script is
# the documented way to build locally; it is NOT run automatically.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API=26          # redroid 11+ zygotes; 26 is a safe floor
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

# --- locate the NDK ---------------------------------------------------------
NDK="${1:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
if [ -z "$NDK" ]; then
  echo "error: set ANDROID_NDK_HOME (or pass the NDK path as argv[1])" >&2
  exit 1
fi
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt"
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$HOST_OS" in
  linux) HOST_TAG=linux-x86_64 ;;
  darwin) HOST_TAG=darwin-x86_64 ;;
  msys*|mingw*|windows*) HOST_TAG=windows-x86_64 ;;
  *) echo "error: unsupported host $HOST_OS" >&2; exit 1 ;;
esac
CLANG_BIN="$TOOLCHAIN/$HOST_TAG/bin"
[ -d "$CLANG_BIN" ] || { echo "error: toolchain not found at $CLANG_BIN" >&2; exit 1; }

mkdir -p "$ROOT/dist"

# --- compile both ABIs -------------------------------------------------------
# Single translation unit; libc++_static not needed (pure C-ish C++), keeping
# the .so free of libc++ dependencies simplifies zygote injection.
build_abi() {
  local abi="$1" triple="$2"
  local cc="$CLANG_BIN/${triple}${API}-clang++"
  local out="$ROOT/dist/${abi}"
  mkdir -p "$out"
  echo "==> building ${abi}"
  "$cc" -std=c++17 -O2 -fvisibility=hidden \
    -shared -fPIC \
    -o "$out/librdc_nativecloak.so" \
    "$ROOT/src/main.cpp" \
    -llog -ldl \
    -Wl,--exclude-libs,ALL
  echo "    -> $out/librdc_nativecloak.so"
}

build_abi x86_64 x86_64-linux-android
build_abi arm64-v8a aarch64-linux-android

# --- package the Magisk module zip ------------------------------------------
echo "==> packaging module zip"
mkdir -p "$STAGING/META-INF/com/google/android" "$STAGING/zygisk"
cp -r "$ROOT/module/." "$STAGING/"
# Zygisk expects the native libraries named by ABI under zygisk/.
cp "$ROOT/dist/x86_64/librdc_nativecloak.so" "$STAGING/zygisk/x86_64.so"
cp "$ROOT/dist/arm64-v8a/librdc_nativecloak.so" "$STAGING/zygisk/arm64-v8a.so"

(cd "$STAGING" && zip -qr "$ROOT/dist/RDC-NativeCloak.zip" .)

echo "==> done:"
ls -l "$ROOT/dist"
