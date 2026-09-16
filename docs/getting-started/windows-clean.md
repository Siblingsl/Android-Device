# Windows x64 干净机器安装

本文面向第一次使用 Redroid Device Center 的用户。目标是从一台没有 Node.js、Rust、Docker、ADB 或 QEMU 开发环境的 Windows x64 机器，完成安装并连接第一台 Android 设备。

## 适用范围

- 首个公开 Beta 目标：Windows x64。
- Docker 和 QEMU/WHPX 是两条不同的运行轨道，可以先只验证其中一条。
- Windows ARM64 与 macOS 目前属于实验性范围，不作为本文的成功标准。

## 开始前准备

1. 使用 Windows x64，并确认硬件虚拟化已在 BIOS/UEFI 中开启。
2. 为运行时预留足够内存和磁盘空间；QEMU 轨道至少需要 40 GiB 可用磁盘空间。
3. 准备稳定网络。首次准备 Docker 镜像、QEMU 和 Ubuntu cloud image 可能需要较长时间。
4. 准备管理员权限。启用 WHPX 或修改 WSL 内核时会出现 Windows 权限确认，部分操作需要重启。
5. 从 Release 下载 Windows 安装包，并先阅读该版本的签名状态、校验和和已知问题。

Node.js 和 Rust 只在从源码开发或构建时需要；普通用户使用安装包不需要安装它们。

## 安装与首次启动

1. 运行 Windows 安装包，记录安装路径和 Windows 安全提示。
2. 启动 **Just Run / Redroid Device Center**。
3. 先打开 Dashboard 的环境准备清单，逐项处理“需要处理”的项目。
4. 不要先勾选 GApps 或 Root。先使用无 GApps 的基础 Redroid 验证环境和 ADB 连接。
5. 选择一条轨道继续：
   - [Docker 轨道](docker-track.md)
   - [QEMU/WHPX 轨道](qemu-whpx-track.md)
6. 创建设备后，在设备中心看到设备在线，并能执行一次基本操作，才算完成首台设备路径。

## 如何判断安装成功

- 应用可以正常打开，环境清单中的相关依赖显示为“可用”。
- 创建的 Android 实例完成启动，ADB 状态为 `device`，而不是 `offline` 或 `unauthorized`。
- 设备详情可以显示 Android 版本，并能执行截图或基本控制。
- 重新关闭并打开应用后，设备和数据状态仍符合 Release Notes 的说明。

## 重新安装与卸载

- 卸载客户端前，先停止运行中的 Docker 容器和 QEMU 节点。
- Docker 删除容器不会自动删除对应数据卷；需要清除 Android 数据时，单独在 Volumes 页面删除数据卷。
- QEMU 节点的磁盘、密钥、镜像和日志位于其 state 目录；删除节点前先确认是否需要保留数据或快照。
- 重新安装前保留问题所需的日志和版本信息，不要先清空整个 state 目录。

## 安装失败时要保存什么

记录以下信息后，再到[故障排查](../troubleshooting.md)查找对应症状：

- 应用版本和安装包文件名。
- Windows 版本/build、CPU 架构和可用磁盘空间。
- 使用的运行轨道。
- 环境准备清单或 QEMU doctor 的结果。
- 失败发生的页面、按钮和完整提示文本。
- 相关截图；QEMU 轨道额外保存 `qemu.log` 和 `console.log`。

## 从源码运行

只有贡献者或开发者需要执行：

```powershell
npm install
npm run tauri dev
```

浏览器预览 `npm run dev` 只用于查看前端页面，不提供 Docker、ADB 或 QEMU 后端。
