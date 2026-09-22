# E-024 — 当前主机内存归因快照

日期：2026-09-17

## 采样范围

只读采样 Windows 主机、QEMU/WSL/Docker 进程，以及 guest 内 `qc-r13` 的
cgroup 统计；没有停止、重启、删除或修改任何节点/容器。

## 快照

| 项目 | 结果 |
|---|---:|
| 主机物理内存 | 约 15.73 GiB |
| 主机可用物理内存 | 约 3.90 GiB |
| `qemu-system-x86_64` 工作集 | 约 718 MiB |
| `qemu-system-x86_64` 私有提交 | 约 4.34 GiB（约 4.66 GB） |
| `vmmemWSL` 工作集 | 约 790 MiB |
| `vmmemWSL` 私有提交 | 约 1.76 GiB |
| Docker backend 工作集 | 约 145 MiB |
| `qc-r13` guest current / limit | 约 2.92 / 3.00 GiB |
| `qc-r13` peak / OOM | 约 3.00 GiB / 0 |

## 结论

“6–8GB”主要来自 QEMU 与 WSL 的私有提交，再叠加 Docker、桌面应用和系统开销；
它不是一个 redroid 实例单独常驻 6–8GB。Windows 提交量、工作集、guest cgroup
current 不能直接相加，也不能互相替代。

当前最有效的优化仍是：新节点优先 `lean`/`standard`、闲置应用暂停、实例按需
启动，以及避免同时启动多个 Android 实例。`full` 档在当前 `qc-r13` 上已经接近
3GiB 容器上限，不应继续盲目降低上限。
