# E-059 — 2048 MiB QEMU 基座样本与克隆 SSH 身份修复

- 日期：2026-09-20
- 范围：隔离 QEMU 节点基座内存、cloud-init/Docker readiness、克隆身份一致性
- 原节点：`node1` 保持停机，未修改其磁盘、内存配置或实例注册

## 2048 MiB fresh 节点

从本地已有 Ubuntu cloud image 创建全新 `2 vCPU / 2048 MiB` 节点，使用独立端口
22302/23301，未复用业务数据盘。启动约 72 秒后，串口显示 cloud-init、Docker 和
`qemu-center guest ready` 全部完成。

现场只读采样：

```text
QEMU working set:       2,033,131,520 bytes  (~1.89 GiB)
guest free:               446,971,904 bytes
guest available:        1,652,293,632 bytes (~1.54 GiB)
host available:         2,804 MiB
cloud_init=done
docker=ready
```

这证明把节点从 3072 MiB 降到 2048 MiB 能直接降低 QEMU 基座占用；但该节点尚未安装
小红书或执行登录/连续浏览，因此 2048 MiB 只能作为低内存实验候选，不能替代 3072 MiB
standard 的业务推荐。

## 克隆身份修复

首次从 `node1` 克隆 2048 MiB 节点时发现，克隆磁盘保留源 guest 的 `authorized_keys`，
而 host 侧没有对应的新节点私钥，导致 SSH `Permission denied (publickey)`。现已修复
`vm clone`：

- 克隆前复制源 VM 的私钥/公钥到新节点键路径；
- 目标键已存在或源键缺失时拒绝覆盖/克隆；
- 后续端口分配或注册失败时同时清理新磁盘与复制的密钥；
- 新增 `clone_copies_the_source_ssh_identity_for_the_cloned_disk` 单元测试。

## 清理

实验节点通过 QMP/ACPI 正常停止后执行 `vm delete --purge`；最终 `state.json` 仅剩
`node1`，实验节点目录和密钥均不存在，主机 QEMU 进程数为 0。

## 边界

本证据是 QEMU/Ubuntu/Docker 基座样本，不是 Android、小红书登录或连续浏览验收；
不能据此宣称 2048 MiB 已适合生产实例。
