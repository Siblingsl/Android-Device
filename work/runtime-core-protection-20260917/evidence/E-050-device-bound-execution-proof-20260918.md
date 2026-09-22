# E-050 — 设备绑定执行证明（2026-09-18）

## 目的

补齐授权验收中“复制 artifact 到另一台设备或改名后不能复用”的密码学边界。

## 实现

- 服务端签发的 `SignedExecutionGrant` 保持只由服务端签名；客户端收到后使用 DPAPI
  保护的设备 Ed25519 私钥，对精确的 base64url grant payload 生成 `device_proof`。
- guest runner 在验签阶段拒绝缺少 `device_proof` 的请求，并把证明原样提交给消费端点。
- 授权服务消费 grant 时，先检查 session/client/device 绑定，再使用注册设备公钥验证
  `device_proof`；证明缺失或错误时不会消费 grant JTI。

## TDD 证据

1. 新增 Python 回归 `test_runner_rejects_execution_grants_without_device_proof`，在未实现
   检查时实际失败：`AssertionError: ValueError not raised`。
2. 新增服务端消费回归：缺少证明返回 403；使用另一把设备私钥签名的复制 grant 返回 403；
   使用当前注册设备私钥签名后返回 204，重复消费返回 409。
3. 实现后验证：

   - `python -m unittest src-tauri/src/services/test_qemu_guest.py`：17/17 通过。
   - `cargo test --manifest-path authorization-service/Cargo.toml execution_grant_is_signed`：通过。
   - `cargo test --manifest-path src-tauri/Cargo.toml client_accepts_an_execution_grant_only_after_binding_it_to_the_active_session`：通过，且返回 grant 带有 `device_proof`。
   - 完整门禁：Vitest `60 文件 / 459 用例`、Tauri `282 通过 / 1 忽略`、qemu-center `213 + 6`、authorization-service `22 + 2 + 2 + 3` 均通过。
   - release 重建后 `scripts/verify-release-core.ps1` 对 Tauri 与 qemu-center 二进制均返回 `clean`。

## 结论

复制加密 artifact、改名或复制服务端 grant 本身不能替代另一台设备的设备私钥。该证据是自动化协议证明；真实跨机器复制、断网和生产 TLS 仍需现场演练。
