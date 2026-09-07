#!/usr/bin/env bash
# Rebuild custom WSL kernel with Docker Desktop-required options built-in.
# Required built-in (not modules):
#   ISO9660, TUN, iptables REJECT/FILTER/NAT, etc.
set -euo pipefail

KERNEL_DIR="${HOME}/wsl2-linux-kernel"
OUT_WIN_DIR="/mnt/c/wsl-kernel"
JOBS="$(nproc)"

cd "${KERNEL_DIR}"

# Docker Desktop / Redroid critical options
OPTS=(
  CONFIG_ISO9660_FS
  CONFIG_TUN
  CONFIG_VETH
  CONFIG_BRIDGE
  CONFIG_IP_NF_IPTABLES
  CONFIG_IP_NF_FILTER
  CONFIG_IP_NF_NAT
  CONFIG_IP_NF_MANGLE
  CONFIG_IP_NF_TARGET_REJECT
  CONFIG_IP_NF_TARGET_MASQUERADE
  CONFIG_IP6_NF_IPTABLES
  CONFIG_IP6_NF_FILTER
  CONFIG_IP6_NF_TARGET_REJECT
  CONFIG_NETFILTER_XT_TARGET_REDIRECT
  CONFIG_NETFILTER_XT_MATCH_ADDRTYPE
  CONFIG_NETFILTER_XT_MATCH_CONNTRACK
  CONFIG_NF_CONNTRACK
  CONFIG_NF_NAT
  CONFIG_ANDROID
  CONFIG_ANDROID_BINDER_IPC
  CONFIG_ANDROID_BINDERFS
)

if [[ -x scripts/config ]]; then
  for k in "${OPTS[@]}"; do
    scripts/config --enable "$k" || true
  done
fi

for k in "${OPTS[@]}"; do
  sed -i "s/^${k}=m$/${k}=y/" .config || true
  sed -i "s/# ${k} is not set/${k}=y/" .config || true
done

make olddefconfig

for k in "${OPTS[@]}"; do
  sed -i "s/^${k}=m$/${k}=y/" .config || true
done

echo "==> Config check:"
grep -E '^(CONFIG_TUN|CONFIG_ISO9660_FS|CONFIG_IP_NF_TARGET_REJECT|CONFIG_IP_NF_IPTABLES|CONFIG_IP_NF_FILTER|CONFIG_IP_NF_NAT|CONFIG_ANDROID_BINDER)=' .config || true

echo "==> Building (jobs=${JOBS})..."
make -j"${JOBS}"

mkdir -p "${OUT_WIN_DIR}"
cp -f arch/x86/boot/bzImage "${OUT_WIN_DIR}/bzImage"
cp -f .config "${OUT_WIN_DIR}/config-wsl-binder"

echo "=============================================="
echo "Kernel rebuilt:"
ls -la "${OUT_WIN_DIR}/bzImage"
grep -E '^(CONFIG_TUN|CONFIG_ISO9660_FS|CONFIG_IP_NF_TARGET_REJECT|CONFIG_IP_NF_IPTABLES|CONFIG_IP_NF_FILTER)=' "${OUT_WIN_DIR}/config-wsl-binder"
echo "Next: wsl --shutdown, then start Docker Desktop"
echo "=============================================="
