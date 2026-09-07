# Magisk / LSPosed / Shamiko 下载产物（不进 Git）

由 `scripts/fetch-magisk.ps1` 生成，构建 `rdc-preset:*` 镜像时后端从这里读取：

```
magisk.apk                    # Magisk fork APK（ayasa520 redroid 兼容系）——已重签
magisk/
  magisk / magiskpolicy / magiskboot / busybox   # 从 APK lib/<abi> 解出
  util_functions.sh
  magisk.apk                  # 重签后的管理器 APK（烤入镜像 /system/etc/init/magisk/）
  stub.apk                    # 与 magisk.apk 同证书（--setup-sbin 拷入 /sbin 作信任锚）
rdc-resign.keystore           # 本地重签密钥（PKCS12, pass: rdc-redroid）
SignApk.java / apksig.jar     # v2 重签工具（apksig 库）
modules/
  lsposed-*.zip               # LSPosed (Zygisk)
  shamiko-*.zip               # Shamiko
```

overlay 源文件（rc/脚本/spoof.conf）在 `vendor/magisk-overlay/`（进 Git）。

## 为什么必须重签（重要）

magiskd 的 release 构建开启 `check-signature`：守护进程在 post-fs-data 阶段从
`/sbin/stub.apk` 提取受信证书（`preserve_stub_apk`），之后**任何**签名不符的
`com.topjohnwu.magisk` 管理器都会在安装后一分钟内被守护进程静默卸载
（logcat：`pkg: APK signature mismatch` → `pm_uninstall`）。

本 fork（ayasa520/Magisk direct-system-install）没有随 release 发布 stub.apk，
其 CI 密钥签名的 release APK 与我们镜像里的守护进程无法构成信任对。因此：
用本地 `rdc-resign.keystore` 把管理器 APK 做 v2 重签，并把**同一份 APK 作为
stub.apk** 放进 `--setup-sbin` 的源目录（rc 中即 `/system/etc/init/magisk`）。
开机后守护进程自动从 stub 安装管理器（install_stub），签名校验通过，
App 长期存活。第三方 v30.6/v30.7 release 的 APK md5 相同（同一产物），均已实测被卸载。
