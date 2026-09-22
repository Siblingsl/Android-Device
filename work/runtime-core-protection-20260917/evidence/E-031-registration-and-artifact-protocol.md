# E-031 — 注册、审批、租约与 artifact 交付路由链

日期：2026-09-18

## 覆盖范围

`authorization-service/tests/protocol.rs::registration_stays_pending_until_approval_then_delivers_an_artifact`
通过真实 Axum router 覆盖完整控制链：

1. 新设备调用 `/v1/clients/register`，获得 pending challenge；
2. 设备使用对应 Ed25519 私钥完成 `/v1/clients/register/complete`；
3. 未审批客户端请求 `/v1/sessions` 被拒绝；
4. 管理侧审批客户端并授予 `protected-artifact` entitlement；
5. 客户端取得短 lease；
6. `/v1/artifacts/.../prepare` 返回签名、设备/session/目标绑定的 manifest；
7. 客户端通过 X25519 派生 ChaCha20-Poly1305 密钥，获取并解密 chunk，明文与服务端
   artifact 完全一致。
8. 同一 transfer 的错误设备绑定、错误 bearer、非法 chunk index 和被篡改的 ciphertext
   均被拒绝。

## 结果

- focused integration test：通过
- `cargo test --manifest-path authorization-service/Cargo.toml`：17 个库测试、2 个启动配置测试、3 个集成测试通过
- 既有撤销 chunk 与签名 keyId 轮换集成测试仍通过

测试使用临时 SQLite、临时 artifact 根目录和固定测试密钥，不触碰生产数据、QEMU
状态或真实账号。
