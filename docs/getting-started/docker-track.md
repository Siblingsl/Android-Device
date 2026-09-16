# Docker 轨道

Docker 轨道适合希望直接在本机 Docker Desktop 中运行多个 Redroid 容器的用户。第一次建议先创建无 GApps 的基础实例，确认 binder、镜像和 ADB 都正常后，再添加预装能力。

## 需要准备的依赖

- Docker Desktop，并确认 Docker 引擎已启动。
- Windows + WSL2。
- Redroid 可用的 binder 内核。Windows 上通常使用项目提供的 WSL binder 内核资产或按脚本说明自行构建。
- ADB（Android platform-tools）。
- scrcpy（需要投屏时）。
- 与目标 Android 版本匹配的 Redroid 镜像。

Windows binder 内核的详细说明见 [`scripts/README-WSL-KERNEL.md`](../../scripts/README-WSL-KERNEL.md)。

## 第一次准备

1. 安装并启动 Docker Desktop。
2. 在应用 Dashboard 或 Docker 页面检查 Docker 引擎状态。
3. 在 Docker 页面检查 WSL/binder 状态；如果切换了自定义内核，重新打开 Docker Desktop。
4. 等环境检查显示可用后，选择一个已有的 Redroid 镜像，或按页面提示拉取镜像。
5. 在 ADB 页面确认 platform-tools 可用；在设置中确认 scrcpy 路径（需要投屏时）。

## 创建首台基础设备

1. 打开 **容器与节点 → Docker**。
2. 点击创建实例。
3. 先保留默认的 CPU、内存、分辨率和 DPI，避免一次引入额外变量。
4. 暂不勾选 GApps、Magisk 或其他预装。
5. 保留等待 ADB 的选项，创建后等待设备状态变为 `device`。
6. 进入设备详情，执行一次截图或基本控制。

如果容器状态是 Up 但 ADB 是 `offline`，不要反复删除重建；先查看[故障排查](../troubleshooting.md)中的 binder 和 ADB 条目。

## GApps 限制

当前仓库已有的 MindTheGapps 资产是 **Android 13、x86_64**。因此：

- Android 13 x86_64 镜像可以走 GApps 预装路径。
- Android 14 不能使用 Android 13 的 GApps zip；应用应在创建前明确拒绝。
- 没有匹配资产时，先创建无 GApps 基础设备，不要把下载失败当作 Docker 轨道失败。
- 从源码准备本地 GApps 资产时使用已有脚本；资产放在 `vendor/gapps/`，不要提交 Git。

```powershell
.\scripts\fetch-mindthegapps.ps1
```

## 数据与删除

- 删除容器不会删除 `rdc-*-data` 数据卷。
- 要清空 Android 数据，进入 Volumes 页面删除对应数据卷。
- 删除前确认没有需要保留的 APK、配置、登录状态或测试数据。

## Root 和高级预装

Magisk/Zygisk、LSPosed、Shamiko、DeviceCloak、设备档案和痕迹清理属于授权测试场景的高级能力。先确认基础设备稳定，再按 README 中的资产和版本说明启用。

Shamiko 在某些 Redroid 环境中可能自报不支持；这应记录为兼容性限制，不能只因为模块文件存在就判定完整功能通过。

## 关闭与恢复

退出应用前先停止不再使用的容器；保留数据时只停止或删除容器，不删除数据卷。升级或预装失败时，先保存日志和容器/卷状态，再根据页面提供的恢复动作处理。
