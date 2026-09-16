# Beta CI 与 Windows 发布骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pull Request 有完整质量门，让版本 tag 能稳定产出可验证的 Windows x64 NSIS 安装包、校验和和草稿 Release。

**Architecture:** 保留现有 `quality.yml` 作为 PR 质量工作流，补齐两个 Rust crate 的测试；新增只在 tag/手动触发的 Windows 发布工作流。正式签名和自动更新作为独立门，未配置密钥时不伪装成已签名发布。

**Tech Stack:** GitHub Actions、Node.js、Rust/Cargo、Tauri CLI、PowerShell、GitHub CLI。

**Spec:** `docs/superpowers/specs/2026-09-16-open-source-beta-productization-design.md`

## Global Constraints

- 正式 Beta 首先只发布 Windows x64 NSIS。
- Release workflow 必须检查 tag 与 package、Tauri、`src-tauri` 和 `qemu-center` 的版本一致性。
- 发布包不包含 Docker Desktop、Redroid 镜像或 GApps zip。
- 未配置正式签名证书、公钥和 endpoint 时，只生成明确标注的未签名构建，不宣传自动更新。
- CI 使用 lockfile 安装；失败步骤必须阻止上传不完整产物。
- 后端源代码不在本计划中修改。

## File Map

- Modify: `.github/workflows/quality.yml` — 补齐 qemu-center 测试和统一质量门。
- Create: `.github/workflows/windows-release.yml` — Windows x64 构建、校验和、草稿 Release。
- Modify: `.github/workflows/macos-package.yml` — 改为实验性手动工作流，避免与 Windows Beta 支持声明混用。
- Create: `scripts/check-release-version.mjs` — 检查 tag 与四个版本来源一致。
- Create: `scripts/check-release-version.test.mjs` — 用 Node 内置测试验证版本脚本的成功和拒绝路径。
- Create: `docs/release-checklist.md` — 发布前人工和 CI 清单。
- Reference only: `scripts/tauri-release-build.mjs` — 保留现有 updater endpoint/pubkey 强制校验。

### Task 1: 补齐 PR 质量工作流

**Files:**
- Modify: `.github/workflows/quality.yml`

**Interfaces:**
- Consumes: `package-lock.json`、`src-tauri/Cargo.lock`、`qemu-center/Cargo.lock`。
- Produces: 每个 PR 都验证前端、主后端和 QEMU crate。

- [ ] **Step 1: 增加 qemu-center Rust job**

新增独立 job，使用稳定 Rust 和 `cargo test --locked --manifest-path qemu-center/Cargo.toml`；保持它与 `src-tauri` job 分离，避免根目录 Cargo workspace 误影响构建。

- [ ] **Step 2: 明确前端命令**

保留 `npm ci --ignore-scripts`、`npm audit --audit-level=moderate`、`npm test` 和 `npm run build`；前端测试命令使用仓库脚本，确保调用 Vitest 的 run 模式。

- [ ] **Step 3: 校验 YAML 结构**

在本地执行：

```powershell
git diff --check
rg -n "qemu-center/Cargo.toml|src-tauri/Cargo.toml|npm test|npm run build" .github/workflows/quality.yml
```

- [ ] **Step 4: 提交**

```powershell
git add .github/workflows/quality.yml
git commit -m "ci: 补齐双 Rust crate 质量门"
```

### Task 2: 添加版本一致性检查脚本

**Files:**
- Create: `scripts/check-release-version.mjs`
- Create: `scripts/check-release-version.test.mjs`
- Read: `package.json`
- Read: `src-tauri/tauri.conf.json`
- Read: `src-tauri/Cargo.toml`
- Read: `qemu-center/Cargo.toml`

**Interfaces:**
- Consumes: 一个形如 `v0.1.0` 的 tag 参数。
- Produces: 版本一致时退出码 0；缺少 `v`、不是 SemVer 或任一版本不一致时退出码 1，并打印具体文件和版本。

- [ ] **Step 1: 写失败检查场景**

在 `scripts/check-release-version.test.mjs` 使用 `node:test` 和 `node:assert/strict`，先定义对导出函数的断言：`validateTag("v0.1.0", versions)` 返回 `{ ok: true, errors: [] }`；缺少 `v`、版本不一致、字段为空分别返回 `ok: false`，并在 `errors` 中指出对应来源。测试只使用 Node 内置模块，不增加依赖。

- [ ] **Step 2: 实现读取和比较**

在 `scripts/check-release-version.mjs` 导出 `readVersions(repoRoot)` 和 `validateTag(tag, versions)`；CLI 入口从仓库根目录解析四个版本来源，将 tag 去掉前缀 `v` 后逐一比较。错误输出包含来源名称和实际值，禁止静默使用默认版本。

- [ ] **Step 3: 本地验证**

```powershell
node scripts/check-release-version.mjs v0.1.0
node scripts/check-release-version.mjs 0.1.0
node --test scripts/check-release-version.test.mjs
```

期望：第一个退出 0，第二个退出非 0，测试全部通过；不要为验证修改任何版本文件。

- [ ] **Step 4: 提交**

```powershell
git add scripts/check-release-version.mjs
git add scripts/check-release-version.test.mjs
git commit -m "ci: 增加发布版本一致性检查"
```

### Task 3: 建立 Windows x64 发布工作流

**Files:**
- Create: `.github/workflows/windows-release.yml`

**Interfaces:**
- Consumes: tag、现有 Tauri 配置、`scripts/check-release-version.mjs` 和 package lock。
- Produces: NSIS `.exe`、`SHA256SUMS.txt`、构建日志和草稿 Release。

- [ ] **Step 1: 设置触发器和权限**

工作流只使用 `push.tags: ["v*.*.*"]` 和带必填 `version` 输入的 `workflow_dispatch`；设置 `contents: write` 仅为创建草稿 Release，其他权限保持只读。每次运行固定 `windows-latest`、Node 20、Rust stable 和 timeout。tag 运行使用 `GITHUB_REF_NAME`，手动运行使用输入的 `version`。

- [ ] **Step 2: 设置构建步骤**

按顺序执行：checkout、Node/Rust 安装、`npm ci --ignore-scripts`、用 tag 或手动输入调用版本一致性脚本、`npx tsc --noEmit`、`npx vitest run`、两套 `cargo test --locked`、`npm run build`、`npx tauri build --bundles nsis`。

- [ ] **Step 3: 验证 NSIS 产物**

使用 PowerShell 在 `src-tauri/target/release/bundle/nsis/` 查找 `.exe`；找不到或找到多个无法确定的安装包时令 job 失败。将安装包复制到单独 staging 目录，避免把 target 下其他历史文件上传。

- [ ] **Step 4: 生成校验和**

使用 `Get-FileHash -Algorithm SHA256` 对 staging 内每个发布文件生成 `SHA256SUMS.txt`，文件名使用相对 staging 路径，确保用户可以在下载目录复核。

- [ ] **Step 5: 上传 Artifact 并创建草稿 Release**

上传 NSIS 包、校验和和版本检查输出；tag 构建使用 GitHub CLI 创建草稿 Release，标题包含 tag，说明文件引用 `docs/release-checklist.md` 的发布说明结构。未签名构建必须在名称和说明中明确写 `unsigned`。

- [ ] **Step 6: 在工作流中防止误启用自动更新**

不要调用 `npm run tauri:build:release`，除非 endpoint 和 pubkey secrets 同时存在并通过脚本校验；初版 Windows workflow 使用普通 `npx tauri build --bundles nsis`，并在 Release 说明中写明自动更新尚未启用。

- [ ] **Step 7: 提交**

```powershell
git add .github/workflows/windows-release.yml
git commit -m "ci: 增加 Windows Beta 发布流水线"
```

### Task 4: 隔离 macOS 实验性发布

**Files:**
- Modify: `.github/workflows/macos-package.yml`

- [ ] **Step 1: 修改工作流名称和触发器**

将名称改为 `Experimental macOS package`，移除 push 自动触发，仅保留 `workflow_dispatch`；这样 macOS 不会在 Windows Beta tag 发布时被误解为正式支持包。

- [ ] **Step 2: 保留独立产物验证**

保留现有 macOS 测试和构建步骤，但 Artifact 名称和 workflow summary 明确为 experimental；不要让它成为 Windows Release job 的 required dependency。

- [ ] **Step 3: 提交**

```powershell
git add .github/workflows/macos-package.yml
git commit -m "ci: 将 macOS 包标为实验性"
```

### Task 5: 写发布检查清单

**Files:**
- Create: `docs/release-checklist.md`

- [ ] **Step 1: 写发布前检查**

清单固定包含：版本号一致、变更记录、兼容性矩阵、四套 CI、Windows x64 安装包、NSIS 安装/卸载、SHA-256、已知问题、回滚路径、签名状态和 updater 状态。

- [ ] **Step 2: 区分三道发布门**

用明确章节区分“构建门”“签名门”“升级门”；签名或升级未完成时写“未启用”，不使用“即将支持”代替实际状态。

- [ ] **Step 3: 提交**

```powershell
git add docs/release-checklist.md
git commit -m "docs: 增加 Beta 发布检查清单"
```

### Task 6: 执行本地发布前验证

**Files:**
- Test: `.github/workflows/quality.yml`
- Test: `.github/workflows/windows-release.yml`
- Test: `scripts/check-release-version.mjs`
- Test: `scripts/check-release-version.test.mjs`

- [ ] **Step 1: 检查差异和关键步骤**

```powershell
git diff --check
git status --short
rg -n "windows-latest|qemu-center/Cargo.toml|SHA256|nsis|unsigned|workflow_dispatch" .github/workflows scripts docs/release-checklist.md
node --test scripts/check-release-version.test.mjs
```

- [ ] **Step 2: 运行四套项目验证**

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

- [ ] **Step 3: 记录 GitHub Actions 首次运行**

首次 tag/手动运行后检查：构建产物路径、版本、SHA-256、草稿 Release 和 unsigned 文案；任何失败都修复 workflow 后重新运行，不手工上传缺步骤的包。
