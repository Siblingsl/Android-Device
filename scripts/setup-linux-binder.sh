#!/usr/bin/env bash
# Linux host binder setup for Redroid (NO WSL bzImage).
# Supports: linux-x64, linux-arm64. Refuses macOS.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAT_JSON="$(bash "${DIR}/detect-platform.sh" --quiet)"
PLATFORM="$(echo "$PLAT_JSON" | sed -n 's/.*"platform":"\([^"]*\)".*/\1/p')"
STRATEGY="$(echo "$PLAT_JSON" | sed -n 's/.*"strategy":"\([^"]*\)".*/\1/p')"
OS="$(echo "$PLAT_JSON" | sed -n 's/.*"os":"\([^"]*\)".*/\1/p')"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

log "platform=$PLATFORM strategy=$STRATEGY"
log "kernel: $(uname -r) arch: $(uname -m)"

if [[ "$OS" == "darwin" ]]; then
  die "macOS is not supported. Use Windows (WSL) or Linux."
fi
if [[ "$OS" == "windows" ]]; then
  die "On Windows use: powershell -File scripts/install-wsl-kernel.ps1"
fi
if [[ "$STRATEGY" != "host-binder" ]]; then
  die "Unsupported platform $PLATFORM for Linux binder setup"
fi

echo "---- binder config ----"
if [[ -f /proc/config.gz ]]; then
  zcat /proc/config.gz | grep -E 'CONFIG_ANDROID|BINDER' || true
elif [[ -f "/boot/config-$(uname -r)" ]]; then
  grep -E 'CONFIG_ANDROID|BINDER' "/boot/config-$(uname -r)" || true
else
  echo "(no config.gz; will try modprobe)"
fi

echo "---- load modules (if not built-in) ----"
# Common module name on mainline / distro kernels
if ! grep -q binder /proc/filesystems 2>/dev/null; then
  if modinfo binder_linux &>/dev/null; then
    sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" || \
      sudo modprobe binder_linux || true
  else
    log "binder_linux module not found — host kernel may lack binder"
    log "Options: install distro binder package, or rebuild host kernel with:"
    log "  CONFIG_ANDROID_BINDER_IPC=y CONFIG_ANDROID_BINDERFS=y"
  fi
fi

if grep -q binder /proc/filesystems 2>/dev/null; then
  log "binder filesystem available"
else
  echo "WARN: binder still not in /proc/filesystems" >&2
fi

# Mount binderfs if needed
if [[ ! -e /dev/binder ]] && [[ ! -d /dev/binderfs ]]; then
  sudo mkdir -p /dev/binderfs
  if ! mountpoint -q /dev/binderfs 2>/dev/null; then
    sudo mount -t binder binder /dev/binderfs 2>/dev/null || true
  fi
fi

echo "---- devices ----"
ls -la /dev/binder* 2>/dev/null || true
ls -la /dev/binderfs 2>/dev/null || true

echo "---- docker ----"
if command -v docker &>/dev/null; then
  docker version --format 'Server: {{.Server.Version}}' 2>/dev/null || echo "Docker daemon not running"
else
  echo "docker CLI not found"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  PLATFORM_FLAG=linux/amd64 ;;
  aarch64) PLATFORM_FLAG=linux/arm64 ;;
  *)       PLATFORM_FLAG="" ;;
esac

cat <<EOF

==============================================
Linux binder check finished ($PLATFORM).

If binder is available, create Redroid e.g.:

  docker run -itd --privileged \\
    --name rdc-redroid-1 \\
    -v \$HOME/redroid-data:/data \\
    -p 5555:5555 \\
    ${PLATFORM_FLAG:+--platform $PLATFORM_FLAG }\\
    redroid/redroid:11.0.0-latest \\
    androidboot.redroid_width=1080 \\
    androidboot.redroid_height=1920 \\
    androidboot.redroid_dpi=320 \\
    androidboot.redroid_gpu_mode=guest \\
    androidboot.use_memfd=1

  adb connect 127.0.0.1:5555

Do NOT install Windows WSL bzImage on Linux.
==============================================
EOF
