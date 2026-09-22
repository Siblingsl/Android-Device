# E-005 — Android app/process memory breakdown

**采集性质**：对现有 `r13` 的只读 ADB 观察；没有 force-stop、清数据、修改包状态或停止 QEMU。

## 观测（2026-09-17）

- `adb -s 127.0.0.1:24501 shell ps -A -o PID,PPID,RSS,NAME` 显示 `com.xingin.xhs` 共有 **13 个进程**。
- 这些进程 RSS 合计约 **3,980,504 KiB（3.80 GiB）**。RSS 会重复计算共享页，只用于判断构成，不能与 cgroup current 直接相加。
- `dumpsys meminfo com.xingin.xhs` 显示主进程 PSS 约 **501,291 KiB**、RSS 约 **960,808 KiB**；它还有多个业务/推送/长连接进程。
- GApps、Play 商店、Quick Search、`lspd` 等筛选出的 8 个进程 RSS 合计约 **1,087,824 KiB（1.04 GiB）**，同样存在共享页重复计算。

## 结论

当前 full 实例的高内存并非只来自 QEMU 预留；小红书多进程树是主要运行时压力，GApps/Play/Quick Search 与 LSPosed 也构成独立常驻成本。下一步应优先做“无 GApps/无 Magisk 的 lean 对照”和“保留 VM/container、只暂停目标应用进程”的 A/B，而不是继续把 full 容器硬限制压低。

## 复现命令

```text
adb -s 127.0.0.1:24501 shell ps -A -o PID,PPID,RSS,NAME
adb -s 127.0.0.1:24501 shell dumpsys meminfo com.xingin.xhs
```
