# QEMU 动态内存回收设计

## 背景

当前 QEMU 节点用固定 `-m <MiB>` 启动。redroid 容器虽然有 cgroup
`--memory` 上限，但 guest 已经触碰过的页仍可能继续留在 QEMU 工作集里；因此
停止一个应用或降低容器上限，并不能稳定地降低宿主机的 QEMU 占用。

## 目标

在不停止 VM、不修改 qcow2、也不降低节点最大内存配置的前提下，允许用户对运行中的
QEMU 节点执行一次安全的 guest 内存回收：通过 virtio-balloon 把当前确认闲置的 guest
页退还给宿主机，在需要时仍可恢复到原来的最大内存。

成功标准：

1. 新启动的 VM 带有 `virtio-balloon-pci` 设备；旧 VM 不具备该设备时，回收操作明确失败，
   不停止 VM、不触碰磁盘。
2. 回收目标由 guest 当前运行实例的只读 cgroup 指标计算；任何活跃实例指标缺失或状态
   不明确时 fail-closed，不发出 balloon 命令。
3. 目标值不低于 1536 MiB，不高于节点 `mem_mib`，并额外保留 guest/Docker/突发余量；
   目标按 256 MiB 对齐，避免频繁小幅调整。
4. 该操作默认是显式用户动作，不新增后台定时回收，不与现有闲置停止策略混为一谈。
5. QMP 回收失败、设备缺失或 guest 指标不可用时，节点继续运行，页面显示可行动的失败原因。
6. 通过纯函数测试、CLI/Tauri 桥接测试和真实 WHPX 节点人工验收后，才能记录实际宿主机
   working set 节省量；在此之前不得承诺固定节省多少 GB。

## 非目标

- 不用 ballooning 替代 `lean / standard / full` 容器档案。
- 不在线修改节点的最大 `-m`，不调用 `Stop-Process -Force`。
- 不在没有 guest 指标时猜测内存目标。
- 不把 ballooning 描述为 Android 或 QEMU 的硬性内存保证；guest 内核、WHPX 和 QEMU
  版本仍需在目标机器上实测。

## 目标计算

只统计状态规范化后为 `up` 或 `running` 的实例。若有运行实例缺少
`memory_current_bytes`，返回 `UnknownMetrics`；退出实例不计入使用量。

```text
used = sum(active.memory_current_bytes)
reserve = max(768 MiB, active_count * 512 MiB)
raw_target = max(1536 MiB, used + reserve)
target = ceil(raw_target / 256 MiB) * 256 MiB
target = min(target, node.mem_mib)
```

如果 `target >= node.mem_mib - 256 MiB`，报告“当前没有可安全回收的空间”，不发送
QMP 命令。没有活跃实例时目标为 1536 MiB，但仍需 guest 已启动且 QMP/balloon 设备可用。

## 运行时边界

- QEMU 启动参数新增 `-device virtio-balloon-pci,id=balloon0`。
- qemu-center 新增 `vm memory-reclaim <name>`，内部顺序为：加载 registry → 证明 QMP
  running → 读取 guest redroid stats → 计算目标 → 发送 `balloon` → 查询实际值 → 输出
 结构化结果。
- `balloon` 只允许把 guest 目标设在计算器给出的安全范围内；CLI 不接受绕过计算器的任意
 低目标参数。
- Tauri 增加只读结果桥接和 QEMU 节点卡片上的显式操作。操作期间锁定同一节点的其他
  VM 操作，完成后刷新资源快照。
- 该操作不创建授权旁路：受保护实例的运行状态和资源读取仍走既有服务端授权/guest
  闸门，balloon 只处理 VM 层内存。

## 验收矩阵

自动化覆盖：QEMU argv、QMP frame、目标计算器、缺失/unknown 指标、退出实例过滤、
节点未运行、QMP 拒绝、Tauri service 调用和 i18n 完整性。

人工覆盖：

1. 3072 MiB lean 节点、无实例：回收前后 QEMU working set 与 guest 可用内存记录。
2. 3072 MiB standard + XHS：回收前后登录页、ADB、cgroup current/OOM 和 working set。
3. 回收后再次启动/恢复应用：确认 balloon 可回涨且没有数据卷变化。
4. 旧 VM/无 virtio-balloon、指标 unknown、QMP 断开：均保持 VM 运行并显示失败原因。
5. 30 分钟稳定性与现有 P7-1 真机走查：不能用单次采样替代。

