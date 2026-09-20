# E-057：公钥信任环轮换聚焦测试

**日期**：2026-09-20
**范围**：Tauri 授权客户端构建期公钥信任环解析
**性质**：代码级证据，不替代生产轮换演练

## 验证命令

```powershell
cargo test --manifest-path src-tauri/Cargo.toml authorization_client::tests::public_key_ring -- --nocapture
```

## 结果

- `public_key_ring_accepts_old_and_new_keys_for_rotation`：通过
- `public_key_ring_rejects_duplicate_ids_and_malformed_keys`：通过
- 聚焦结果：**2 passed / 0 failed**
- Tauri 主测试套件其余 **294 个用例被过滤**，未执行额外修改

## 证明的边界

- 客户端能解析旧/新公钥并同时建立信任环。
- 重复 key id、非法公钥和空信任环会被拒绝。
- 这不证明真实服务端已经完成密钥切换，也不证明生产 runner 已按新公钥重新发布；
  生产步骤仍必须按 `docs/ops/authorization-key-rotation-runbook.md` 执行并留存记录。
