# E-066 — 宿主侧 authorization receipt 一次性重放闸门

日期：2026-09-20

## 目的

E-065 已让 `qemu-center` 只接受服务端签名、操作绑定的 authorization receipt，但单靠验签不能阻止同一台主机在本地状态被恢复后再次使用同一份合法回执。这里补充同主机状态目录内的一次性消费账本，作为服务端 JTI 一次性消费之外的纵深防御。

## 实现边界

- `qemu-center` 在 grant 与 receipt 全部验签、逐项绑定校验通过后，才调用 `consume_execution_receipt_once`。
- 账本位于 `<state-dir>/execution-receipts/`，以 URL-safe 编码的 JTI 作为文件名。
- 账本文件使用 `OpenOptions::create_new(true)` 创建；首次消费成功，重复或并发消费同一 JTI fail closed，且发生在 `docker ps`、`docker volume create`、`docker run` 之前。
- 空 JTI、过长 JTI 以及包含 NUL/换行/回车的输入直接拒绝，不参与路径构造。
- 创建成功后不因后续 Docker 操作失败而回滚账本：该 receipt 已经是服务端一次性授权，失败重试必须重新走服务端 grant 与设备 proof。

## 自动化证据

| 检查 | 结果 |
|---|---|
| 首次消费与同目录重放 | 通过；同一 state directory/JTI 首次成功，第二次返回 already-consumed 错误；不同 state directory 独立 |
| 非法 JTI | 通过；空值、换行、回车、NUL 均拒绝 |
| 并发消费 | 通过；8 个并发消费者中恰好 1 个成功，另外 7 个被原子账本判定为重放 |
| qemu-center 全量测试 | 通过；216 个库测试 + 18 个命令行测试，0 失败 |
| 格式检查 | 通过；`cargo fmt --manifest-path qemu-center/Cargo.toml -- --check` |

## 残余边界

这是同一份 host state directory 内的重放防护，不是远程证明。拥有宿主管理员权限的攻击者仍可能删除或整体复制该状态目录，guest root 也能观察合法运行期间的明文 runner；这些场景仍必须依赖服务端新签发的设备绑定 grant、设备私钥 proof、TLS/账号/撤销和生产密钥轮换。该账本不会改变 live qcow2，也没有对正在运行的 QEMU 做离线操作。
