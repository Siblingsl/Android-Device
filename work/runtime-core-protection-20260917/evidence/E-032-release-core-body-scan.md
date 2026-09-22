# E-032 — release 二进制核心正文扫描

日期：2026-09-18

## 对象

`src-tauri/target/release/redroid-device-center.exe`

## 方法

对当前 release 主程序进行原始字符串扫描：

- `qemu_guest.py` 文件名和“发布版必须从授权服务取得 QEMU 核心脚本”提示可以存在，
  因为它们是运行时路径/错误信息，不等于脚本正文；
- 检查 runner 正文特征：`import argparse`、`from pathlib import Path`、`def main(`、
  `docker inspect`、`#!/usr/bin/env python3`。

同一组检查已固化为 `scripts/verify-release-core.ps1`，并接入
`.github/workflows/windows-release.yml`，以后 Windows NSIS 打包会在制品暂存前阻断违规构建。

## 结果

- 正文特征全部未命中；
- release 构建没有内置可离线执行的 `qemu_guest.py` 脚本正文；
- 客户端仍只有运行时下载、签名校验、加密分块和临时清理路径；
- 服务端私钥不在桌面 release 构建环境中。

脚本复验结果：

```text
clean: src-tauri\target\release\redroid-device-center.exe
clean: src-tauri\target\release\redroid_device_center_lib.dll
```

本扫描只证明当前构建产物不含 runner 正文，不能替代生产发布流水线的签名、制品哈希、
TLS、密钥托管和密钥轮换演练。
