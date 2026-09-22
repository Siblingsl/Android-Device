# E-001 — Runtime baseline

**采集性质**：本地只读观察；没有停止 QEMU、修改 qcow2 或触碰业务数据。

## 观测

- `qemu-center/state/state.json`: `node1` 为 `vcpus=4`, `mem_mib=4096`。
- QEMU 进程参数包含 `-m 4096 -smp 4 -accel whpx -cpu max,-svm,-vmx`。
- QEMU PID 11704（最新采样）：PrivateMemorySize64 约 4.66 GB，WorkingSet64 约 0.58 GiB。
- 主机总内存约 15.7 GiB，可用约 3.69 GiB。
- `vmmemWSL` 专用内存约 1.71 GB。
- `r1` 为 `Exited (137)`，`r13` 为 `Up`。
- 2026-09-17 只读 guest 采样：`qc-r13` 为约 `2.514 GiB / 3 GiB`（83.81%），cgroup current `3065827328` bytes，peak `3221241856` bytes，`oom_kill=0`；`docker stats` CPU 约 11.37%。
- 同一采样中 `qc-r13` 的 `memory.events` 为 `oom=0`, `oom_kill=0`，但峰值已贴近 3 GiB 上限。
- 修复短/完整 Docker ID 合并后，`cargo run ... redroid stats node1 r13 --json` 已通过产品 CLI 读到：current `3064819712` bytes、peak `3221241856` bytes、`oom_kills=0`、CPU `9.71%`、`boot_completed=true`；该命令为只读采样。
- 随后同一只读 CLI 采样读到 current `3092234240` bytes（约 2.88 GiB，约 96% of limit）、peak `3221241856` bytes、`oom_kills=0`、CPU `2.5%`、`boot_completed=true`。
- 2026-09-17 最新只读 CLI 采样：`qc-r13` current `3069067264` bytes（约 2.86 GiB，约 95.3% of limit）、peak `3221241856` bytes、`oom_kills=0`、CPU `2.99%`、`boot_completed=true`；没有执行停止、重启或配置写入。
- 2026-09-17 18:07:33 +08:00 本轮只读 CLI 采样：`qc-r13` current `2990911488` bytes（约 2.79 GiB，约 92.8% of limit）、peak `3221241856` bytes、`oom_kills=0`、CPU `8.82%`、`boot_completed=true`；仍未执行停止、重启或配置写入。

## 解释

QEMU commit/private、工作集、WSL/Docker 和 guest/container cgroup 不是同一口径；6–8GB 的体感不能直接等于单个 Android 进程的实际 RSS/PSS。`137` 证明需要同时观察峰值和 OOM，而不是只降低容器上限。

本次采样进一步说明：当前 full 档案的 3 GiB 容器上限确实被使用到 83% 以上；在没有精简 GApps/Magisk/后台服务并完成登录浏览回归之前，继续下调很可能换来卡顿或 OOM。优化重点应是按需运行、减少常驻组件和避免重复初始化，而不是简单改成 1 GiB。

## 代码落点

- `src-tauri/src/services/resource_monitor.rs`
- `qemu-center/src/redroid.rs`
- `src-tauri/src/services/runtime_scheduler.rs`
- `src/pages/tracks/QemuTrackPanel.tsx`
