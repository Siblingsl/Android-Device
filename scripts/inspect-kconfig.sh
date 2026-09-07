#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}/wsl2-linux-kernel"
echo "=== IP_NF_FILTER ==="
grep -n -A25 'config IP_NF_FILTER' net/ipv4/netfilter/Kconfig || true
echo "=== IP_NF_TARGET_REJECT ==="
grep -n -A25 'config IP_NF_TARGET_REJECT' net/ipv4/netfilter/Kconfig || true
echo "=== IP_NF_IPTABLES ==="
grep -n -A20 'config IP_NF_IPTABLES' net/ipv4/netfilter/Kconfig || true
echo "=== auto.conf relevant ==="
grep -E 'CONFIG_IP_NF_|CONFIG_NF_REJECT|CONFIG_NETFILTER_XT_TARGET_REJECT' include/config/auto.conf 2>/dev/null | head -40 || true
echo "=== try force y and syncconfig ==="
for k in CONFIG_IP_NF_FILTER CONFIG_IP_NF_TARGET_REJECT CONFIG_IP_NF_IPTABLES CONFIG_NF_REJECT_IPV4; do
  sed -i "s/^# ${k} is not set$/${k}=y/" .config || true
  sed -i "s/^${k}=[mn]$/${k}=y/" .config || true
done
echo "before sync:"
grep -E 'CONFIG_IP_NF_FILTER=|CONFIG_IP_NF_TARGET_REJECT=' .config
make syncconfig
echo "after sync:"
grep -E 'CONFIG_IP_NF_FILTER=|CONFIG_IP_NF_TARGET_REJECT=' .config
grep -E 'CONFIG_IP_NF_FILTER=|CONFIG_IP_NF_TARGET_REJECT=' include/config/auto.conf
