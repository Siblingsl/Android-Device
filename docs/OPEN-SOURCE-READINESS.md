# 开源发布准备状态

更新时间：2026-09-21

## 当前结论

代码可以继续作为 Windows x64 Beta 候选维护，但当前仓库不应直接公开或作为正式发行版发布。根目录许可证、第三方资产再分发权、依赖审计和发布签名仍有人工决策或环境依赖。

## 本轮已完成

- 移除了已跟踪的 `Reference_Projects/escrcpy/desktop/.env`。
- 增加 `Reference_Projects/escrcpy/desktop/.env.example`，并在根 `.gitignore` 中忽略环境文件。
- 应用不带 `--force` 的 `npm audit fix`，并将 Vitest 升级到兼容 Node 20/Vite 7 的 `4.1.11`；当前 npm 依赖审计为 0 个问题。
- 将 `@testing-library/dom` 显式列为测试依赖，避免依赖 npm 的隐式 peer 安装行为。
- 记录了第三方资产、密钥和发布门禁的剩余边界。

## 维护者必须完成

### P0：公开前必须完成

1. 选择并提交根目录开源许可证，同时在 `package.json`、Rust crate 和发布说明中保持一致。不能由自动化工具替维护者选择法律许可证。
2. 如果被删除的 `.env` 中的 Gitee App ID 对应真实应用，先在服务端轮换/注销，再清理 Git 历史中的旧值。当前工作树删除文件不能清除历史提交。
3. 决定是否公开和再分发以下已跟踪制品；没有明确许可证、NOTICE 或上游再分发授权的制品应从公开仓库移除：
   - `target/rdc-preset-test/` 中的 Magisk、LSPosed、Shamiko 和 BusyBox 制品；
   - `vendor/test-apk/DeskClock.apk`；
   - `Reference_Projects/escrcpy/desktop/electron/resources/extra/` 中的多平台 scrcpy/ADB/FFmpeg 等二进制。

### P1：公开前建议完成

1. 为保留的第三方组件增加 `THIRD_PARTY_NOTICES`，记录版本、来源、许可证、校验和和源码获取方式。
2. 保持 `vitest@4.1.11` 与 Node 20+ 约束同步，并在后续依赖升级时重新执行全量测试。
3. 在 CI 增加 Rust 依赖审计、密钥扫描、许可证检查和 SBOM 生成；当前环境没有 `cargo-audit`、`gitleaks`、`osv-scanner`、`syft` 或 `trivy`。
4. 把脚本中的 mutable `latest` 下载改为固定版本和 SHA-256 校验，尤其是 Magisk/LSPosed/Shamiko/WSL 资产。
5. 为正式安装包配置签名证书、升级公钥和回滚记录；当前 Windows release 产物标记为 unsigned。

### P2：发布说明必须明确

- QEMU/WHPX、真实设备、干净 Windows 安装和 30 分钟稳定性矩阵仍需人工验收。
- Root、设备伪装和模块能力只用于授权测试；不能宣传为绝对反逆向或可绕过第三方服务风控。
- `.workbuddy/`、`.playwright-cli/`、`target-codex-*/`、`work/`、本地日志和构建目录不属于公开源码，应在干净发布分支中排除。

## 当前验证

- `npm audit`：0 个漏洞；Vitest 已升级到 `4.1.11`，项目最低 Node 版本同步为 20。
- `npm ci --ignore-scripts`、`npx tsc --noEmit`、全量 Vitest（63 文件/470 用例）和生产构建均通过。
- Rust 依赖审计和完整许可证扫描尚未执行，因为本机工具未安装。
