# E-064 — Host memory preflight refuses unsafe node start

日期：2026-09-20  
范围：`qemu-center vm start` 的宿主机内存护栏  
环境：Windows，现有 `node1` 配置为 4096 MiB / 4 vCPU；开发版设备中心已运行

## 操作

执行：

```powershell
.\qemu-center\target\debug\qemu-center.exe vm start node1 --state-dir qemu-center/state
```

结果：命令在创建 QEMU 前返回失败：

```text
error: host available memory is too low to start VM "node1": current 1066 MiB, required at least 5120 MiB (VM 4096 MiB + 1024 MiB headroom); release idle instances or choose a smaller node
```

随后检查进程列表，未发现 `qemu-system-x86_64` 或 `qemu-system-aarch64` 进程。

## 结论

- 宿主机可用内存不足时，启动请求会在 QEMU 创建前 fail-closed。
- 预留 1 GiB headroom，避免为了启动 4 GiB 节点把 Windows/WSL 推入临界压力。
- 本次没有启动 QEMU、没有写入或停止 `node1`，也没有触碰 qcow2 活盘。
- 这验证的是启动安全闸门，不代表 node1 的真实业务登录、浏览或稳定性已通过。

