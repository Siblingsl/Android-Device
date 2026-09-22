# E-026 — 授权服务边界加固

日期：2026-09-17

## 目的

降低受保护租约、manifest 和加密分块被中间缓存的风险，并限制未完成 artifact
transfer 在授权服务进程内的状态增长。

## 实现

- Axum `/v1` 路由统一添加 `Cache-Control: no-store` 和 `Pragma: no-cache`。
- `AppState::new` 的临时 transfer 上限为 128；prepare 在读取 artifact 文件前先回收
  过期条目并检查容量，达到上限返回 HTTP 503 `transfer_capacity_exhausted`。
- chunk 读取路径继续回收过期 transfer；默认客户端设备绑定、租约、撤销、目标和 AEAD
  校验规则未改变。

## TDD 与验证

- `protected_responses_are_not_cacheable` 首次因缺少响应 header 失败，加入 middleware
  后通过。
- `transfer_capacity_is_enforced_before_new_transfer` 首次因缺少 `with_transfer_limit`
  接口无法编译；实现后验证容量满时拒绝第二个 transfer，并在把首个 transfer 标记过期
  后成功接纳新 transfer。
- `cargo fmt --manifest-path authorization-service/Cargo.toml -- --check`：通过。
- `cargo test --manifest-path authorization-service/Cargo.toml`：16 单元 + 2 集成通过。
- 项目门禁：TypeScript 通过；Vitest 60 文件 / 457 用例通过；Tauri 270 通过 / 1 忽略；
  qemu-center 207 库 + 6 CLI 通过；`git diff --check` 通过（仅换行风格提示）。

生产 TLS、secret manager、真实账号审批、密钥轮换和真机走查仍属于人工上线验收，
本证据不替代这些外部条件。
