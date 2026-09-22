# E-051 — 新建 3072 MiB lean 节点样本（2026-09-18）

## 范围与安全边界

使用本地已有 Ubuntu base image 新建临时 `node2`，配置为 3072 MiB / 2 vCPU，
只创建一个 `lean1` 实例（1536 MiB 容器上限）。未启动或修改现有 `node1`，
未清空业务数据；采样结束后先停止容器，再通过 QMP 请求 ACPI powerdown，
确认 QEMU 进程退出后才使用 `vm delete --purge` 清理临时节点。

新节点首次 cloud-init 完成后 Docker daemon 未自动进入可用状态，使用既有
`guest provision` 流程恢复，最终 readiness 为 `binderfs=Ok docker=Ok`；这属于
节点首启流程观察，不改变本次内存样本的配置。

## 观测

- 节点：`node2`，3072 MiB / 2 vCPU / WHPX
- 实例：`lean1`，Android 13 lean，容器上限 1536 MiB
- `boot_completed=true`
- guest current：`1,212,571,648` bytes，约 `1.13 GiB`
- guest peak：`1,319,235,584` bytes，约 `1.23 GiB`
- OOM kills：`0`
- QEMU working set：`3,300,380,672` bytes，约 `3.07 GiB`
- Windows `FreePhysicalMemory`：`1,299,004 KiB`，约 `1.24 GiB`

## 结束与结论

`lean1` 已通过 `redroid stop` 停止，`node2` 已通过 `vm stop` 正常关机；未使用
强杀。之后仅删除临时 `node2` 的磁盘和密钥，`vm list` 只剩原有 `node1`。

该样本再次支持“3072 MiB 节点 + lean 1536 MiB”作为低占用基线，但只覆盖启动后的
稳定内存与 boot 状态，不覆盖登录、连续浏览或 30 分钟稳定性，不能直接作为业务默认。
