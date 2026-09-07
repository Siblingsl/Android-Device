#!/system/bin/sh
# Apply device spoofing props (Redroid Device Center).
# Runs from /data/adb/service.d on every boot (needs magiskd up, uses resetprop).
# Config format (one action per line, '|' separated, '#' comments):
#   set|<prop>|<value>
#   del|<prop>
# Keys ro.product.* and ro.build.fingerprint / ro.build.description are
# automatically expanded to all per-partition variants.
M=/system/etc/init/magisk
RP=/sbin/resetprop
if [ ! -x "$RP" ]; then
  ln -sf "$M/magisk" /data/local/tmp/.rdc_resetprop 2>/dev/null
  RP=/data/local/tmp/.rdc_resetprop
fi
[ -x "$RP" ] || exit 0

CONF="${RDC_SPOOF_CONF:-$M/spoof.conf}"
[ -f "$CONF" ] || exit 0

log_tag="[spoof]"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  action=${line%%"|"*}
  rest=${line#*"|"}
  case "$action" in
    set)
      key=${rest%%"|"*}
      val=${rest#*"|"}
      [ "$val" = "$rest" ] && val=""
      case "$key" in
        ro.product.*)
          base=${key#ro.product.}
          $RP "$key" "$val"
          for p in vendor system product system_ext odm; do
            $RP "ro.product.$p.$base" "$val"
          done
          ;;
        ro.build.fingerprint)
          $RP "$key" "$val"
          for p in bootimage system vendor product system_ext odm; do
            $RP "ro.$p.build.fingerprint" "$val"
          done
          ;;
        ro.build.description)
          $RP "$key" "$val"
          for p in system vendor product system_ext odm; do
            $RP "ro.$p.build.description" "$val"
          done
          ;;
        *)
          $RP "$key" "$val"
          ;;
      esac
      echo "$log_tag set $key=$val"
      ;;
    del)
      $RP --delete "$rest" 2>/dev/null && echo "$log_tag del $rest"
      ;;
  esac
done < "$CONF"
exit 0
