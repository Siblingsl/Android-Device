# E-007 — Live-node clone safety guard

日期：2026-09-17  
范围：`qemu-center vm clone` 在运行中源节点上的写盘前护栏。

## 验证

- 源节点 `node1` 当时由 QMP 判定为运行中，且仍包含现有 `r13` 数据实例。
- 使用新编译的 CLI 执行：

  `qemu-center vm clone node1 matrix-live-guard --state-dir qemu-center/state`

- 实际结果：退出码 `1`，错误为：

  `refusing to clone node1: cannot clone a VM while QEMU is running`

- 拒绝发生在 `qemu-img create -b` 之前；目标 `matrix-live-guard` 未创建，
  `vm list --json` 仍只有 `node1`，其内存配置仍为 `4096 MiB`。
- 纯策略回归 `clone_requires_a_qmp_proven_stopped_source` 通过；运行中和
  QMP 状态未知均拒绝，停止态才允许进入克隆流程。

## 边界

本证据只证明运行中/未知状态不会调用克隆写盘命令；停止态的实际 qcow2
克隆和后续 Android 登录/浏览仍属于内存矩阵的人工验收，不在此处宣称通过。
