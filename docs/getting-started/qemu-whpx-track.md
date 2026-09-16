# QEMU/WHPX 轨道

QEMU/WHPX 轨道把一台 Windows 主机上的 QEMU 虚机作为节点，节点内部运行 Docker 和多个 Redroid 实例。它适合需要独立 guest 内核边界、便携 QEMU 状态或希望把 Docker 运行时隔离到节点中的场景。

## 需要准备的依赖

- Windows x64，硬件虚拟化已开启。
- Windows Hypervisor Platform（WHPX）。这是 Windows 系统功能，不能放进应用安装目录。
- QEMU：可以由 QEMU 节点页面安装便携版本。
- OpenSSH 客户端：Windows 可选功能中的 `ssh.exe` 和 `ssh-keygen.exe`。
- ADB platform-tools。
- Ubuntu cloud image；首次下载通常约数百 MiB。
- 至少 40 GiB 可用磁盘空间，并为虚机内存留出余量。

## 第一次准备

1. 打开 **容器与节点 → QEMU**。
2. 运行环境体检，确认 WHPX、QEMU、SSH、ADB 和磁盘检查结果。
3. 点击“一键安装环境”或分别处理缺项。
4. 启用 WHPX 时确认 Windows UAC；启用完成后按提示重启 Windows。
5. 重启后回到 QEMU 页面，点击重新体检。
6. 下载 Ubuntu cloud image，等待校验完成。

WHPX 启用和系统重启是 Windows 的必需步骤，应用无法替用户跳过。

## 创建节点和首台实例

1. 在 QEMU 页面创建节点，第一次使用保留默认的 vCPU、内存、磁盘和 ADB 端口数量。
2. 等待节点 guest SSH 可达；首次置备会安装 guest 内 Docker 和 binder 所需组件，可能需要几分钟。
3. 在节点内创建一个无 GApps 的基础 Redroid 实例。
4. 等待 Android `boot_completed=1`，再查看 ADB 映射。
5. 在设备中心确认 serial 为 `127.0.0.1:<端口>` 且 ADB 状态为 `device`。
6. 运行 QEMU 验收，保存 PASS、FAIL 或 UNTESTED 的完整结果。

## 预装、升级与恢复

先完成基础实例，再启用 GApps、Magisk/Zygisk、LSPosed、Shamiko、Cloak、设备档案、ABI 和痕迹清理等可选能力。GApps 必须与目标 Android 版本匹配；当前 Android 13 x86_64 资产不能用于 Android 14。

升级前先确认数据卷和快照状态。升级失败时保留 `qemu.log`、`console.log`、实例状态和命令输出，再使用页面提供的恢复流程；不要在不清楚磁盘状态时直接删除 state 目录。

## 安全停止和日志

- 点击页面的停止按钮，让节点通过 QMP/ACPI 优雅关机。
- 不要用任务管理器或 `Stop-Process -Force` 硬杀 QEMU；这可能让 qcow2 留下损坏标记。
- `qemu.log` 记录 QEMU 自身输出。
- `console.log` 记录 guest 串口现场；guest 在网络或 SSH 就绪前卡住时，优先保存它。
- verify 的快照/克隆项目是信息项，快照操作必须遵守页面和 `qemu-center/README.md` 的运行中磁盘边界。

## 节点级隔离边界

同一节点内的多个 Redroid 容器共享 guest 内核，只具有 Docker namespace/cgroup 隔离。需要内核级隔离时，为实例创建独立节点；这会增加磁盘和启动成本。

## 命令行排障

QEMU CLI 的完整说明见 [`qemu-center/README.md`](../../qemu-center/README.md)。应用内日志和页面结果优先作为入口；只有需要进一步定位时，再按该文档使用 `doctor`、`verify`、guest 日志和优雅停止命令。
