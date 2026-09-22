# E-033 — node1/full r13 实时内存快照

日期：2026-09-18

## 操作边界

- 使用现有 `qemu-center vm start node1`，经过 QMP 停止态与主机内存护栏；
- `guest wait` 通过：SSH、cloud-init、binder、Docker readiness 均成功；
- 只读执行 `doctor`、`redroid list`、`redroid stats --json` 和 Windows 进程/CIM 采样；
- 最后使用 `vm stop node1` 发起 ACPI/QMP 停止，QEMU 自然退出；未使用强杀，未修改 qcow2。

## 实测结果

### Guest/container

| 项目 | 结果 |
|---|---:|
| 节点 QEMU 配置 | 4096 MiB / 4 vCPU / WHPX |
| `qc-r13` limit | 3221225472 bytes = 3072 MiB |
| `qc-r13` current | 3208708096 bytes ≈ 3060.1 MiB |
| current / limit | ≈ 99.6% |
| peak | 3210108928 bytes |
| OOM kills | 0 |
| boot completed | true |
| CPU | 221.92% |
| `r1` | `Exited (137)`，未运行 |

### Windows host

| 项目 | 结果 |
|---|---:|
| 总物理内存 | 15.729 GiB |
| 采样时可用物理内存 | 0.356 GiB |
| QEMU working set | 2.955 GiB |
| QEMU private memory | 4.283 GiB |
| `vmmemWSL` | 本次采样未返回独立进程 |

## 结论

当前 full `r13` 已经接近其 3 GiB 容器上限，不能直接把上限压到 1–2 GiB；主机只有约
0.356 GiB 可用是性能恶化的直接风险。优先级应是 lean/standard 精简组件 A/B、闲置实例
释放和按需启动；4 GiB full 节点不适合同时承载第二个高负载实例。该快照是一次真实运行样本，
仍不能替代登录、连续浏览和长时间稳定性矩阵。
