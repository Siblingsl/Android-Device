# Beta 发布检查清单

本清单用于发布前人工复核。CI 负责构建和上传产物，维护者负责确认支持声明、签名状态和真实安装结果。

## 构建门

- [ ] 版本 tag 使用 `vMAJOR.MINOR.PATCH`，并与 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`qemu-center/Cargo.toml` 一致。
- [ ] PR 质量工作流通过 TypeScript、Vitest、`src-tauri` 测试和 `qemu-center` 测试。
- [ ] Windows x64 NSIS 安装包由 Windows runner 构建，产物路径和版本正确。
- [ ] 安装包有 `SHA256SUMS.txt`，下载后可以独立复核。
- [ ] 构建结果没有打入 Docker Desktop、Redroid 镜像或 GApps zip。
- [ ] Release Notes 写明 Windows x64 Beta、已验证轨道和已知限制。

## 安装与 QA 门

- [ ] 在干净 Windows x64 机器完成安装、启动和卸载。
- [ ] 至少一条轨道完成无 GApps 基础设备创建、ADB 连接和基本控制。
- [ ] Docker 轨道的 Docker Desktop、WSL2/binder、镜像和 ADB 状态有记录。
- [ ] QEMU 轨道的 WHPX、QEMU、cloud image、guest wait、ADB 和日志有记录。
- [ ] Android 13 x86_64 GApps 路径有记录；Android 14 使用 Android 13 GApps 的拒绝提示有记录。
- [ ] Root/LSPosed/Shamiko/Cloak 等高级能力的实际限制有记录，不把模块存在当作完整功能通过。
- [ ] 升级、数据保留、恢复和重新启动有记录。
- [ ] P7-1 真机视觉、导航、键盘和 a11y 走查清单有记录。

## 签名门

- [ ] 当前 Release 明确标记 signed 或 unsigned。
- [ ] 正式签名证书仅来自 GitHub Secrets 或受控发布环境，没有进入仓库和日志。
- [ ] Windows 安全提示和安装行为在干净机器上有记录。
- [ ] 未完成正式签名时，Release 不使用“已签名”“可信安装包”等表述。

## 升级门

- [ ] updater endpoint 和公钥同时配置，并经过配置校验。
- [ ] 普通安装包和升级包版本关系正确。
- [ ] 成功升级、取消升级、网络失败和恢复旧版本均有记录。
- [ ] 自动更新未完成时，客户端默认不宣传或启用自动更新。

## 发布说明必须包含

- 版本和发布日期。
- 新增、修复和已知限制。
- 已验证的平台、轨道、Android 版本和 ABI。
- 安装包下载与 SHA-256。
- 签名和自动更新的真实状态。
- 升级/回滚方式。
- 问题反馈入口和需要附带的环境信息。

正式发布前，把本清单的结果和 `docs/qa/evidence-index.md` 一起作为发布记录保存。
