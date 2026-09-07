#!/usr/bin/env bash
set -euo pipefail
echo "make processes:"
pgrep -a make || echo "(none)"
echo
echo "bzImage:"
ls -la /mnt/c/wsl-kernel/bzImage 2>/dev/null || true
ls -la "${HOME}/wsl2-linux-kernel/arch/x86/boot/bzImage" 2>/dev/null || true
echo
echo ".config:"
grep -E 'CONFIG_IP_NF_FILTER=|CONFIG_IP_NF_TARGET_REJECT=|CONFIG_NF_REJECT_IPV4=|CONFIG_IP_NF_IPTABLES=|CONFIG_TUN=|CONFIG_ISO9660_FS=' \
  "${HOME}/wsl2-linux-kernel/.config" || true
echo
echo "autoconf.h:"
grep -E 'CONFIG_IP_NF_TARGET_REJECT|CONFIG_NF_REJECT_IPV4|CONFIG_IP_NF_FILTER|CONFIG_TUN|CONFIG_ISO9660' \
  "${HOME}/wsl2-linux-kernel/include/generated/autoconf.h" 2>/dev/null | head -20 || true
