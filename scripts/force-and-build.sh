#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}/wsl2-linux-kernel"

force_y() {
  local k="$1"
  if grep -qE "^(# ${k} is not set|${k}=[mn])$" .config; then
    sed -i "s/^# ${k} is not set$/${k}=y/" .config
    sed -i "s/^${k}=[mn]$/${k}=y/" .config
  elif ! grep -q "^${k}=" .config; then
    echo "${k}=y" >> .config
  fi
}

# Docker Desktop needs these built-in on custom WSL kernels
OPTS=(
  CONFIG_NETFILTER_XTABLES
  CONFIG_NETFILTER_XTABLES_LEGACY
  CONFIG_IP_NF_IPTABLES
  CONFIG_IP_NF_IPTABLES_LEGACY
  CONFIG_IP_NF_FILTER
  CONFIG_NF_REJECT_IPV4
  CONFIG_IP_NF_TARGET_REJECT
  CONFIG_IP_NF_NAT
  CONFIG_IP_NF_MANGLE
  CONFIG_IP_NF_TARGET_MASQUERADE
  CONFIG_IP_NF_TARGET_REDIRECT
  CONFIG_IP6_NF_IPTABLES
  CONFIG_IP6_NF_IPTABLES_LEGACY
  CONFIG_IP6_NF_FILTER
  CONFIG_NF_REJECT_IPV6
  CONFIG_IP6_NF_TARGET_REJECT
  CONFIG_NFT_COMPAT
  CONFIG_NFT_REJECT
  CONFIG_NFT_REJECT_INET
  CONFIG_NFT_REJECT_IPV4
  CONFIG_NFT_REJECT_IPV6
  CONFIG_NETFILTER_XT_TARGET_REDIRECT
  CONFIG_NETFILTER_XT_MATCH_ADDRTYPE
  CONFIG_NETFILTER_XT_MATCH_CONNTRACK
  # docker bridge network
  CONFIG_BRIDGE
  CONFIG_BRIDGE_NETFILTER
  CONFIG_NETFILTER_ADVANCED
  CONFIG_TUN
  CONFIG_ISO9660_FS
  CONFIG_VETH
  CONFIG_IP_NF_TARGET_MASQUERADE
  CONFIG_IP6_NF_TARGET_MASQUERADE
  CONFIG_NETFILTER_XT_TARGET_MASQUERADE
  CONFIG_NETFILTER_XT_MATCH_IPVS
  CONFIG_IP_VS
  CONFIG_VXLAN
  CONFIG_DUMMY
)

for k in "${OPTS[@]}"; do
  force_y "$k"
done

echo "==> Before sync:"
grep -E 'CONFIG_BRIDGE_NETFILTER=|CONFIG_BRIDGE=|CONFIG_IP_NF_TARGET_REJECT=' .config

make syncconfig

echo "==> After sync:"
grep -E 'CONFIG_BRIDGE_NETFILTER=|CONFIG_BRIDGE=|CONFIG_IP_NF_TARGET_REJECT=|CONFIG_IP_NF_FILTER=' .config

if ! grep -q '^CONFIG_BRIDGE_NETFILTER=y$' .config; then
  echo "ERROR: BRIDGE_NETFILTER not y"
  # show deps
  grep -A20 'config BRIDGE_NETFILTER' net/bridge/netfilter/Kconfig || true
  grep BRIDGE .config | head -20
  exit 1
fi

echo "==> Building bzImage..."
make -j"$(nproc)" bzImage

cp -f arch/x86/boot/bzImage /mnt/c/wsl-kernel/bzImage
cp -f .config /mnt/c/wsl-kernel/config-wsl-binder
ls -la /mnt/c/wsl-kernel/bzImage
grep -E 'CONFIG_BRIDGE_NETFILTER=|CONFIG_IP_NF_TARGET_REJECT=|CONFIG_TUN=|CONFIG_ISO9660_FS=' /mnt/c/wsl-kernel/config-wsl-binder
echo DONE
