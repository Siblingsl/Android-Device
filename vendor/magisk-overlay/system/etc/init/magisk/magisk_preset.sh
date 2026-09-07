#!/system/bin/sh
# Magisk first-boot preset (Redroid Device Center).
# Runs once per boot at sys.boot_completed=1; all steps are idempotent.
M=/system/etc/init/magisk
LOG=/data/adb/rdc_preset.log
DONE=/data/adb/.rdc_preset_done

mkdir -p /data/adb
rm -rf /data/adb/rdc_mod_stage
rm -f "$DONE"
exec >> "$LOG" 2>&1
echo "[preset] ===== begin $(date) ====="

MAGISK=/sbin/magisk
[ -x "$MAGISK" ] || MAGISK="$M/magisk"
# This fork's client commands (-v/-V) go through the daemon; wait for
# --setup-sbin to finish by polling /sbin/magisk instead.
i=0
while [ ! -x /sbin/magisk ] && [ "$i" -lt 30 ]; do sleep 2; i=$((i + 1)); done
echo "[preset] using magisk binary: $MAGISK (/sbin ready: $([ -x /sbin/magisk ] && echo yes || echo no), waited ${i}x2s)"
echo "[preset] daemon: $($MAGISK -v 2>&1 | head -n 1)"

# --- disable install-time verification BEFORE any pm install ---
# Headless containers can never respond to a Finsky verify session: installs
# either wedge forever or get silently rolled back. Must run before the
# manager apk install below.
settings put global package_verifier_enable 0 2>/dev/null
settings put global verifier_verify_adb_installs 0 2>/dev/null
settings put global verifier_verify_adb_installs_coefficient 0 2>/dev/null

# --- enable Zygisk + denylist enforce ---
"$MAGISK" --sqlite "REPLACE INTO settings (key,value) VALUES('zygisk',1)" \
  || echo "[preset] WARN: zygisk sqlite failed (daemon not up?)"
"$MAGISK" --sqlite "REPLACE INTO settings (key,value) VALUES('denylist',1)" \
  || echo "[preset] WARN: denylist sqlite failed"
"$MAGISK" --denylist enable >/dev/null 2>&1 || echo "[preset] WARN: denylist enable failed"

# --- adb shell (uid 2000) 默认授予 su（policy: 0=QUERY 1=DENY 2=ALLOW）---
# 红队自动化依赖 adb shell su 无交互提权；没有这条，首个 su 请求会弹管理器确认
# （容器场景无人点击）或被残留的 DENY 策略挡住。
"$MAGISK" --sqlite "REPLACE INTO policies (uid,policy,until,logging,notification) VALUES (2000,2,0,0,0)" \
  || echo "[preset] WARN: shell su policy failed"

# --- populate /data/adb/magisk (module install env_check expects binaries here) ---
MB=/data/adb/magisk
mkdir -p "$MB"
for b in magisk magiskpolicy busybox magiskboot util_functions.sh; do
  [ -f "$MB/$b" ] || cp -f "$M/$b" "$MB/$b" 2>/dev/null
done
chmod 755 "$MB"/* 2>/dev/null
echo "[preset] /data/adb/magisk populated: $(ls "$MB" 2>/dev/null | tr '
' ' ')"

# --- install bundled modules once ---
mkdir -p /data/adb/modules
BB="$M/busybox"
[ -x "$BB" ] || BB=busybox
for z in "$M"/modules/*.zip; do
  [ -e "$z" ] || continue
  mid=$("$BB" unzip -p "$z" module.prop 2>/dev/null | sed -n 's/^id=//p' | head -n 1)
  if [ -z "$mid" ]; then
    echo "[preset] WARN: cannot read module id from $z, skip"
    continue
  fi
  if [ -d "/data/adb/modules/$mid" ]; then
    echo "[preset] module $mid already installed, skip"
    continue
  fi
  echo "[preset] installing module $mid from $z"
  if "$MAGISK" --install-module "$z" >> "$LOG" 2>&1; then
    echo "[preset] module $mid installed via --install-module"
  else
    echo "[preset] --install-module failed for $mid, trying util_functions fallback"
    "$BB" rm -rf /data/adb/rdc_mod_stage
    "$BB" mkdir -p /data/adb/rdc_mod_stage
    "$BB" unzip -oq "$z" -d /data/adb/rdc_mod_stage || { echo "[preset] fallback unzip failed"; continue; }
    # Replicate the Magisk app install path: source util_functions and run install_module
    (
      cd /data/adb/rdc_mod_stage || exit 1
      export MAGISKBIN="$MB"
      export ZIPFILE="$z"
      export MAGISK_VER="$("$MAGISK" -V 2>/dev/null)"
      export MAGISK_VER_CODE="$("$MAGISK" -V 2>/dev/null)"
      export BOOTMODE=true
      export MAGISK_TMPDIR=/sbin/.magisk
      [ -f "$MB/util_functions.sh" ] && . "$MB/util_functions.sh"
      install_module 2>&1 || echo "[preset] fallback install_module failed for $mid"
    )
  fi
done

# --- Shamiko whitelist mode (only whitelisted packages see root) ---
# The module id is zygisk_shamiko in this fork's zip; checking only
# modules/shamiko silently disabled whitelist mode.
if [ -d /data/adb/modules/zygisk_shamiko ] || [ -d /data/adb/modules/shamiko ] \
   || [ -d /data/adb/modules_update/zygisk_shamiko ] || [ -d /data/adb/modules_update/shamiko ]; then
  mkdir -p /data/adb/shamiko
  touch /data/adb/shamiko/whitelist
  echo "[preset] shamiko whitelist mode enabled"
fi

# --- LSPosed manager (surface the module's embedded manager as a real app) ---
# lspd runs headless; without a manager package the only UI is a hidden
# status notification. Same-signature manager.apk is accepted by the daemon.
LSP_APK=/data/adb/modules/zygisk_lsposed/manager.apk
if [ -f "$LSP_APK" ] && ! pm list packages 2>/dev/null | grep -q '^package:org.lsposed.manager$'; then
  pm install -r "$LSP_APK" >> "$LOG" 2>&1 \
    && echo "[preset] lsposed manager installed" \
    || echo "[preset] WARN: lsposed manager install failed (will retry next boot)"
fi

# --- denylist target packages (written by client via docker exec) ---
if [ -f /data/adb/rdc_target_packages.txt ]; then
  while IFS= read -r pkg; do
    pkg=$(echo "$pkg" | tr -d ' \r')
    [ -z "$pkg" ] && continue
    "$MAGISK" --denylist add "$pkg" >/dev/null 2>&1 \
      && echo "[preset] denylist add $pkg" \
      || echo "[preset] WARN denylist add failed: $pkg"
  done < /data/adb/rdc_target_packages.txt
fi

# --- Magisk manager app ---
# Retry on every boot until the package is actually present. The old
# .rdc_apk_installed marker was written regardless of install result, so one
# verifier-rolled-back install permanently disabled the manager — the app
# never appeared in the launcher.
# Also stage the apk at /data/adb/magisk.apk (magiskd's canonical copy) and
# ship a same-cert stub.apk into the --setup-sbin source dir: the daemon's
# check-signature build derives its trusted cert from /sbin/stub.apk, and
# uninstalls any manager whose cert doesn't match.
rm -f /data/adb/.rdc_apk_installed
cp -f "$M/magisk.apk" /data/adb/magisk.apk 2>/dev/null
if pm list packages 2>/dev/null | grep -q '^package:com.topjohnwu.magisk$'; then
  echo "[preset] magisk apk present"
else
  pm install -r "$M/magisk.apk" >> "$LOG" 2>&1 \
    && echo "[preset] magisk apk installed" \
    || echo "[preset] WARN: magisk apk install failed (will retry next boot)"
  if pm list packages 2>/dev/null | grep -q '^package:com.topjohnwu.magisk$'; then
    echo "[preset] magisk apk verified"
  else
    echo "[preset] WARN: magisk apk missing after install attempt"
  fi
fi

# --- spoof applier for this and future boots ---
cp -f "$M/rdc_apply_spoof.sh" /data/adb/service.d/rdc_apply_spoof.sh 2>/dev/null \
  || { mkdir -p /data/adb/service.d && cp -f "$M/rdc_apply_spoof.sh" /data/adb/service.d/rdc_apply_spoof.sh; }
chmod 755 /data/adb/service.d/rdc_apply_spoof.sh 2>/dev/null
sh /data/adb/service.d/rdc_apply_spoof.sh

touch "$DONE"
echo "[preset] ===== end $(date) ====="
