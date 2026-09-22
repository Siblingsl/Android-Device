# E-048 — memory-first lifecycle default

日期：2026-09-18

## 变更

依据 E-047：停止 redroid 容器可以降低 guest current，但保持 QEMU 温热时，QEMU working set
基本不变。因此新安装或缺失 `runtimeKeepVmWarm` 的配置现在默认 `false`，闲置释放在已有的
新鲜只读实例列表证明节点为空后才停止 QEMU；显式保存 `true` 的用户配置不被覆盖。

## TDD 证据

- 先加入 `AppSettings` 缺省值、旧 JSON 缺失字段和显式 `true` 的失败测试；旧默认值使
  `runtime_keep_vm_warm_defaults_to_memory_first` 失败。
- 先加入 `LifecyclePolicy` 缺省值、旧 JSON 缺失字段和显式 `true` 的失败测试；旧默认值使
  `lifecycle_policy_defaults_to_memory_first_but_preserves_explicit_warm_setting` 失败。
- 实现最小默认值改动后，以上 Rust focused tests 全部通过。
- 设置页 focused suite：`src/pages/Settings.test.tsx`，6/6 通过；缺失前端字段显示为关闭。

## 当前门禁

- `npx tsc --noEmit`：通过。
- `npx vitest run`：60 文件、459 用例通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：282 通过、1 忽略、0 失败。
- `cargo test --manifest-path qemu-center/Cargo.toml`：213 个库测试 + 6 个命令行测试通过。
- `cargo test --manifest-path authorization-service/Cargo.toml`：22 个库测试、2 个管理工具测试、2 个启动配置测试、3 个集成测试通过。
- `npm run build`：成功；仅保留既有的大 chunk 体积警告。

## 安全边界

此变更没有放宽共享节点停止条件：状态未知、探针失败或仍有其它运行实例时仍 fail-closed，
不会停止 QEMU。温热节点仍可由高级设置显式开启。
