# 运行时内存优化实验矩阵

**日期**：2026-09-17  
**状态**：已完成 3072 MiB/4 vCPU 与 3072 MiB/2 vCPU lean 复制实例的 XHS 冷启动样本，并补充现有 4096 MiB/full 实例的实时内存与 ART 对照；另有新建 3072 MiB/2 vCPU lean 节点的独立内存样本；完整复制矩阵、登录/连续浏览和 30 分钟稳定性仍待人工执行
**安全边界**：不停止或强杀当前 QEMU，不清空 `r13` 数据卷，不在运行中使用离线 qcow2 工具。

## 记录规则

- 每个组合至少重复 3 次，记录冷启动、热切换、容器恢复和 VM 恢复的 P50/P95。
- 同时记录 host available、QEMU Private/Working Set、WSL、容器 current/peak/limit/OOM 和 ADB 状态。
- RSS 合计会重复计算共享页，只用于进程构成分析；容器 cgroup current 才用于内存上限和 OOM 判断。
- “登录/浏览”必须由人工确认；只显示登录页不等于业务稳定。

## 当前已取得的基线

| 节点 | vCPU | 档案/组件 | 容器限制 | current | peak | OOM kill | 启动状态 | 业务结论 |
|---:|---:|---|---:|---:|---:|---:|---|---|
| 4096 MiB | 4 | full：GApps + Magisk + LSPosed/Shamiko | 3072 MiB | 约 2.88 GiB | 约 3.00 GiB | 0 | boot=1 | 曾到登录页；连续浏览未验收 |

来源：`work/runtime-core-protection-20260917/evidence/E-001-runtime-baseline.md`、`E-005-app-process-breakdown.md`、`E-036-live-memory-and-art-20260918.md`。该行是当前实例观测，不是完整业务验收。

## 已取得的 lean/XHS 对照

| 节点 | vCPU | 档案/组件 | 容器限制 | speed-profile 前 P50 | speed-profile 后 P50 | 稳定 current | OOM | 业务结论 |
|---:|---:|---|---:|---:|---:|---:|---:|---|
| 3072 MiB | 4 | lean；无可选预装；Android 13 | 1536 MiB | 914 ms | 932 ms | 约 1.12 GiB | 0 | 已启动并安装 XHS；未登录/连续浏览 |
| 3072 MiB | 2 | lean；无可选预装；Android 13 | 1536 MiB | 1089 ms（后两次；首次 2082 ms） | 未测 | 约 1.33 GiB，峰值触达 1.5 GiB | 0 | 已启动并安装 XHS；未登录/连续浏览；见 E-042 |
| 3072 MiB | 2 | standard；无可选预装；Android 13 | 2048 MiB | 970 ms（后两次；首次 1839 ms） | 未测 | 约 1.75 GiB，峰值约 1.98 GiB | 0 | 已启动并安装 XHS；未登录/连续浏览；见 E-043 |

另建临时节点 `node2` 的 lean 基线为 current 约 `1.13 GiB`、peak 约 `1.23 GiB`、
OOM `0`，QEMU working set 约 `3.07 GiB`，宿主可用约 `1.24 GiB`；见
`work/runtime-core-protection-20260917/evidence/E-051-fresh-3072-lean-memory-sample-20260918.md`。

样本、命令和限制见 `work/runtime-core-protection-20260917/evidence/E-016-xhs-lean-art-matrix.md` 与
`work/runtime-core-protection-20260917/evidence/E-042-isolated-3072-2vcpu-xhs-lean-20260918.md`。

## 待执行矩阵

| 节点内存 | vCPU | 档案 | 容器限制 | 可选组件 | ART | 冷启动 ×3 | 热切换 ×3 | 稳定 30 分钟 | 登录/浏览 |
|---:|---:|---|---:|---|---|---|---|---|---|
| 3072 MiB | 2 | lean | 1536 MiB | 无 GApps/Magisk | 默认 | 已测 E-042 | 待测 | 待测 | 待人工 |
| 3072 MiB | 2 | standard | 2048 MiB | 按需、默认关闭 | 默认 | 已测 E-043 | 待测 | 待测 | 待人工 |
| 3072 MiB | 2 | full | 3072 MiB | GApps + Magisk | 默认 | 待测 | 待测 | 待测 | 待人工 |
| 4096 MiB | 4 | lean | 1536 MiB | 无 GApps/Magisk | 默认 | 待测 | 待测 | 待测 | 待人工 |
| 4096 MiB | 4 | standard | 2048 MiB | 按需、默认关闭 | 默认 | 待测 | 待测 | 待测 | 待人工 |
| 4096 MiB | 4 | full | 3072 MiB | GApps + Magisk | 默认 | 已有基线，需重复 | 待测 | 待测 | 待人工 |

## 应用进程暂停 A/B

实现状态：设备中心已提供默认手动的“暂停应用”操作。它只接受精确的
QEMU `vm`/`instance`/ADB `serial` 映射和合法包名，闲置策略不允许时会返回
原因，不会执行 ADB 停止；成功后保留 container 和 QEMU 节点运行。唤醒继续使用
设备详情页的现有“启动应用”操作。以下数字仍需人工在真实实例上填写，不能
由自动化测试代替。

在同一复制实例上比较：

1. 保留 VM/container 运行，目标应用前台使用后等待闲置策略阈值。
2. 在 QEMU 实例行点击“暂停应用”，输入目标包名（默认 `com.xingin.xhs`）并确认。
   如果返回 `active_or_unknown`，先等待配置的闲置时间；不要绕过保护策略。
3. 重新启动目标包，记录恢复前台时间、容器 current、QEMU/WSL 工作集和登录状态。

该实验验证“保留设备热状态、释放小红书多进程树”是否比停止整个 redroid 更适合日常内存回收。必须由人工确认账号状态、推送、后台任务和浏览连续性。

## 现有 full 实例补充采样

2026-09-18 安全启动 `node1/r13` 后，未启动目标应用时 guest current 为约
2.32 GiB，QEMU working set/private 约 3.26/4.25 GiB，宿主可用约 1.10 GiB；
将 XHS Activity 调到前台后，guest current 约 2.84–3.00 GiB，QEMU
working set/private 约 3.46/4.26–4.30 GiB，宿主可用降至约 0.45–0.54 GiB，
XHS PSS 约 0.50–0.64 GiB，OOM=0。该数据证明主要压力来自 full guest/QEMU 组合，
但不替代登录和连续浏览验收。完整命令与限制见 `E-036-live-memory-and-art-20260918.md`。

## ART A/B

对同一复制实例按顺序记录 `verify-only` → 默认启动基线 → `speed-profile` → 再次启动；
3072 MiB lean 样本的 P50 为 914 ms → 932 ms，未显示改善；本轮 4096 MiB/full
现有实例样本为 2142 ms → 1544 ms，但未覆盖登录/连续浏览，因此仍不作为全局默认优化。
Android 13 的有效 verify 命令包含 `-m verify --check-prof true`；`reset` 需要更高权限，
失败或回归时由有权限的操作者显式执行。

## 选择规则

- 选择满足登录、连续浏览、30 分钟无新增 OOM/ADB 断连的最低内存组合。
- 冷启动或热切换恶化超过 15% 时，不因节省内存强行采用。
- 如果 full 组合不稳定，保留 lean/standard 的证据，不继续盲目降低 full 的硬上限。
