# E-002 — Authorized encrypted artifact chunks

服务端测试覆盖：

- 设备签名注册与 session nonce 防重放。
- 新 session 撤销同一设备旧 session。
- session、设备、账号 entitlement 和目标 ABI/Android 绑定。
- artifact manifest 由 Ed25519 签名，传输使用每次请求的 X25519 ephemeral key、HKDF-SHA256 和 ChaCha20-Poly1305。
- 分块大小固定 256 KiB，客户端验证顺序、完整长度和最终 SHA-256。
- 撤销客户端或 entitlement 后，后续 chunk 请求拒绝。

代码落点：`authorization-service/src/crypto.rs`、`authorization-service/src/routes.rs`、`src-tauri/src/services/authorization.rs`、`src-tauri/src/services/authorization_client.rs`。
