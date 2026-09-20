# E-058 — QMP 超时下的主机进程安全兜底与隔离克隆

- 日期：2026-09-20
- 范围：`qemu-center` 停机节点的安全状态判断、隔离克隆、内存参数验证
- 目标：处理 Windows 上 QMP 端口黑洞导致的 `TimedOut`，同时保持活盘写入 fail-closed

## 变更

- 原始语义保持不变：`Answered => Running`、`Refused => Stopped`、`TimedOut => Unknown`。
- 仅当 QMP 超时且独立主机进程探测成功证明不存在任何 `qemu-system-*` 进程时，才将该结果提升为 `Stopped`。
- 主机进程探测失败，或仍有任意 QEMU 进程时，继续拒绝克隆、启动、改内存和磁盘写入路径。
- 克隆前创建目标目录；`qemu-img`、端口分配或注册表写入失败时清理刚创建的临时目录。

## 自动化证据

```text
cargo test --manifest-path qemu-center/Cargo.toml
215 lib tests passed; 6 main tests passed; 0 failed.

cargo build --manifest-path qemu-center/Cargo.toml --release
Finished release profile.
```

## 停机节点隔离验证

现场先确认 `node1` 已停机且不存在 `qemu-system-x86_64` 进程；未启动 QEMU，未直接操作 `node1` qcow2。

```text
vm clone node1 matrix3072-20260920
clone written in 106 ms (qcow2 backing file — no data copied).
VM matrix3072-20260920 cloned from node1 (ssh port 22301).

vm set-memory matrix3072-20260920 3072
VM matrix3072-20260920 memory changed from 4096 MiB to 3072 MiB.

vm delete matrix3072-20260920 --purge
VM matrix3072-20260920 deleted (registry updated).
```

最终状态：`state.json` 只剩 `node1`，仍为 4096 MiB、4 vCPU、SSH 22300、QMP 23300；临时节点目录不存在。

## 边界与待人工确认

- 本证据只证明停机态 CLI 保护与隔离克隆路径；没有宣称 QEMU/Android 真机启动或视觉验收通过。
- 若主机上存在任何 QEMU 进程，QMP 超时仍会被视为未知并拒绝写入；应先通过 QMP/正常 ACPI 停机后再操作。
- P7 真机人工走查、生产授权服务 TLS/密钥轮换和复制/重放演练仍按验收文档执行。
