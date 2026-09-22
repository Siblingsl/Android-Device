# E-029：独立 qemu-center CLI 启动护栏

**日期**：2026-09-18  
**范围**：`qemu-center vm start`、主机可用内存读取、QMP 启动态检查  
**结果**：代码与自动化验证通过；未启动或修改现有 `node1`

## 审查发现

桌面 Tauri `qemu_vm_start` 已经检查节点 `mem_mib + 1024 MiB` 的主机余量，但
独立 CLI 入口此前直接构造 QEMU argv 并 detached spawn，存在绕过桌面策略的路径。
这与 E-028 中第二个 3072 MiB 节点将主机可用内存压到约 0.25 GiB 的实测风险相同。

## TDD

先加入纯函数测试并确认预期编译失败：

```text
parse_free_physical_memory_kib: missing
parse_meminfo_available_bytes: missing
free_physical_memory_command: missing
should_block_vm_start: missing
```

随后实现最小护栏并通过 focused tests：

- Windows CIM `FreePhysicalMemory` KiB 输出解析，拒绝空值、错误文本和逗号格式。
- Linux `/proc/meminfo` 的 `MemAvailable` KiB 输出解析。
- 节点 `mem_mib + 1024 MiB` 阈值；已知不足拒绝，探针 unknown 保留明确单次启动兼容路径。
- detached spawn 前 QMP `Running`/`Unknown` 均不继续启动；只有明确 stopped 才进入后续流程。

## 当前实现边界

- Windows 主机通过无副作用 CIM 命令读取可用物理内存。
- Linux 主机读取内核 `MemAvailable`；其他平台保持 unknown，不猜测安全余量。
- 内存探针不可用时 CLI 会明确输出 warning；这保留了旧的单次显式启动兼容语义，
  不把 unknown 当成零或无限资源。
- 不停止进程、不修改 qcow2、不修改节点注册表；桌面端仍负责进程内并发串行化。

## 验证

- focused parser/policy tests：通过
- `cargo fmt --manifest-path qemu-center/Cargo.toml -- --check`：通过
- 完整 qemu-center：211 个库测试 + 6 个 CLI 测试通过
- 现有状态目录只读复核：仍只有 `node1`，没有创建实验节点

完整项目门禁：

- `npx tsc --noEmit`：通过
- `npx vitest run --reporter=dot`：60 个文件、457 个用例通过
- `cargo test --manifest-path src-tauri/Cargo.toml`：271 通过、1 忽略
- `cargo test --manifest-path qemu-center/Cargo.toml`：211 个库测试、6 个 CLI 测试通过
- `cargo test --manifest-path authorization-service/Cargo.toml`：16 库测试、2 启动配置测试、2 集成测试通过
- `cargo fmt --manifest-path qemu-center/Cargo.toml -- --check`：通过
- `git diff --check`：通过（仅有既存的 LF/CRLF 转换提示）

真实 3072/4096 MiB 矩阵与生产授权部署仍待人工确认。
