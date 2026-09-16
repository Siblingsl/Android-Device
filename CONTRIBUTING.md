# 贡献指南

感谢参与 Redroid Device Center。这个项目同时包含 React/Tauri 前端、Rust 后端和独立的 `qemu-center` CLI；提交改动前请先判断它属于哪条轨道。

## 开始前

1. 阅读 [README](README.md)、[兼容性矩阵](docs/compatibility.md) 和[故障排查](docs/troubleshooting.md)。
2. 阅读根目录 `AGENTS.md`，尤其是先读方案、保留用户改动、QEMU 磁盘安全和后端授权规则。
3. 不提交 `vendor` 中被 gitignore 的大体积或第三方资产，不提交个人路径、代理配置、设备日志和密钥。

## 仓库结构

- `src/`：React 页面、组件、i18n、服务桥接和 Zustand 状态。
- `src-tauri/`：Tauri 命令和本机 Docker/ADB/设备服务。
- `qemu-center/`：独立 QEMU/WHPX CLI；不要把根目录变成 Cargo workspace。
- `scripts/`：平台检测、WSL binder 内核和资产准备脚本。
- `docs/`：用户文档、QA 记录、方案和实施计划。

## 提交改动的顺序

对于功能或架构变更：

1. 先在 `docs/superpowers/specs/` 写方案，明确范围、证据和不做什么。
2. 方案确认后在 `docs/superpowers/plans/` 写实施计划。
3. 实现时先写测试，再写最小实现；每个独立阶段单独提交。
4. 涉及视觉、真机、安装或兼容性的结论，必须附人工记录，自动化测试不能代替。
5. 变更支持范围时同步更新 README、兼容性矩阵和变更记录。

## 后端授权边界

修改 `src-tauri/` 或 `qemu-center/` 前，必须取得项目维护者的显式授权。尤其包括 Docker/QEMU 命令、环境体检、镜像/GApps 验证、磁盘/快照、系统功能启用、ADB 和安装动作。

纯前端文案、页面、测试和文档也不能假设后端返回的新字段已经存在；先确认桥接契约，再决定是否需要单独授权。

## 本地验证

提交前必须在仓库根执行：

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

如果改动了构建或发布配置，再执行：

```powershell
npm run build
git diff --check
```

如果改动了 QEMU 运行路径，不要使用 `Stop-Process -Force` 终止 QEMU；按 `qemu-center/README.md` 的优雅停止和日志规则操作。

## Issue 与 PR

- 安装、环境和依赖问题使用环境问题模板，并附 doctor/readiness/verify 结果。
- 功能缺陷写清楚复现步骤、期望结果、实际结果、轨道、版本和日志。
- PR 描述说明是否涉及后端、是否需要真机走查，以及四套验证结果。
- 不要在公开 Issue 中发送私钥、代理凭据、完整设备日志或未脱敏的内部 App 信息。
