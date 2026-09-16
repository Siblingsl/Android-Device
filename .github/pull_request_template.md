## 变更说明

- 变更范围：
- 关联 Issue：
- 用户可见影响：

## 风险边界

- [ ] 未修改 `src-tauri` / `qemu-center` 后端
- [ ] 如修改后端，已取得显式授权并说明命令/数据影响
- [ ] 未改变 Docker 与 QEMU 两条轨道的支持边界
- [ ] 未提交密钥、设备日志、代理凭据或受限资产

## 验证结果

- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo test --manifest-path qemu-center/Cargo.toml`
- [ ] `npm run build`（如改动构建、页面或发布配置）
- [ ] 真机/视觉/a11y 已人工走查，或明确标记为待人工确认
- [ ] 已同步 README、兼容性矩阵、排障文档或 CHANGELOG（如适用）

## 证据

请附测试输出摘要、截图、日志索引或人工 QA 清单路径。不要上传未脱敏敏感信息。
