# E-060 — 2048 MiB 节点真实 Redroid lean 启动样本

- 日期：2026-09-20
- 范围：2048 MiB QEMU 节点、真实 Redroid 容器、WHPX/binderfs/Docker/ADB readiness
- 节点：隔离克隆 `matrix2048xhs-20260920`，4 vCPU / 2048 MiB，源 `node1` 未修改
- 容器：`qc-r13`，lean profile，1 vCPU / 1024 MiB，Android 14 image

## 验收结果

`qemu-center verify --vm matrix2048xhs-20260920 --container r13 --json` 结果：

- WHPX：PASS
- SSH：PASS
- binderfs：PASS
- Docker：PASS，server `29.1.3`
- `sys.boot_completed=1`：PASS
- 宿主 ADB `127.0.0.1:24532`：PASS，`getprop` 返回 Android 14
- clone-timing：FAIL（运行中的节点不能再次做 backing clone，属于信息性检查）

## 内存采样

```text
container memory limit:  1,073,741,824 bytes (1024 MiB)
container current:       1,073,524,736 bytes
container peak:          1,073,741,824 bytes
container oom_kills:     0
QEMU working set:        2,219,249,664 bytes (~2.07 GiB)
QEMU private memory:     2,444,263,424 bytes (~2.28 GiB)
host available:          3,592,360 KiB (~3.42 GiB)
```

## 结论边界

2048 MiB 节点能够启动真实 Redroid lean 实例并完成 ADB readiness，但容器 current/peak
已经贴近 1024 MiB 上限；本样本没有安装或验收小红书登录/连续浏览，也没有验证 GApps、
Magisk 或 LSPosed。因此 2048 MiB 只能作为单实例 lean 的低内存实验候选，不能作为
standard/full 或小红书生产推荐；3072 MiB standard 仍是当前较稳妥的推荐起点。
