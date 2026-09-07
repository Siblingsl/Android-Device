#!/usr/bin/env bash
# Run AFTER switching to binder-enabled WSL kernel and wsl --shutdown.
set -euo pipefail

echo "==> Kernel: $(uname -r)"
echo "==> Binder config:"
zcat /proc/config.gz 2>/dev/null | grep -E 'CONFIG_ANDROID|BINDER' || echo "(no /proc/config.gz)"

echo "==> Devices:"
ls -la /dev/binder* 2>/dev/null || true
ls -la /dev/binderfs 2>/dev/null || true

if ! grep -q binder /proc/filesystems 2>/dev/null; then
  echo "WARN: binder filesystem not listed in /proc/filesystems"
else
  echo "binderfs available in /proc/filesystems"
fi

# Mount binderfs if needed
if [[ ! -e /dev/binder ]]; then
  sudo mkdir -p /dev/binderfs
  if ! mountpoint -q /dev/binderfs 2>/dev/null; then
    sudo mount -t binder binder /dev/binderfs || true
  fi
  # Some setups expose binder under binderfs
  ls -la /dev/binderfs 2>/dev/null || true
fi

echo "==> Recreate Redroid (Docker Desktop / docker CLI)..."
docker rm -f rdc-redroid-1 2>/dev/null || true
docker run -d --privileged \
  --name rdc-redroid-1 \
  -v "$HOME/redroid-data:/data" \
  -p 5555:5555 \
  redroid/redroid:11.0.0-latest \
  androidboot.redroid_width=1080 \
  androidboot.redroid_height=1920 \
  androidboot.redroid_dpi=320 \
  androidboot.redroid_gpu_mode=guest \
  androidboot.use_memfd=1

echo "==> Wait for boot..."
sleep 15
docker ps --filter name=rdc-redroid-1
echo "==> Container processes (sample):"
docker exec rdc-redroid-1 ps -A 2>/dev/null | head -30 || echo "exec failed — adbd may still be starting"
echo
echo "From Windows:"
echo "  adb disconnect 127.0.0.1:5555"
echo "  adb connect 127.0.0.1:5555"
echo "  adb devices"
echo "  scrcpy -s 127.0.0.1:5555"
