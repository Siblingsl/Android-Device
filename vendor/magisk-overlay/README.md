# vendor/magisk-overlay（进 Git）

Magisk 预装 overlay 源文件，构建 `rdc-preset:*` 派生镜像时由后端拷入
`/system/etc/init/`。

```
system/etc/init/magisk_preset.rc          # init 服务：post-fs-data / service / boot-complete / rdc_preset
system/etc/init/magisk/magisk_preset.sh   # 首启配置：Zygisk、模块安装、denylist、Shamiko 白名单
system/etc/init/magisk/rdc_apply_spoof.sh # 每次开机重放 spoof.conf（resetprop）
system/etc/init/magisk/spoof.conf         # 默认设备伪装 profile（按需修改）
```

镜像构建时另会注入（来自 `vendor/magisk/`，**不进 Git**，见 `scripts/fetch-magisk.ps1`）：

- `magisk`（v30 fork 单二进制；上游 v25-28 为 magisk64/32）`magiskpolicy` `magiskboot` `busybox` `magiskinit`（Magisk fork APK 的 native libs，COPY --chmod=755）
- `magisk.apk`、`util_functions.sh`
- `modules/lsposed-*.zip`、`modules/shamiko-*.zip`

机制参考：[ayasa520/redroid-script](https://github.com/ayasa520/redroid-script)、
[MagiskOnRedroid gist](https://gist.github.com/assiless/a23fb52e8c6156db0474ee8973c4be66)。
首启需要**一次容器重启**激活 Zygisk（由创建流程自动完成）。

排障：容器内 `adb shell tail -n 100 /data/adb/rdc_preset.log`。
