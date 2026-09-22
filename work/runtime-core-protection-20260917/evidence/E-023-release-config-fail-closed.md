# E-023 — release 授权配置 fail-closed

日期：2026-09-17

## 目的

确认发布授权客户端不会在缺少服务地址、公钥或使用非安全远端 HTTP 时继续构造
受保护能力客户端。

## 实现

`src-tauri/src/services/authorization_client.rs` 新增无副作用的构建配置解析器：

- 服务地址为空或缺失时拒绝；
- 公钥环缺失、重复 key ID 或非法公钥时拒绝；
- 非回环 HTTP 地址拒绝；
- 回环 HTTP 仅保留本地开发服务例外；
- 只有配置完整且 URL 安全时才构造 HTTP transport 和 Windows secure store。

## 验证

- TDD focused test 首次因解析器不存在而失败；实现后
  `cargo test --manifest-path src-tauri/Cargo.toml services::authorization_client::tests::release_configuration`
  通过，2 个 focused tests 全部通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：270 通过、1 忽略、0 失败。
- `cargo build --manifest-path src-tauri/Cargo.toml --release`：通过（最新重建 6 分 09 秒）。
- `cargo build --manifest-path qemu-center/Cargo.toml --release`：通过。
- Tauri 与 qemu-center release 二进制核心体扫描：未发现内置 guest runner 标记。

## 边界

这项证据证明客户端配置策略和 release 代码路径 fail-closed；生产 TLS、账号审批、
撤销、断网和签名密钥轮换仍需按人工验收清单演练。
