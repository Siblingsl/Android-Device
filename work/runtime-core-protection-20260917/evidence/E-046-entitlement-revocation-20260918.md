# E-046 — 服务端 entitlement 即时撤销

日期：2026-09-18

## 目的

让服务端能够在不等待 lease 自然过期的情况下收回受保护能力，避免复制或逆向后的客户端继续使用已经撤销的核心能力。

## 实现

- `AuthStore::revoke_entitlement(account_id, capability)` 将 entitlement 的 `enabled` 设为 `0`，保留记录而不是删除，便于审计和显式重新授权。
- `rdc-auth-admin entitlement revoke <account-id> <capability>` 已加入运维入口；未启用或不存在时返回失败，不伪造成功。
- 现有 `session_from_headers` 继续在每次受保护请求时检查 entitlement，因此不增加客户端 grace period，也不提供离线回退。

## TDD 与结果

- 先加入 store 测试；聚焦运行按预期因 `revoke_entitlement` 不存在而编译失败。
- 加入最小 store 实现后，store 聚焦测试通过。
- 加入 artifact transfer 撤销测试；第一次运行按预期暴露测试夹具中 router 被 move 的编译错误，修正为 clone 后通过。
- 管理工具 usage 测试先失败，加入命令文档和分支后通过。
- 临时数据库实际执行 `entitlement grant` → `entitlement revoke`，两步均返回成功；临时数据库已删除。

撤销后的 route 回归同时确认：

1. 已建立 lease 的 `/v1/capabilities` 请求返回 `403`。
2. 已建立 transfer 的 artifact chunk 请求返回 `403`。
3. 未撤销前仍能解密并读取原始 artifact chunk，证明测试不是“从未授权过”。

完整门禁：

- `npx tsc --noEmit`：通过
- `npx vitest run`：60 个文件、458 个测试通过
- `cargo test --manifest-path src-tauri/Cargo.toml --quiet`：278 通过、1 忽略、0 失败
- `cargo test --manifest-path qemu-center/Cargo.toml`：213 个库测试 + 6 个 CLI 测试通过
- `cargo test --manifest-path authorization-service/Cargo.toml --quiet`：22 个库测试 + 2 个管理工具测试 + 2 个启动配置测试 + 3 个集成测试通过
- 三个 Rust crate `cargo fmt -- --check`：通过
- `git diff --check`：通过（仅有既有 LF/CRLF 提示）
- release 核心扫描：两个 release 文件均为 `clean`

这项自动化证据不替代生产账号审批、TLS、撤销监控和人工密钥轮换演练。
