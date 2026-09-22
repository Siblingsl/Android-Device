# E-028：QEMU 节点启动内存预检查

**日期**：2026-09-17  
**范围**：桌面端 Tauri `qemu_vm_start`、QEMU 节点启动前置检查  
**结果**：自动化通过；真实多节点矩阵仍待人工确认

## 触发背景

为验证 3072 MiB 节点的低内存档案，创建了隔离实验节点 `matrix3072v2`：2 vCPU、
3072 MiB、WHPX，使用绝对路径引用既有 base image。原有 `node1` 保持运行且未修改。
实验节点完成 guest readiness 后，启动测试实例的 SSH/Docker 操作被中断；期间主机可用
内存下降到约 **0.25 GiB**，说明桌面端直接启动第二个较大 QEMU 节点时，现有实例级
调度器并不能覆盖 VM 的 `-m` 提交成本。

实验随后通过 qemu-center 的 `vm stop` 走 ACPI/QMP 正常停止，并使用精确的
`vm delete --purge` 清理实验节点目录和对应两份临时 SSH key。清理后的只读复核为：

- QEMU 进程数：1（仅原有 `node1`）
- 主机可用内存：约 3.47 GiB
- 原有 `node1/r13`：仍在运行；未执行在线缩容、强制杀进程或 qcow2 离线写入

## 实现

Tauri 的 `qemu_vm_start` 现在在调用 QEMU 前：

1. 读取已登记节点的 `mem_mib`；
2. 读取主机可用内存快照；
3. 在进程级互斥锁下串行化检查和启动；
4. 当可用内存已知低于 `节点 mem_mib + 1024 MiB` 时拒绝启动并给出释放闲置实例
   或选择 lean/standard 的提示；
5. 资源探针为 unknown 时保留原有一次明确启动兼容路径，不把 unknown 当作安全余量。

该护栏不改变 QEMU 参数、不停止运行中的节点，也不覆盖独立执行的 qemu-center CLI；
后者没有桌面端主机资源探针，应另行设计 CLI 侧策略。

## TDD 与验证

先加入纯策略测试并确认预期失败：缺少 `should_block_qemu_vm_start` 时编译失败。
随后实现最小规则并通过 focused test：

```text
cargo test --manifest-path src-tauri/Cargo.toml commands::tests::qemu_vm_start_requires_requested_memory_headroom -- --exact
1 passed; 0 failed; 271 filtered out
```

`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过。完整项目门禁也通过：

- `npx tsc --noEmit`：通过
- `npx vitest run --reporter=dot`：60 个文件、457 个用例通过
- `cargo test --manifest-path src-tauri/Cargo.toml`：271 通过、1 忽略
- `cargo test --manifest-path qemu-center/Cargo.toml`：207 库测试、6 CLI 测试通过
- `cargo test --manifest-path authorization-service/Cargo.toml`：16 库测试、2 启动配置测试、2 集成测试通过
- `git diff --check`：通过（仅有既存的 LF/CRLF 转换提示）

人工 3072/4096 MiB × lean/standard/full 登录、浏览、稳定性矩阵和服务端生产部署验收
仍保持未完成。
