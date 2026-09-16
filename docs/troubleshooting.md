# 故障排查

先记录应用版本、Windows 版本、使用的轨道和完整提示，再按下面的症状处理。不要为了快速“变绿”而跳过原始失败。

## Docker 引擎不可用

**现象**：Dashboard 或 Docker 轨道显示 Docker 未运行，创建按钮不可用。

**可能原因**：Docker Desktop 尚未启动、引擎启动失败，或当前用户没有访问 Docker 的权限。

**先做什么**：启动 Docker Desktop，等待它显示运行，再回到应用重新检查。确认 Windows 虚拟化和 WSL2 状态正常。

**如何确认**：Dashboard 的 Docker 状态出现版本号，Docker 页面可以读取镜像/容器列表。

**如何收集信息**：保存应用提示、Docker Desktop 版本、Windows 版本和应用日志。

**不能做什么**：不要在 Docker 引擎未准备好时连续点击创建，也不要删除已有数据卷来“修复”引擎问题。

## 容器已运行但 ADB 是 offline

**现象**：容器状态为 Up，但设备列表显示 `offline`，或等待 ADB 超时。

**可能原因**：Windows Docker 轨道缺 binder 内核、Docker Desktop 未在切换内核后重启，或者 Android 仍在启动。

**先做什么**：确认 WSL/binder 检查结果；切换自定义内核后重新打开 Docker Desktop；等待一段时间后重新检查 ADB。

**如何确认**：设备最终显示 `state=device`；只要仍是 `offline`，就不要把容器 Up 当作设备成功。

**如何收集信息**：保存容器日志、应用创建阶段日志、ADB 状态和 binder 检查结果。

**不能做什么**：不要反复删除容器和数据卷，也不要把 `offline` 改写成“已连接”。

## binder 检查失败

**现象**：Docker 轨道体检提示 binder 不可用，Redroid 无法完成启动。

**可能原因**：WSL 使用默认内核、内核架构不匹配，或自定义内核切换后 Docker Desktop 仍使用旧状态。

**先做什么**：打开 [`scripts/README-WSL-KERNEL.md`](../scripts/README-WSL-KERNEL.md)，确认 Windows x64 使用 x64 内核；在 Docker 页面重新检测并重启 Docker Desktop。

**如何确认**：应用的 binder 检查通过，之后再创建无 GApps 基础设备。

**如何收集信息**：保存平台检测结果、内核路径、Docker Desktop 版本和 WSL 状态。

**不能做什么**：不要在 Windows ARM64 上使用 x64 `bzImage`，不要把 binderfs 条目写进 guest 的 `/etc/fstab`。

## GApps 安装失败或版本不兼容

**现象**：创建前提示 GApps Android 版本与目标不兼容，或预装阶段失败。

**可能原因**：当前仓库资产是 Android 13 x86_64，目标实例选择了 Android 14 或其他 ABI。

**先做什么**：取消 GApps，先创建无 GApps 基础设备；需要 GApps 时准备与目标 Android 版本和 ABI 完全匹配的 zip。

**如何确认**：Android 13 x86_64 使用匹配资产；Android 14 使用 Android 13 zip 时必须被明确拒绝。

**如何收集信息**：保存目标 Android 版本、ABI、GApps 文件名和校验值，以及创建阶段日志。

**不能做什么**：不要改文件名伪装版本，不要将不匹配的 zip 继续推入镜像。

## QEMU/WHPX 无法启动或 guest 卡住

**现象**：QEMU 节点启动失败、SSH 等不到，或 guest 启动后不再响应。

**可能原因**：WHPX 未启用、系统尚未重启、QEMU 不可用、cloud image 缺失，或者宿主出现 WHPX 运行时问题。

**先做什么**：在 QEMU 页面重新运行体检；确认 WHPX、QEMU、SSH、ADB、cloud image 和磁盘空间。再查看节点目录中的 `qemu.log` 和 `console.log`。

**如何确认**：体检通过，guest SSH 可达，`guest wait` 完成，实例 `boot_completed=1`，ADB 为 `device`。

**如何收集信息**：保存 QEMU 页面命令日志、`qemu.log`、`console.log`、doctor/verify 输出、Windows 版本和 CPU 型号。

**不能做什么**：不要用任务管理器或 `Stop-Process -Force` 硬杀 QEMU；不要在磁盘状态未知时直接删除 qcow2。

## QEMU 磁盘提示损坏

**现象**：QEMU 报 qcow2 corrupt、snapshot table 错误，或节点无法再次启动。

**可能原因**：运行中的 VM 被强制终止，或快照操作触碰了仍被占用的活动磁盘。

**先做什么**：停止进一步写入，保留 `state/vms/<name>/` 中的日志和磁盘副本；优先使用项目提供的检查/修复流程，并确认目标路径不是正在运行的活盘。

**如何确认**：`qemu-img check` 的结果恢复正常，节点可以通过优雅的 `vm stop` / `vm start` 重新启动。

**如何收集信息**：保存完整错误文本、QEMU 日志、节点状态和最近执行的停止/快照操作。

**不能做什么**：不要把历史备份覆盖回活动磁盘，不要在未确认路径时使用批量删除。

## QEMU guest wait 或 SSH 失败

**现象**：节点进程存在，但 guest wait 超时或 SSH 公钥认证失败。

**可能原因**：cloud-init 尚未完成、seed 镜像没有被识别、guest 网络未就绪，或使用了旧的坏 seed 方案创建节点。

**先做什么**：查看 `console.log`，确认 seed 镜像存在且节点是用当前版本重建的；等待 cloud-init 完成后再重试。

**如何确认**：guest SSH 能返回成功标记，节点内 Docker 服务可用。

**如何收集信息**：保存 seed 文件状态、`console.log`、`qemu.log`、节点创建时间和 QEMU 版本。

**不能做什么**：不要回退到旧 ISO 或 QEMU VVFAT seed 方案；不要把花括号命令直接交给 PowerShell 造成参数被吞。

## scrcpy 不可用

**现象**：ADB 已连接，但投屏按钮不可用或 scrcpy 启动失败。

**可能原因**：scrcpy 路径没有设置、版本不可执行、ADB serial 不在 `device` 状态，或窗口被系统拦截。

**先做什么**：在设置中检测 scrcpy 路径，确认 ADB 状态后重新打开设备详情。

**如何确认**：设置页的 scrcpy 检查通过，设备详情能启动独立投屏窗口。

**如何收集信息**：保存 scrcpy 版本、路径、ADB serial 和启动错误。

**不能做什么**：不要把浏览器预览当成 scrcpy 运行成功。

## 升级失败或需要恢复

**现象**：预装升级失败、数据不见，或恢复前状态异常。

**可能原因**：目标 Android/ABI/GApps 不匹配、升级过程中 guest/容器未完成停止，或磁盘/数据卷状态未确认。

**先做什么**：停止继续升级，保存日志、实例状态和数据卷信息；使用页面提供的恢复升级前动作，不先删除数据卷。

**如何确认**：恢复完成后实例重新启动，数据哨兵、旧容器/数据卷和 ADB 状态符合验收记录。

**如何收集信息**：保存升级/恢复耗时、QEMU/Docker 日志、Android boot 状态和恢复结果。

**不能做什么**：不要把“容器重新出现”当作数据恢复成功，也不要在没有备份或快照确认时清理 state 目录。

## 提交 Issue 前的最小信息

- 应用版本和安装包文件名。
- Windows 版本/build、CPU 架构和可用磁盘。
- Docker 或 QEMU 轨道。
- 完整错误提示和复现步骤。
- 环境体检、doctor 或 verify 结果。
- 相关日志和截图；QEMU 额外提供 `qemu.log`、`console.log`。
