# E-047 — r13 真实运行时内存样本

日期：2026-09-18

## 范围与安全边界

使用现有 `node1`（4096 MiB / 4 vCPU / WHPX）和现有 `r13` 数据。通过 `qemu-center vm start` 的宿主内存预检查启动；guest readiness 成功后只启动 `qc-r13`，不改节点内存、不删除数据、不登录账号。

结束时先停止容器，再执行 `qemu-center vm stop node1`，由 QMP 请求 ACPI powerdown；约 5 秒后 QEMU 进程退出，未使用强杀。

## 观测

### 1. 容器启动后、调前台应用前

- guest `r13` current：`2,526,941,184` bytes，约 `2.35 GiB`
- guest peak：`2,568,372,224` bytes，约 `2.39 GiB`
- OOM kills：`0`
- QEMU working set：`3,497,615,360` bytes，约 `3.26 GiB`
- QEMU private memory：约 `180.7 MiB`
- `boot_completed=true`

### 2. 调起小红书后

- guest current：`3,173,072,896` bytes，约 `2.96 GiB / 3 GiB`（约 `98.5%`）
- guest peak：`3,221,229,568` bytes，约 `3.00 GiB`
- OOM kills：`0`
- guest CPU：`111.14%`（该字段为 guest/container 采样口径）
- QEMU working set：`3,783,315,456` bytes，约 `3.52 GiB`
- QEMU private memory：约 `197.0 MiB`
- Windows `FreePhysicalMemory`：`507,108 KiB`，约 `0.48 GiB`

### 3. 只 force-stop 小红书，保留容器和 VM

- guest current：`2,300,203,008` bytes，约 `2.14 GiB`
- guest peak：保持约 `3.00 GiB`
- OOM kills：`0`
- guest CPU：`2.19%`
- QEMU working set：`3,782,811,648` bytes，约 `3.52 GiB`
- QEMU private memory：约 `189.2 MiB`
- Windows `FreePhysicalMemory`：`403,052 KiB`，约 `0.38 GiB`

## 结论

1. 当前 full `r13` 在小红书前台时确实逼近 3 GiB guest 上限；不能把这个实例直接压到 1–2 GiB。
2. force-stop 小红书可释放约 `0.81 GiB` guest current，但 QEMU working set 基本不变，不能把应用暂停当作宿主内存释放方案。
3. 3072 MiB 节点的 `standard / 2048 MiB` 仍是更合理的下一候选；lean 1536 MiB 继续作为低占用基线，不应在登录/浏览前直接定为业务默认。
4. 本样本只覆盖启动、调前台和 force-stop，不覆盖登录、连续浏览或 30 分钟稳定性；这些仍是人工验收项。
