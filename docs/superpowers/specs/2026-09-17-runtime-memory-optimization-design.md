# QEMU/Redroid 运行时内存与启动优化设计

**日期**：2026-09-17  
**状态**：设计阶段，待用户评审  
**范围**：QEMU/WHPX 节点、guest 内 redroid 实例、设备中心运行时页面  

## 1. 目标

在不简单把主机内存升级到 6–8GB 的前提下，让单实例和多实例运行有可解释、可测量、可回滚的资源策略：

1. 区分 QEMU 节点内存、guest 可用内存、Docker 容器限制和 Android 进程实际占用。
2. 为“基础精简”和“完整预装”提供不同运行档案，不把 GApps、Magisk、LSPosed 等可选能力的成本隐藏在默认配置里。
3. 复用运行中的实例，避免每次切换都 `force-stop` 和重新初始化。
4. 在主机内存压力下按需停止空闲容器、串行启动实例，并在真正不安全时阻止新启动。
5. 用可重复的 A/B 数据决定节点内存、容器内存、CPU、ART 编译和 balloon 的默认值；没有实测证据时不替用户宣称已经降低内存或通过真机验收。

## 2. 当前基线与问题判断

2026-09-17 在当前工作区只读采集到：

| 指标 | 观测值 | 解释 |
|---|---:|---|
| 主机总内存 | 约 15.7 GiB | 当前 Windows 主机 |
| 主机可用内存 | 约 3.76 GiB | 已存在明显提交压力 |
| QEMU 参数 | `-m 4096 -smp 4` | 节点固定为 4 GiB、4 vCPU |
| QEMU 专用内存 | 约 4.65 GB | Windows 进程的提交/专用内存，不等于当前物理工作集 |
| QEMU 工作集 | 约 0.64 GB | 当前驻留物理页的近似值 |
| `vmmemWSL` 专用内存 | 约 1.6 GB | Docker/WSL 侧额外成本 |
| `r1` 状态 | `Exited (137)` | 至少发生过一次容器 OOM/强制杀死，不能只看空闲内存 |
| `r13` 状态 | `Up` | 当前仍有一台实例运行 |

因此，“6–8GB”很可能是 QEMU 的 4GiB 提交空间与 WSL/Docker 及宿主应用叠加后的主机观感。不能把 QEMU 的 `-m`、容器 `--memory`、Android 的 RSS/PSS 和 Windows 工作集当成同一个数字。`137` 也说明单纯把容器上限压到 1GiB 会把性能问题变成不稳定或再次 OOM。

## 3. 设计原则

- 先采集，再改默认值；现有用户数据实例不作为破坏性实验对象。
- “启动设备”与“重启应用”分离；前台切换优先复用现有容器和 ADB 会话。
- 精简档案和完整档案必须在 UI、命令参数、日志和报告中显式可见。
- 任何自动停止都只作用于满足空闲条件的实例；有控制流、ADB 操作、录制或用户锁定时不得回收。
- 空闲回收优先停止 redroid 容器，只有在更高内存压力下才停止 QEMU VM。
- 资源不足时给出可操作的原因和建议，不通过默认 `0`、伪造成功或静默 OOM 掩盖问题。
- QEMU 仍只允许优雅 ACPI/QMP 停止；不使用强杀作为调度手段，不在运行中对活跃 qcow2 做离线快照操作。

## 4. 运行档案

### 4.1 `lean`

用于只需要 Android 基础运行、ADB、控制和目标应用的场景：

- 默认不安装 GApps、Magisk、LSPosed、Shamiko、Cloak 和额外模块。
- Bluetooth 只在目标场景不需要且 A/B 验证没有回归时关闭；不能仅凭日志出现过崩溃就直接删除服务。
- 默认从 2 vCPU、1536–2048 MiB 容器限制开始实验；最终值由 OOM 次数、启动时间和浏览稳定性共同决定。
- 不改变 Android 分辨率、ABI 或应用数据来制造不可比结果。

### 4.2 `standard`

用于通常的应用测试：

- 保留基础 redroid 和目标应用。
- 按目标应用实际需要选择 Google 依赖；GApps 版本必须通过现有 Android 版本/ABI 校验。
- 默认不启用 LSPosed 及其模块，除非测试项目明确需要。

### 4.3 `full`

用于现有的 Root、设备档案和高级预装链路：

- 保留当前可选预装能力和数据卷。
- 资源提示中明确显示额外常驻服务、模块和预计内存风险。
- 不把 `full` 档作为低内存主机的默认档。

档案只是策略，不是未经验证的硬编码保证。每个档案都要记录实际的节点配置、容器限制、安装组件和实验结果。

## 5. 观测契约

新增一个只读、可序列化的运行资源快照，前后端字段使用同一语义：

```text
RuntimeResourceSnapshot {
  capturedAt: ISO-8601 string,
  hostTotalBytes: number | null,
  hostAvailableBytes: number | null,
  qemuPrivateBytes: number | null,
  qemuWorkingSetBytes: number | null,
  wslPrivateBytes: number | null,
  vmMemoryMiB: number | null,
  vmVcpus: number | null,
  instanceMemoryLimitBytes: number | null,
  instanceMemoryCurrentBytes: number | null,
  instanceMemoryPeakBytes: number | null,
  instanceOomKills: number | null,
  bootCompleted: boolean | null,
  appReadyMs: number | null,
  source: "host" | "qemu" | "guest" | "container" | "adb"
}
```

缺失数据保留 `null`，不转换为零。快照分为三层：

1. 主机层：Windows QEMU 进程和 `vmmemWSL` 的工作集/专用内存、主机总量/可用量。
2. 节点层：QEMU `-m`、vCPU、运行状态、启动时间和 guest `MemAvailable`。
3. 实例层：Docker cgroup 当前/峰值限制、OOM 事件、容器状态、ADB 在线状态、目标应用冷/热启动耗时。

采集器必须是只读的，并且具有超时；定时刷新不能执行会改变系统状态的命令。实验数据按实例、档案、节点配置和时间保存，便于比较而不是覆盖历史。

## 6. 启动与空闲调度

### 6.1 启动状态机

```text
requested
  -> resource_check
  -> queued (已有启动任务时)
  -> starting_vm (VM 未运行时)
  -> starting_container
  -> waiting_adb
  -> ready
```

失败状态必须区分：资源不足、VM 启动失败、容器 OOM、ADB 超时、应用未就绪。每个启动请求都有取消和超时边界；同一 VM 同时最多一个启动初始化任务。

### 6.2 内存压力分级

压力判断同时参考主机可用内存、QEMU/WSL 提交量和 guest/容器 OOM 事件：

- `normal`：允许启动和保持用户锁定的实例。
- `caution`：允许复用现有实例，新的启动进入队列，并提示先停止空闲实例。
- `critical`：禁止新启动；可以自动停止满足空闲条件且未锁定的容器；不得自动删除数据卷。
- `unknown`：指标不可用时不假装安全，保守地禁止批量并发启动，但允许用户显式启动单个实例并看到风险提示。

初始阈值通过基线实验确定，不在代码中散落多个常量。阈值配置必须带单位和说明，并有一个恢复滞后值避免频繁启停。

### 6.3 空闲定义

实例只有同时满足以下条件才可回收：

- 超过配置的空闲时长，默认建议 30 分钟；
- 没有活动控制流、录制、文件传输或自动化任务；
- 最近一段时间没有 ADB 命令或用户打开设备窗口；
- 用户没有手动标记“保持运行”。

回收顺序为：先停止 redroid 容器，再按主机压力决定是否优雅停止 VM。用户重新打开时，若容器仍在运行只调前台，不执行 `force-stop`。

## 7. 实验矩阵与验收

所有实验使用新实例或可回滚克隆，不清空现有 `r13` 数据。每个组合至少重复 3 次，报告中同时记录中位数、最大值和 OOM/失败次数：

| 维度 | 对照值 |
|---|---|
| VM 内存 | 3072 / 4096 MiB |
| VM vCPU | 2 / 4 |
| 实例档案 | lean / standard / full |
| 容器内存 | 1536 / 2048 / 3072 MiB |
| 预装 | 无高级预装 / GApps / Magisk+LSPosed 组合 |
| ART | 默认 / `speed-profile` 对照 |
| 生命周期 | 热复用 / 容器停止后启动 / VM 停止后启动 |
| 运行时 | 单实例 / 两实例错峰启动 |

每组验收四项：

1. 目标应用能启动、登录和连续浏览；真机交互结果标为待人工确认。
2. 冷启动、热启动和恢复前台时间不比基线恶化超过预先约定的 15%。
3. 稳定运行 30 分钟没有新的 OOM、ADB 断连或容器异常退出。
4. 选出的默认组合降低主机提交/工作集压力，并保留数据卷和回滚路径。

QEMU balloon 只作为实验项：在 `qemu_command` 增加 `virtio-balloon-pci` 前，必须先确认 Ubuntu guest 驱动、QMP balloon 操作和回收后的 Android 稳定性；实验失败时保持现有启动参数。

## 8. 预计改动边界

后续实施计划应按以下边界拆分：

- `qemu-center/src/vm.rs`：节点资源配置、可选 balloon 参数和纯函数命令测试。
- `qemu-center/src/redroid.rs`：档案到容器资源参数的纯函数映射、OOM 安全校验和测试。
- `qemu-center/src/main.rs`：只读资源/状态输出、启动串行化和安全停止流程。
- `src-tauri/src/services/qemu.rs` 与相关命令：桥接结构化资源快照和调度结果。
- `src/types/index.ts`、运行时页面与设置页：资源快照、档案、空闲策略和明确的未知状态。
- 现有测试文件：先写失败测试，再改实现；每个阶段跑项目规定的四套测试。

本设计不授权删除现有组件、不修改活跃 qcow2、不强杀 QEMU，也不把视觉或真机结果交给自动化测试冒充通过。

