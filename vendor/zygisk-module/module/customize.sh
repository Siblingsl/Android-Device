# RDC NativeCloak — Magisk module install script
SKIPUNZIP=0

ui_print "- RDC NativeCloak（原生痕迹清理）"

# --- Why x86_64 ships as the primary ABI -----------------------------------
# Redroid containers run x86_64 Android images (androidboot on x86_64 hosts /
# WSL2 + Docker). The zygote inside those containers is x86_64, so the module
# .so that gets dlopen-ed must be x86_64. arm64-v8a is additionally shipped
# for physical-device testing of the same hooks.
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "arm64-v8a" ]; then
  abort "! 不支持的平台架构: $ARCH（仅支持 x86_64 / arm64-v8a）"
fi

ui_print "- 安装 $ARCH 原生库"

# --- Sanitized /proc cache dir ---------------------------------------------
# The module rewrites /proc snapshots on first read per process and caches
# them here. /data/local/tmp is where the desktop app also pushes
# rdc-cloak.json (config shared with DeviceCloak).
mkdir -p /data/local/tmp/rdc-cloak 2>/dev/null
chmod 0777 /data/local/tmp/rdc-cloak 2>/dev/null

set_perm_recursive "$MODPATH" 0 0 0755 0644

ui_print "- 完成。重启设备/容器后生效。"
ui_print "- 与 DeviceCloak（LSPosed 模块）配合使用："
ui_print "  Java 层管框架 API，native 层管 PLT 直调。"
