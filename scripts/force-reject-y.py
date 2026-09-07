#!/usr/bin/env python3
from pathlib import Path

p = Path.home() / "wsl2-linux-kernel" / ".config"
text = p.read_text().splitlines()
keys = [
    "CONFIG_IP_NF_IPTABLES",
    "CONFIG_IP_NF_FILTER",
    "CONFIG_IP_NF_NAT",
    "CONFIG_IP_NF_MANGLE",
    "CONFIG_IP_NF_TARGET_REJECT",
    "CONFIG_IP_NF_TARGET_MASQUERADE",
    "CONFIG_IP6_NF_IPTABLES",
    "CONFIG_IP6_NF_FILTER",
    "CONFIG_IP6_NF_NAT",
    "CONFIG_IP6_NF_MANGLE",
    "CONFIG_IP6_NF_TARGET_REJECT",
    "CONFIG_NF_REJECT_IPV4",
    "CONFIG_NF_REJECT_IPV6",
    "CONFIG_NETFILTER_XT_TARGET_REDIRECT",
    "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE",
    "CONFIG_NETFILTER_XT_MATCH_CONNTRACK",
    "CONFIG_NF_CONNTRACK",
    "CONFIG_NF_NAT",
    "CONFIG_TUN",
    "CONFIG_ISO9660_FS",
    "CONFIG_BRIDGE",
    "CONFIG_VETH",
]
out = []
seen = set()
for line in text:
    hit = False
    for k in keys:
        if line.startswith(k + "=") or line.startswith("# " + k + " is not set"):
            out.append(f"{k}=y")
            seen.add(k)
            hit = True
            break
    if not hit:
        out.append(line)
for k in keys:
    if k not in seen:
        out.append(f"{k}=y")
p.write_text("\n".join(out) + "\n")
print("After force:")
for line in p.read_text().splitlines():
    for k in keys:
        if line.startswith(k + "="):
            print(line)
