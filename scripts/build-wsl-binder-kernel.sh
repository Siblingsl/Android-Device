#!/usr/bin/env bash
# =============================================================================
# One-shot WSL2 binder kernel for Redroid + Docker Desktop
#
# Consolidates all fixes discovered while making Docker Desktop work on a
# custom binder-enabled WSL kernel:
#
#   1. CONFIG_ANDROID_BINDER_IPC / BINDERFS  — Redroid requires binder
#   2. CONFIG_ISO9660_FS=y                  — Docker mounts cli-tools ISO
#   3. CONFIG_TUN=y                         — TAP AF_VSOCK networking
#   4. iptables LEGACY + FILTER + REJECT=y  — services namespace firewall
#   5. CONFIG_BRIDGE_NETFILTER=y            — bridge-nf-call-iptables sysctl
#   6. VETH / BRIDGE / NAT / MASQUERADE     — docker bridge network
#
# CRITICAL: Docker Desktop bootstrap runs in an isolated rootfs that cannot
# load external modules. Every option above must be built-in (=y), not =m.
#
# Usage (inside WSL Ubuntu):
#   bash build-wsl-binder-kernel.sh
#   bash build-wsl-binder-kernel.sh --skip-deps
#   bash build-wsl-binder-kernel.sh --jobs 8
#
# Output:
#   C:\wsl-kernel\bzImage
#   C:\wsl-kernel\config-wsl-binder
#
# Then on Windows:
#   powershell -File scripts\switch-wsl-kernel.ps1 -Mode custom
#   wsl --shutdown
# =============================================================================
set -euo pipefail

KERNEL_DIR="${KERNEL_DIR:-${HOME}/wsl2-linux-kernel}"
OUT_WIN_DIR="${OUT_WIN_DIR:-/mnt/c/wsl-kernel}"
JOBS="$(nproc)"
SKIP_DEPS=0
FORCE_CLONE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-deps) SKIP_DEPS=1; shift ;;
    --force-clone) FORCE_CLONE=1; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --kernel-dir) KERNEL_DIR="$2"; shift 2 ;;
    --out-dir) OUT_WIN_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---------- deps ----------
if [[ "$SKIP_DEPS" -eq 0 ]]; then
  log "Installing build dependencies..."
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    make gcc g++ flex bison libssl-dev libelf-dev dwarves bc python3 git pahole \
    build-essential libncurses-dev curl ca-certificates rsync
fi

# ---------- source ----------
log "Resolving WSL2 kernel source for $(uname -r)..."
TAGS="$(curl -fsSL 'https://api.github.com/repos/microsoft/WSL2-Linux-Kernel/git/refs/tags' \
  | grep -oE 'linux-msft-wsl-[0-9][^"]+' | sort -u || true)"

CURRENT="$(uname -r | sed 's/-microsoft-standard-WSL2//;s/+//')"
TAG=""
if echo "$TAGS" | grep -qx "linux-msft-wsl-${CURRENT}"; then
  TAG="linux-msft-wsl-${CURRENT}"
else
  # Prefer matching major.minor from running kernel, else latest 6.6 line
  MM="$(echo "$CURRENT" | cut -d. -f1-2)"
  TAG="$(echo "$TAGS" | grep "linux-msft-wsl-${MM}" | tail -1 || true)"
  if [[ -z "$TAG" ]]; then
    TAG="$(echo "$TAGS" | grep 'linux-msft-wsl-6\.' | tail -1 || true)"
  fi
fi
log "Selected tag: ${TAG:-<default branch>}"

if [[ "$FORCE_CLONE" -eq 1 && -d "$KERNEL_DIR" ]]; then
  log "Removing existing source (--force-clone)..."
  rm -rf "$KERNEL_DIR"
fi

if [[ ! -d "${KERNEL_DIR}/.git" ]]; then
  log "Cloning microsoft/WSL2-Linux-Kernel (shallow)..."
  rm -rf "${KERNEL_DIR}"
  if [[ -n "${TAG}" ]]; then
    git clone --depth 1 --branch "${TAG}" \
      https://github.com/microsoft/WSL2-Linux-Kernel.git "${KERNEL_DIR}"
  else
    git clone --depth 1 https://github.com/microsoft/WSL2-Linux-Kernel.git "${KERNEL_DIR}"
  fi
else
  log "Kernel source already present at ${KERNEL_DIR}"
fi

cd "${KERNEL_DIR}"

# ---------- base config ----------
if [[ -f Microsoft/config-wsl ]]; then
  cp Microsoft/config-wsl .config
elif [[ -f /proc/config.gz ]]; then
  zcat /proc/config.gz > .config
else
  die "No Microsoft/config-wsl and no /proc/config.gz"
fi

# ---------- force helpers ----------
# olddefconfig / syncconfig may drop options or flip =y → =m.
# Docker Desktop isolated rootfs cannot modprobe, so we re-force after each step.
force_y() {
  local k="$1"
  if grep -qE "^(# ${k} is not set|${k}=[mn])$" .config 2>/dev/null; then
    sed -i "s/^# ${k} is not set$/${k}=y/" .config
    sed -i "s/^${k}=[mn]$/${k}=y/" .config
  elif ! grep -q "^${k}=" .config 2>/dev/null; then
    echo "${k}=y" >> .config
  fi
  # scripts/config is more reliable when available
  if [[ -x scripts/config ]]; then
    scripts/config --enable "$k" 2>/dev/null || true
    scripts/config --module "$k" 2>/dev/null || true
    # re-force y if it became module
    sed -i "s/^${k}=m$/${k}=y/" .config 2>/dev/null || true
  fi
}

force_str() {
  local k="$1" v="$2"
  if [[ -x scripts/config ]]; then
    scripts/config --set-str "$k" "$v" 2>/dev/null || true
  fi
  sed -i "s|^${k}=.*|${k}=\"${v}\"|" .config 2>/dev/null || true
  grep -q "^${k}=" .config || echo "${k}=\"${v}\"" >> .config
}

# Full set of options required by Redroid + Docker Desktop on custom WSL kernels.
# Grouped by the failure that originally required them.
OPTS_BINDER=(
  CONFIG_ANDROID
  CONFIG_ANDROID_BINDER_IPC
  CONFIG_ANDROID_BINDERFS
  CONFIG_STAGING
  CONFIG_DMABUF_HEAPS
  CONFIG_DMABUF_HEAPS_SYSTEM
)

OPTS_DOCKER_FS=(
  CONFIG_ISO9660_FS   # unknown filesystem type 'iso9660'
  CONFIG_BLOCK
)

OPTS_DOCKER_NET=(
  CONFIG_TUN          # initializing TAP AF_VSOCK
  CONFIG_VETH
  CONFIG_BRIDGE
  CONFIG_BRIDGE_NETFILTER   # /proc/sys/net/bridge/bridge-nf-call-iptables
  CONFIG_NETFILTER_ADVANCED
  CONFIG_DUMMY
  CONFIG_VXLAN
  CONFIG_IP_VS
)

OPTS_IPTABLES=(
  # REJECT / FILTER need LEGACY on modern kernels used by Docker Desktop
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
  CONFIG_IP6_NF_TARGET_MASQUERADE
  CONFIG_NETFILTER_XT_TARGET_REDIRECT
  CONFIG_NETFILTER_XT_TARGET_MASQUERADE
  CONFIG_NETFILTER_XT_MATCH_ADDRTYPE
  CONFIG_NETFILTER_XT_MATCH_CONNTRACK
  CONFIG_NETFILTER_XT_MATCH_IPVS
  CONFIG_NFT_COMPAT
  CONFIG_NFT_REJECT
  CONFIG_NFT_REJECT_INET
  CONFIG_NFT_REJECT_IPV4
  CONFIG_NFT_REJECT_IPV6
)

OPTS_IPV6=(
  CONFIG_IPV6
  CONFIG_IPV6_ROUTER_PREF
  CONFIG_IPV6_ROUTE_INFO
  CONFIG_IPV6_MULTIPLE_TABLES
  CONFIG_IPV6_SUBTREES
)

ALL_OPTS=(
  "${OPTS_BINDER[@]}"
  "${OPTS_DOCKER_FS[@]}"
  "${OPTS_DOCKER_NET[@]}"
  "${OPTS_IPTABLES[@]}"
  "${OPTS_IPV6[@]}"
)

apply_all_opts() {
  log "Enabling binder + Docker Desktop built-ins..."
  for k in "${ALL_OPTS[@]}"; do
    force_y "$k"
  done
  force_str CONFIG_ANDROID_BINDER_DEVICES "binder,hwbinder,vndbinder"
  # ashmem is optional / may not exist on all trees
  force_y CONFIG_ASHMEM 2>/dev/null || true
  if [[ -x scripts/config ]]; then
    scripts/config --enable CONFIG_ASHMEM 2>/dev/null || true
  fi
}

verify_critical() {
  local missing=0
  local critical=(
    CONFIG_ANDROID_BINDER_IPC
    CONFIG_ANDROID_BINDERFS
    CONFIG_ISO9660_FS
    CONFIG_TUN
    CONFIG_BRIDGE
    CONFIG_BRIDGE_NETFILTER
    CONFIG_IP_NF_FILTER
    CONFIG_IP_NF_TARGET_REJECT
    CONFIG_IP_NF_IPTABLES_LEGACY
  )
  echo "---- critical config check ----"
  for k in "${critical[@]}"; do
    local line
    line="$(grep -E "^(${k}=|# ${k} is not set)" .config || true)"
    if echo "$line" | grep -q "^${k}=y$"; then
      echo "  OK  ${k}=y"
    else
      echo "  BAD ${k} => ${line:-(missing)}"
      missing=1
    fi
  done
  echo "-------------------------------"
  return $missing
}

# Pass 1: enable options
apply_all_opts
log "make olddefconfig..."
make olddefconfig

# Pass 2: olddefconfig often resets things — force again + syncconfig
apply_all_opts
log "make syncconfig..."
make syncconfig 2>/dev/null || make olddefconfig

# Pass 3: final force after sync
apply_all_opts

if ! verify_critical; then
  log "Re-forcing critical options and syncing once more..."
  apply_all_opts
  make syncconfig 2>/dev/null || true
  apply_all_opts
  if ! verify_critical; then
    die "Critical options still not =y after force. Inspect Kconfig deps."
  fi
fi

# ---------- build ----------
log "Building bzImage (jobs=${JOBS}) — typically 10–40 minutes..."
make -j"${JOBS}" bzImage

mkdir -p "${OUT_WIN_DIR}"
cp -f arch/x86/boot/bzImage "${OUT_WIN_DIR}/bzImage"
cp -f .config "${OUT_WIN_DIR}/config-wsl-binder"

# Optional modules pack (not required when features are built-in)
if make -j"${JOBS}" modules 2>/dev/null; then
  if make -j"${JOBS}" modules_install INSTALL_MOD_PATH="${OUT_WIN_DIR}/modules-root" 2>/dev/null; then
    tar -C "${OUT_WIN_DIR}/modules-root" -czf "${OUT_WIN_DIR}/modules.tar.gz" lib/modules || true
    rm -rf "${OUT_WIN_DIR}/modules-root"
  fi
fi

log "Verifying output config snapshot..."
grep -E 'CONFIG_ANDROID_BINDER_IPC=|CONFIG_ISO9660_FS=|CONFIG_TUN=|CONFIG_BRIDGE_NETFILTER=|CONFIG_IP_NF_TARGET_REJECT=|CONFIG_IP_NF_IPTABLES_LEGACY=' \
  "${OUT_WIN_DIR}/config-wsl-binder" || true
ls -la "${OUT_WIN_DIR}/bzImage"

cat <<EOF

==============================================
Kernel built successfully.

  Windows path : C:\\wsl-kernel\\bzImage
  Config dump  : C:\\wsl-kernel\\config-wsl-binder

Next steps (Windows PowerShell):

  1) Switch to custom kernel:
       powershell -ExecutionPolicy Bypass -File scripts\\switch-wsl-kernel.ps1 -Mode custom

  2) Restart WSL (closes all distros + Docker Desktop WSL backend):
       wsl --shutdown

  3) Start Docker Desktop, then verify:
       wsl -e bash -c "uname -r; zcat /proc/config.gz | grep -E 'BINDER|BRIDGE_NETFILTER|TUN=|ISO9660'"
       docker info
       docker ps

  4) Create Redroid from the app Docker page, or:
       bash scripts/after-wsl-binder-kernel.sh

To restore Microsoft default kernel later:
  powershell -ExecutionPolicy Bypass -File scripts\\switch-wsl-kernel.ps1 -Mode default
  wsl --shutdown
==============================================
EOF
