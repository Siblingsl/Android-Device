# 兼容性矩阵

本文只记录有证据支持的结论。没有运行记录的组合不会写成“支持”。

## 状态含义

| 状态 | 含义 |
|---|---|
| 已验证 | 有当前版本的真机、干净机器或 CI 证据 |
| 部分验证 | 代码/命令拼装已验证，但完整运行链路仍缺证据 |
| 实验性 | 有实现或资产，但没有稳定 Beta 所需的覆盖 |
| 不支持 | 当前版本明确拒绝或没有可行的依赖组合 |
| 未验证 | 没有足够证据，不作结论 |

## 主机与运行轨道

| 主机/轨道 | 状态 | 已知条件 | 证据与限制 |
|---|---|---|---|
| Windows x64 + Docker | 部分验证 | Docker Desktop、WSL2、binder、ADB、scrcpy、Redroid 镜像 | 开发机和自动化覆盖较完整；干净 Windows 首次安装仍需按 QA 清单复核 |
| Windows x64 + QEMU/WHPX | 部分验证 | WHPX、QEMU、OpenSSH、ADB、Ubuntu cloud image、足够磁盘 | node1 已有真机 7/7 验收记录；当前 CLI 版本仍需按发布版本复跑完整安装记录 |
| Windows ARM64 + Docker | 实验性 | 必须使用 ARM64 WSL 内核和匹配镜像 | 不能使用 x64 `bzImage`；未作为稳定 Beta 承诺 |
| Windows ARM64 + QEMU | 实验性 | 需要架构匹配的 QEMU、guest 镜像和 Redroid 镜像 | 未完成稳定矩阵验证 |
| macOS | 实验性 | 需要 Docker Desktop Linux VM、QEMU 或远程 Linux 提供 binder | 现有 macOS 工作流仅用于实验性打包，不属于首个 Windows Beta 正式范围 |
| Linux x64 | 实验性 | 使用宿主 binder，不安装 Windows WSL 内核 | 资产配置标记为可行；不属于本次 Windows Beta 的验收门 |

## 工具与系统功能

| 项目 | Docker 轨道 | QEMU 轨道 | 说明 |
|---|---|---|---|
| Docker Desktop | 必需 | guest 内置/置备 | Docker 轨道依赖宿主引擎；QEMU 轨道由节点 guest 运行 Docker |
| WSL2/binder | Windows 必需 | 不直接使用宿主 binder | 自定义内核切换后要重新打开 Docker Desktop |
| WHPX | 不要求 | 必需 | Windows 系统功能，需要 UAC 和一次重启 |
| QEMU/qemu-img | 不要求 | 必需 | 可使用 QEMU 轨道的便携安装 |
| OpenSSH 客户端 | 不要求 | 必需 | 节点 SSH 置备、等待和验收使用 `ssh.exe` |
| ADB | 必需 | 必需 | 宿主连接设备；状态必须为 `device` 才算连接成功 |
| scrcpy | 需要投屏时必需 | 需要投屏时必需 | 可在设置中指定路径或使用 PATH |
| 可用磁盘 | 取决于 Docker 镜像/数据卷 | 至少 40 GiB | QEMU 节点需要 cloud image、qcow2 和运行时空间 |

## Android、镜像和预装

| 组合 | 状态 | 限制 |
|---|---|---|
| Android 13 + x86_64 + Redroid | 已验证 | 当前 GApps 资产的基础目标 |
| Android 13 + x86_64 + MindTheGapps | 已验证 | 使用仓库外部资产；zip 不进入 Git |
| Android 14 + Android 13 GApps | 不支持 | 创建前必须拒绝，不能继续安装 |
| Android 14 + 匹配 GApps | 未验证 | 需要对应版本的 GApps zip 和独立真机记录 |
| x86_64 镜像伪装 arm64 ABI | 实验性/高风险 | 没有翻译层时可能导致应用或 native 库无法运行 |
| Magisk + Zygisk | 部分验证 | 仅用于授权内部 App 测试；需要匹配资产 |
| LSPosed | 部分验证 | 需要在设备内确认 daemon 真实激活 |
| Shamiko | 实验性 | 某些 Redroid 环境会自报 Unsupported environment，不能仅凭模块文件存在判定通过 |
| DeviceCloak / native cloak | 部分验证 | 需要按目标 Android/ABI 组合单独验收 |
| 设备档案与痕迹清理 | 部分验证 | 必须记录实际 getprop、/proc 和重启后的结果 |

## 证据来源

- 当前自动化基线、QEMU 真机记录和已知边界：[AI 续接文档](AI-HANDOFF-NEXT-STEPS.md)。
- QEMU 运行边界、端口、快照和日志：[qemu-center README](../qemu-center/README.md)。
- Windows binder 内核资产和架构说明：[平台资产配置](../scripts/platform-assets.json)。
- 新版本的干净机器和人工视觉结论：见 [`docs/qa/`](qa/) 中对应版本的证据索引。

## 更新规则

每次发布只更新本次真正验证过的行；代码测试通过不能单独把真机、安装或视觉项目改为“已验证”。当证据过期或运行时发生变化时，将状态降回“部分验证”或“未验证”，并在 Release Notes 中写明。
