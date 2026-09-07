#!/usr/bin/env bash
# Detect OS + CPU arch for binder / Redroid install strategy.
# Usage:
#   bash detect-platform.sh
#   bash detect-platform.sh --key-only
set -euo pipefail

KEY_ONLY=0
QUIET=0
for a in "$@"; do
  case "$a" in
    --key-only|-k) KEY_ONLY=1 ;;
    --quiet|-q) QUIET=1 ;;
  esac
done

uname_s="$(uname -s 2>/dev/null || echo unknown)"
uname_m="$(uname -m 2>/dev/null || echo unknown)"

case "$uname_s" in
  Linux*)  OS=linux ;;
  Darwin*) OS=darwin ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) OS=unknown ;;
esac

case "$uname_m" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l|arm) ARCH=armv7 ;;
  riscv64) ARCH=riscv64 ;;
  *) ARCH="$(echo "$uname_m" | tr '[:upper:]' '[:lower:]')" ;;
esac

PLATFORM="${OS}-${ARCH}"
SUPPORTED=false
NEEDS_WSL_KERNEL=false
STRATEGY=unsupported
ASSET_BZ=null
ASSET_CFG=null

case "$PLATFORM" in
  windows-x64)
    SUPPORTED=true; NEEDS_WSL_KERNEL=true; STRATEGY=wsl-prebuilt-or-build
    ASSET_BZ='"wsl-kernel-binder-windows-x64-bzImage"'
    ASSET_CFG='"wsl-kernel-binder-windows-x64-config"'
    ;;
  windows-arm64)
    SUPPORTED=true; NEEDS_WSL_KERNEL=true; STRATEGY=wsl-prebuilt-or-build
    ASSET_BZ='"wsl-kernel-binder-windows-arm64-bzImage"'
    ASSET_CFG='"wsl-kernel-binder-windows-arm64-config"'
    ;;
  linux-x64|linux-arm64)
    SUPPORTED=true; NEEDS_WSL_KERNEL=false; STRATEGY=host-binder
    ;;
  darwin-*)
    SUPPORTED=false; STRATEGY=unsupported
    ;;
esac

if [[ "$KEY_ONLY" -eq 1 ]]; then
  echo "$PLATFORM"
  exit 0
fi

if [[ "$QUIET" -eq 0 ]]; then
  echo "platform=$PLATFORM os=$OS arch=$ARCH strategy=$STRATEGY supported=$SUPPORTED" >&2
fi

cat <<EOF
{"platform":"$PLATFORM","os":"$OS","arch":"$ARCH","supported":$SUPPORTED,"needsWslKernel":$NEEDS_WSL_KERNEL,"strategy":"$STRATEGY","releaseAssetBzImage":$ASSET_BZ,"releaseAssetConfig":$ASSET_CFG,"unameS":"$uname_s","unameM":"$uname_m"}
EOF
