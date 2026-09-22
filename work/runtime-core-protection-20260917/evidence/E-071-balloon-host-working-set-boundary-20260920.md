# E-071 — Balloon 对宿主工作集的实测边界

**日期**：2026-09-20  
**状态**：隔离 WHPX 实测完成；node1 未启动、未改写，node2 已安全停止并 purge  
**范围**：验证 2048 MiB CoW 节点在有/无活跃 redroid 容器时的 balloon 行为，避免把 QMP target 当成宿主内存节省承诺

## 实验安全边界

- 从停止态 `node1` 创建 CoW `node2`，只把 node2 改为 2048 MiB。
- node2 通过 ACPI/QMP 正常停止，确认 QEMU PID 退出后才执行 `vm delete --purge node2`。
- 最终注册表只剩 `node1`；node1 磁盘仍存在，node2 VM 目录和 SSH key 均已删除。

## 活跃 r13 基线

node2 启动并通过 guest readiness 后，启动克隆盘内已有的 `qc-r13`，连续采样三次：

| sample | host available | QEMU working set | QEMU private | guest current | guest peak | OOM | boot |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 2732.9 MiB | 2125.2 MiB | 2568.3 MiB | 1486.6 MiB | 1631.1 MiB | 0 | true |
| 2 | 2724.1 MiB | 2125.4 MiB | 2568.2 MiB | 1453.8 MiB | 1631.1 MiB | 0 | true |
| 3 | 2726.6 MiB | 2125.9 MiB | 2569.2 MiB | 1455.1 MiB | 1631.1 MiB | 0 | true |

此时执行 `vm memory-reclaim node2` 被规划器拒绝，原因是当前使用量加保留量不足一个 256 MiB 回收量子；没有发出不安全的 balloon 请求。

## 空闲 guest 回收对照

停止 `qc-r13` 后，回收前单点为：host available `2653.8 MiB`、QEMU working set `2125.7 MiB`、private `2569.1 MiB`，guest 内所有实例均为 exited。

执行结果：

```text
memory reclaim verified: target=1536 MiB actual=2048 MiB reclaimed=0 MiB used=0 MiB active=0
```

回收请求没有改变 QMP actual，也不能据此宣称宿主工作集下降。该结果说明 virtio-balloon 是协作式回收通道，不是强制缩小 QEMU `-m` 上限的开关；如果 guest 没有可交付页面或驱动没有完成释放，target 可能低于 actual。

## 结论与下一步

- 2048 MiB 节点运行克隆 r13 时，guest current 约 1.45 GiB，安全规划器拒绝继续压缩，验证了 fail-closed 边界。
- 当前更可靠的宿主节省路径仍是：使用 lean/standard 档案、减少 GApps/Magisk/LSPosed 等常驻服务、暂停或停止闲置实例、空节点停止 VM；不能把 balloon target 当成固定 GB 节省。
- 本实验未覆盖小红书登录、连续浏览或 30 分钟稳定性，也未证明业务场景下的固定宿主节省量。
