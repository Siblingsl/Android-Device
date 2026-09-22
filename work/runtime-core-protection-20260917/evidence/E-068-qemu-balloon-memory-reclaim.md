# E-068 — QEMU virtio-balloon 显式内存回收

**日期**：2026-09-20  
**状态**：协议、规划器、CLI、桌面桥接及隔离 WHPX balloon 已验证；业务稳定性矩阵待人工确认  
**范围**：不停止 VM、不修改 qcow2、不改变节点下次启动的最大内存

## 自动化证据

- `qemu-center/src/vm.rs` 的 QEMU argv 现在只添加一个
  `virtio-balloon-pci,id=balloon0`。
- `qemu-center/src/qmp.rs` 发送 `balloon` 后必须成功读取并解析
  `query-balloon.return.actual`；缺失、非正数、格式错误或 QMP error 均 fail-closed。
- `plan_memory_reclaim` 只统计状态明确为 `up`/`running` 的实例，忽略已退出实例；
  活跃实例缺少 current bytes 或状态未知时不发送 QMP 请求。
- 规划目标使用 `used + max(768 MiB, active_count * 512 MiB)`，最低 1536 MiB，按
  256 MiB 向上对齐，并受节点注册的 `mem_mib` 上限约束。
- CLI 命令：`qemu-center vm memory-reclaim <name>`；节点停止、未注册、指标不完整或
  balloon actual 无法验证时均拒绝，不会强杀 QEMU。
- 桌面端命令：`qemu_vm_memory_reclaim`；QEMU 节点页的“回收 guest 内存”是显式动作，
  复用节点操作 busy 锁，完成后才刷新资源快照。
- QEMU runtime start 在已有的 critical-pressure 路径中会先按同一 CLI 尝试
  一次 guest reclaim；仅当压力仍为 critical 时才继续既有闲置实例释放。该路径尊重
  `runtime_auto_release_idle_on_critical`，不增加后台定时器，也不重复实现规划器。

## 隔离 WHPX 实样本

为避免改动现有 node1，先从停止态 node1 创建 CoW 克隆 node2，将克隆节点内存设为
2048 MiB，重新构建 qemu-center 后启动。启动回显确认包含
`-device virtio-balloon-pci,id=balloon0`。克隆 guest 的 cloud-init 已按原置备流程处于
`disabled-by-generator`，但 binder 和 Docker 均正常；`guest wait` 已改为依据这两个实际
运行条件判断，并在本次现场通过。

在 active `r13` 上取得：

| 字段 | 实测值 |
|---|---:|
| 节点配置 `mem_mib` | 2048 MiB |
| reclaim target | 1792 MiB |
| QMP verified actual | 1536 MiB |
| CLI reported reclaimed | 512 MiB |
| planner used / active | 1007 MiB / 1 |
| guest current / peak（回收后） | 约 1121 / 1130 MiB |
| OOM kills | 0 |
| `sys.boot_completed` | 1 |
| 回收期间 VM 是否运行 | 是 |
| 回收后 QEMU working/private sample | 约 874 / 2487 MiB |
| 回收后主机 available sample | 约 4496 MiB |

该次运行证明了 QMP 与 guest balloon 的实际路径生效；主机工作集前后没有形成严格的
同一时间窗口对照，不能从这组单点数据宣称节省固定 GB。随后 node2 已通过 ACPI/QMP
停止并 purge，注册表恢复为仅有 node1，node1 未被启动或改写。

同时修复了两个影响测量的边界：`guest wait` 不再要求已被禁用的 cloud-init 报告 done；
`redroid stats` 对 exited/created 等非 running 容器只读取 inspect 状态，不执行会卡住的
`docker exec`，因此退出实例不会阻断整节点统计。

## 本轮门禁

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npx vitest run --maxWorkers=1 --minWorkers=1` | 通过，61 文件 / 464 用例 |
| `cargo test --manifest-path qemu-center/Cargo.toml` | 通过，224 库 + 21 CLI |
| QEMU Tauri bridge 聚焦测试 | 通过，服务 argv 1 项；QEMU 页面 32 项 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 通过，301 项通过、0 失败、2 项忽略；QEMU bridge 与 Windows PTY 均通过。 |
| 两个 Rust crate `cargo fmt -- --check` | 通过 |
| `git diff --check` | 通过（仅有既有 CRLF 转换提示） |

## 真实 WHPX 验收表（待人工填写）

以下字段必须来自同一台真实 Windows/WHPX 节点、同一时间窗口；不得用自动化规划值冒充
实际回收值。

| 字段 | 记录 |
|---|---|
| 节点 / 实例 | node2 / r13（隔离样本；业务生产矩阵待人工） |
| 节点注册 `mem_mib` | 2048 MiB（隔离样本） |
| 规划器使用量 / active count | 约 1007 MiB / 1（规划输入，不是严格回收前 current/peak 对照） |
| 回收前 guest current / peak / OOM | 未形成严格同窗口前采样；回收后约 1121 / 1130 MiB / 0 |
| 规划 target MiB | 1792 MiB |
| QMP verified actual MiB | 1536 MiB |
| reclaimed MiB | 512 MiB（CLI 报告） |
| QEMU working set / private commit | 约 874 / 2487 MiB（回收后单点） |
| 主机 available memory | 约 4496 MiB（回收后单点） |
| Android `sys.boot_completed` / ADB | `1`；ADB 未在本轮克隆样本中做业务操作 |
| 小红书登录、连续浏览 | 待人工确认 |
| 30 分钟稳定性 / 新增 OOM | 待人工确认 |
| 回收期间 VM 是否持续运行 | 待人工确认，必须为“是” |

## 安全结论

当前只能证明协议和代码路径满足安全边界，不能宣称已经节省固定 GB，也不能宣称
登录、连续浏览或 30 分钟稳定性通过。旧 QEMU 进程若未带 balloon 设备，应报告不支持并
保持 VM 运行；需要先优雅停止再重新启动以使用新 argv。
