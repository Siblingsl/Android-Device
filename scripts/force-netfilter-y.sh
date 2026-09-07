#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}/wsl2-linux-kernel"

# Force critical netfilter built-in (must be y, not m)
python3 - <<'PY'
from pathlib import Path
p = Path(".config")
text = p.read_text()
keys = [
  "CONFIG_IP_NF_IPTABLES",
  "CONFIG_IP_NF_FILTER",
  "CONFIG_IP_NF_NAT",
  "CONFIG_IP_NF_MANGLE",
  "CONFIG_IP_NF_TARGET_REJECT",
  "CONFIG_IP_NF_TARGET_MASQUERADE",
  "CONFIG_IP6_NF_IPTABLES",
  "CONFIG_IP6_NF_FILTER",
  "CONFIG_IP6_NF_TARGET_REJECT",
  "CONFIG_IP6_NF_MANGLE",
  "CONFIG_IP6_NF_NAT",
  "CONFIG_NETFILTER_XT_TARGET_REDIRECT",
  "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE",
  "CONFIG_NETFILTER_XT_MATCH_CONNTRACK",
  "CONFIG_NF_CONNTRACK",
  "CONFIG_NF_NAT",
  "CONFIG_NF_REJECT_IPV4",
  "CONFIG_NF_REJECT_IPV6",
  "CONFIG_TUN",
  "CONFIG_ISO9660_FS",
  "CONFIG_BRIDGE",
  "CONFIG_VETH",
]
lines = text.splitlines()
found = set()
out = []
for line in lines:
    replaced = False
    for k in keys:
        if line.startswith(k + "=") or line.startswith("# " + k + " is not set"):
            out.append(f"{k}=y")
            found.add(k)
            replaced = True
            break
    if not replaced:
        out.append(line)
for k in keys:
    if k not in found:
        out.append(f"{k}=y")
p.write_text("\n".join(out) + "\n")
print("forced:")
for k in keys:
    for line in p.read_text().splitlines():
        if line.startswith(k + "="):
            print(" ", line)
            break
PY

# Do NOT run olddefconfig (it may flip some back to =m)
echo "==> Building..."
make -j"$(nproc)"
cp -f arch/x86/boot/bzImage /mnt/c/wsl-kernel/bzImage
cp -f .config /mnt/c/wsl-kernel/config-wsl-binder
echo "==> Verify:"
grep -E '^(CONFIG_IP_NF_TARGET_REJECT|CONFIG_IP_NF_FILTER|CONFIG_IP_NF_IPTABLES|CONFIG_TUN|CONFIG_ISO9660_FS)=' /mnt/c/wsl-kernel/config-wsl-binder
ls -la /mnt/c/wsl-kernel/bzImage
echo DONE
