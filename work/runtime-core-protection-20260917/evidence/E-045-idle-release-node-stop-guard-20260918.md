# E-045 — 闲置释放的共享节点停止护栏

日期：2026-09-18

## 发现

`runtime_release_idle` 在 `keepVmWarm=false` 时，停止目标 redroid 容器后会直接调用 `vm_stop`。同一 QEMU 节点上若还有其它实例运行，这会误停共享节点。

## 修复

- 停止目标容器后，先通过已有的只读 `redroid_list_basic` 读取同一节点实例状态。
- 只有当列表中除目标外没有 `Up`/`running` 实例，才允许停止 QEMU 节点。
- 其它实例为运行中、状态为空/`unknown`、或只读探针失败时，均 fail-closed：只释放目标容器，保持节点运行。
- `keepVmWarm=true` 不增加额外探针，也不会停止节点。
- 没有引入停止或重启其它实例的隐式动作。

## TDD 与验证

先加入 `idle_release_only_stops_an_empty_node` 测试并运行聚焦命令，按预期因策略 helper 尚不存在而编译失败；实现最小策略 helper 与调用护栏后，同一聚焦测试通过。

本轮完整门禁：

- `npx tsc --noEmit`：通过
- `npx vitest run`：60 个文件、458 个测试通过
- `cargo test --manifest-path src-tauri/Cargo.toml`：278 通过、1 忽略、0 失败
- `cargo test --manifest-path qemu-center/Cargo.toml`：213 个库测试 + 6 个命令行测试通过
- `cargo test --manifest-path authorization-service/Cargo.toml`：21 个库测试 + 1 个管理工具测试 + 2 个启动配置测试 + 3 个集成测试通过
- 三个 Rust crate `cargo fmt -- --check`：通过
- `git diff --check`：通过（仅有既有 LF/CRLF 提示）
- 发布二进制核心扫描：两个 release 文件均为 `clean`

本轮未启动或停止真实 QEMU/容器；检查确认没有残留 `qemu-system-x86_64` 或 `authorization-service` 进程。真实登录、连续浏览与 30 分钟稳定性仍需人工验收。
