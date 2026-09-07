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

# --- enable Zygisk + denylist enforce ---
"$MAGISK" --sqlite "REPLACE INTO settings (key,value) VALUES('zygisk',1)" \
  || echo "[preset] WARN: zygisk sqlite failed (daemon not up?)"
"$MAGISK" --sqlite "REPLACE INTO settings (key,value) VALUES('denylist',1)" \
  || echo "[preset] WARN: denylist sqlite failed"
"$MAGISK" --denylist enable >/dev/null 2>&1 || echo "[preset] WARN: denylist enable failed"

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
if [ -d /data/adb/modules/shamiko ] || [ -d /data/adb/modules_update/shamiko ]; then
  mkdir -p /data/adb/shamiko
  touch /data/adb/shamiko/whitelist
  echo "[preset] shamiko whitelist mode enabled"
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
if [ ! -e /data/adb/.rdc_apk_installed ]; then
  pm install -r "$M/magisk.apk" >> "$LOG" 2>&1 \
    && echo "[preset] magisk apk installed" \
    || echo "[preset] WARN: magisk apk install failed"
  touch /data/adb/.rdc_apk_installed
fi

# --- spoof applier for this and future boots ---
cp -f "$M/rdc_apply_spoof.sh" /data/adb/service.d/rdc_apply_spoof.sh 2>/dev/null \
  || { mkdir -p /data/adb/service.d && cp -f "$M/rdc_apply_spoof.sh" /data/adb/service.d/rdc_apply_spoof.sh; }
chmod 755 /data/adb/service.d/rdc_apply_spoof.sh 2>/dev/null
sh /data/adb/service.d/rdc_apply_spoof.sh

touch "$DONE"
echo "[preset] ===== end $(date) ====="
