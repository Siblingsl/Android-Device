# E-008 — Authorization protocol integration

日期：2026-09-17  
范围：授权服务跨 crate HTTP 路由集成测试。

## 结果

- `cargo test --manifest-path authorization-service/Cargo.toml --test protocol`
  通过：2 个测试、0 失败。
- `revoked_session_cannot_receive_a_new_artifact_chunk` 走过真实的
  session → artifact prepare → transfer chunk 路由；撤销客户端后，旧
  transfer 返回 `403 Forbidden`。
- `restarted_service_uses_the_new_signing_key_id` 使用新 Ed25519 私钥重建
  服务状态，真实 session 响应携带新的 `keyId`，为客户端多公钥信任环的
  轮换窗口提供服务端侧契约证据。

## 边界

测试使用内存数据库和临时 artifact 根目录，不代表生产账号、TLS、secret
manager 或真实客户端安装包已经上线验收；这些仍需人工部署演练。
