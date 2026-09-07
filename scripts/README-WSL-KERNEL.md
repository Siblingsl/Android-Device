# Binder / WSL Kernel（Win + Linux，无 Mac）

## 平台矩阵

| platform key | 系统 | 架构 | 策略 | 预编译 bzImage |
|--------------|------|------|------|----------------|
| `windows-x64` | Windows | x64 / AMD64 | WSL 自定义内核 | ✅ `wsl-kernel-binder-windows-x64-bzImage` |
| `windows-arm64` | Windows | ARM64 | WSL 自定义内核 | ✅ 另编 `…-windows-arm64-…`（**不能**用 x64 包） |
| `linux-x64` | Linux | x86_64 | 主机 binder | ❌ 不需要 |
| `linux-arm64` | Linux | aarch64 | 主机 binder | ❌ 不需要 |
| 其它 / macOS | — | — | 不支持 | — |

检测本机：

```powershell
# Windows
.\scripts\detect-platform.ps1
.\scripts\detect-platform.ps1 -KeyOnly
```

```bash
# Linux
bash scripts/detect-platform.sh
bash scripts/detect-platform.sh --key-only
```

资源命名见 `scripts/platform-assets.json`。

---

## Windows：装预编译（推荐给别人）

1. 维护者发布 GitHub Release（约 17MB，**不要**传 `modules.tar.gz`）  
2. 用户本机：

```powershell
# 自动识别 windows-x64 / windows-arm64
powershell -ExecutionPolicy Bypass -File .\scripts\install-wsl-kernel.ps1 -Apply
```

查找顺序：`-LocalPath` → `vendor\wsl-kernel\` → `C:\wsl-kernel\` → GitHub Release（需配置 `platform-assets.json` 的 owner/repo）。

本地已有你编好的文件时：

```powershell
.\scripts\install-wsl-kernel.ps1 -Source local -LocalPath C:\wsl-kernel\bzImage -Apply
```

### 维护者：打包上传

```powershell
# 先在本机编好 C:\wsl-kernel\bzImage
.\scripts\publish-wsl-kernel-assets.ps1
# 产出 dist\wsl-kernel\wsl-kernel-binder-windows-x64-bzImage 等
# 编辑 platform-assets.json → github.owner / repo
# gh release create wsl-kernel-latest .\dist\wsl-kernel\*
```

### 没有预编译时：一键编译

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wsl-binder-oneclick.ps1 -Apply
```

### 仅切换

```powershell
.\scripts\switch-wsl-kernel.ps1 -Mode custom -Apply
.\scripts\switch-wsl-kernel.ps1 -Mode default -Apply
```

---

## Linux：主机 binder（不用 WSL 内核）

```bash
bash scripts/setup-linux-binder.sh
```

- **不要**把 Windows 的 `bzImage` 拷到 Linux  
- 有 `binder_linux` 模块则 `modprobe`；否则需发行版/自编内核开启 binder  
- Redroid 镜像架构需匹配（`linux/amd64` 或 `linux/arm64`）

---

## 历史踩坑（Windows 自编内核必须 `=y`）

| 现象 | 配置 |
|------|------|
| `unknown filesystem type 'iso9660'` | `CONFIG_ISO9660_FS=y` |
| `TAP AF_VSOCK` | `CONFIG_TUN=y` |
| `iptables REJECT missing module` | LEGACY + FILTER + REJECT `=y` |
| `bridge-nf-call-iptables` | `CONFIG_BRIDGE_NETFILTER=y` |
| Redroid 无 binder | `CONFIG_ANDROID_BINDER_IPC` + `BINDERFS` |

完整编译：`scripts/build-wsl-binder-kernel.sh`。

---

## 应用内

Docker 页 → **Binder / WSL 内核**（仅操作，不编译）：

- 显示 `platform` / 策略 / 是否已有 `bzImage`  
- Win：**切换自定义内核** / **恢复默认内核**  
- **检测 binder**  
- 编译与安装预编译请用本目录 CLI 脚本（维护者/首次部署）

---

## 参考

- https://github.com/remote-android/redroid-doc/blob/master/deploy/wsl.md  
