# 开源 Beta 文档与社区基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让没有项目背景的新用户和贡献者能够从仓库文档完成 Windows x64 安装、选择运行轨道、定位常见问题并提交高质量反馈。

**Architecture:** 以 `README.md` 作为短入口，以 `docs/getting-started/`、`docs/compatibility.md` 和 `docs/troubleshooting.md` 承载渐进式细节。社区规则与 Issue/PR 模板放在根目录和 `.github/`，不修改应用后端行为。

**Tech Stack:** Markdown、GitHub Issue Forms、现有 Tauri/React/Rust 项目文档。

**Spec:** `docs/superpowers/specs/2026-09-16-open-source-beta-productization-design.md`

## Global Constraints

- 首个公开版本定位为 Windows x64 技术 Beta。
- macOS 和 Windows ARM64 只能单独标为实验性，不能出现在正式支持默认路径中。
- 不把 Docker Desktop、Android 镜像或 GApps 强制打进安装包。
- 本计划只修改文档、社区文件和模板，不修改 `src-tauri` 或 `qemu-center` 后端。
- 每阶段结束后执行 `npx tsc --noEmit`、`npx vitest run`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path qemu-center/Cargo.toml`。
- 所有“已验证”表述必须有测试记录、命令输出或真机走查证据；没有证据时使用“实验性”“未验证”或“不支持”。

## File Map

- Modify: `README.md` — 首屏定位、安装入口和支持边界。
- Create: `docs/getting-started/windows-clean.md` — 干净 Windows x64 安装路径。
- Create: `docs/getting-started/docker-track.md` — Docker 轨道路径。
- Create: `docs/getting-started/qemu-whpx-track.md` — QEMU/WHPX 轨道路径。
- Create: `docs/compatibility.md` — 带证据等级的兼容性矩阵。
- Create: `docs/troubleshooting.md` — 按症状组织的故障排查。
- Create: `CONTRIBUTING.md` — 贡献、测试和后端授权规则。
- Create: `SECURITY.md` — 私下报告安全问题和敏感信息处理。
- Create: `CHANGELOG.md` — Beta 版本变更记录入口。
- Create: `.github/ISSUE_TEMPLATE/bug-report.yml` — 功能故障模板。
- Create: `.github/ISSUE_TEMPLATE/environment.yml` — 安装和环境问题模板。
- Create: `.github/ISSUE_TEMPLATE/feature-request.yml` — 功能建议模板。
- Create: `.github/pull_request_template.md` — PR 变更与验证清单。

### Task 1: 收敛 README 首屏与支持声明

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-09-16-open-source-beta-productization-design.md`

**Interfaces:**
- Consumes: 当前 README 的 Docker、Binder、Root、GApps、国际化和开发章节。
- Produces: 新用户可从首屏进入 Windows 安装文档，并能区分 Docker 和 QEMU/WHPX。

- [ ] **Step 1: 先写文档结构检查**

在仓库根执行以下检查，记录当前入口和冲突位置：

```powershell
rg -n "启动|前置依赖|Docker|QEMU|WHPX|macOS|ARM64|GApps|安装包|贡献|故障" README.md
```

- [ ] **Step 2: 重写首屏信息架构**

将首屏调整为：项目定位、Beta 支持范围、两条轨道选择、Windows 安装入口、首台设备成功路径、文档索引。保留已有能力表，但把 Root、局域网扫描、Binder 内核和开发细节放到入口之后。

- [ ] **Step 3: 统一支持边界文案**

明确 Windows x64 为正式 Beta 目标；macOS 和 Windows ARM64 使用“实验性/未完成矩阵验证”措辞；明确 GApps 当前仅有 Android 13 x86_64 资产，Android 14 不兼容时必须按限制说明。

- [ ] **Step 4: 检查并提交首屏改动**

运行：

```powershell
git diff --check
rg -n "Windows x64|Docker 轨道|QEMU/WHPX|兼容性矩阵|故障排查" README.md
```

提交：

```powershell
git add README.md
git commit -m "docs: 收敛 Beta README 入口"
```

### Task 2: 编写三条安装路径

**Files:**
- Create: `docs/getting-started/windows-clean.md`
- Create: `docs/getting-started/docker-track.md`
- Create: `docs/getting-started/qemu-whpx-track.md`

**Interfaces:**
- Consumes: `README.md`、`qemu-center/README.md`、`scripts/README-WSL-KERNEL.md` 和当前应用内设置/体检行为。
- Produces: 每条路径都有前置条件、步骤、成功标志、权限/重启提示和恢复路径。

- [ ] **Step 1: 写 Windows 干净机器文档**

按以下固定章节写入 `windows-clean.md`：适用范围、最低准备、安装包安装、首次启动、环境检查、选择轨道、首台设备成功、卸载/重新安装、收集问题信息。每一步都写出可观察的成功标志，不使用“按需配置”这类无法执行的描述。

- [ ] **Step 2: 写 Docker 轨道文档**

在 `docker-track.md` 中明确 Docker Desktop、WSL2/binder、ADB、scrcpy、Redroid 镜像、GApps 13 x86_64 的关系；说明切换自定义 binder 内核后需要重新打开 Docker Desktop；说明删容器与删数据卷的区别。

- [ ] **Step 3: 写 QEMU/WHPX 轨道文档**

在 `qemu-whpx-track.md` 中明确 WHPX 是 Windows 系统功能、启用后需要重启；QEMU 可以便携安装；Ubuntu cloud image 需要下载和校验；QEMU 节点停止使用优雅关机；把 `qemu.log`、`console.log` 和 `verify` 的含义写清楚。

- [ ] **Step 4: 统一命令和路径示例**

所有命令示例使用仓库现有入口：`npm run tauri dev`、`npm run tauri build`、`qemu-center` 的独立 manifest 命令和 `scripts/` 中已有脚本；不新增与现有脚本重复的一键命令。

- [ ] **Step 5: 加入统一文档索引**

在安装文档已经创建后，把以下相对链接加入 README，并确认每个目标存在：

```markdown
[Windows 干净机器安装](docs/getting-started/windows-clean.md)
[Docker 轨道](docs/getting-started/docker-track.md)
[QEMU/WHPX 轨道](docs/getting-started/qemu-whpx-track.md)
[兼容性矩阵](docs/compatibility.md)
[故障排查](docs/troubleshooting.md)
[贡献指南](CONTRIBUTING.md)
```

- [ ] **Step 6: 链接与措辞检查**

运行：

```powershell
git diff --check
rg -n "待补|稍后|无法处理" docs/getting-started
```

期望：没有占位措辞；文档中的文件路径都能在仓库中找到，外部下载地址明确标出其上游来源和版本边界。

- [ ] **Step 7: 提交**

```powershell
git add docs/getting-started
git add README.md
git commit -m "docs: 增加 Windows 与双轨安装指南"
```

### Task 3: 建立兼容性矩阵与排障索引

**Files:**
- Create: `docs/compatibility.md`
- Create: `docs/troubleshooting.md`

**Interfaces:**
- Consumes: `scripts/platform-assets.json`、`qemu-center/README.md`、当前 GApps/Magisk 资产说明和续接文档中的真机证据。
- Produces: 用户可以从环境组合或症状找到明确结论和下一步。

- [ ] **Step 1: 建立矩阵字段**

`compatibility.md` 必须包含：主机系统、CPU/虚拟化、运行轨道、Docker/WSL2、WHPX/QEMU、ADB/scrcpy、Android 版本、ABI、GApps、Root 模块和发布包。每行包含“状态”“验证环境”“证据链接/记录”“限制”。

- [ ] **Step 2: 写入已有证据**

把当前真机 QEMU 7/7、升级/恢复耗时、Android 13 GApps、Android 14 GApps 拒绝、WHPX CPU 参数和 QEMU 串口日志写成带边界的记录；未由真机验证的内容标为“命令拼装已测，运行时未验证”。

- [ ] **Step 3: 建立症状索引**

`troubleshooting.md` 至少覆盖：Docker 引擎不可用、binder 缺失、容器 Up 但 ADB offline、GApps 版本不匹配、WHPX 卡死、QEMU 磁盘损坏风险、SSH/guest wait 失败、scrcpy 不可用、升级失败和数据恢复。

- [ ] **Step 4: 每个症状采用固定格式**

固定写成“现象 → 可能原因 → 先做什么 → 如何确认 → 如何收集日志 → 不能做什么”。明确不要硬杀 QEMU、不要向 fstab 写 binderfs、不要把 Android 13 GApps 用于 Android 14。

- [ ] **Step 5: 提交**

```powershell
git add docs/compatibility.md docs/troubleshooting.md
git commit -m "docs: 建立兼容性矩阵与排障指南"
```

### Task 4: 建立贡献、安全和问题反馈入口

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `.github/ISSUE_TEMPLATE/bug-report.yml`
- Create: `.github/ISSUE_TEMPLATE/environment.yml`
- Create: `.github/ISSUE_TEMPLATE/feature-request.yml`
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: `AGENTS.md` 的验证命令、后端授权规则和项目两轨结构。
- Produces: 贡献者能够复现、验证和安全报告，而维护者能区分功能缺陷与环境问题。

- [ ] **Step 1: 写 CONTRIBUTING.md**

包含仓库结构、分支/提交约定、前端和两套 Rust 验证命令、先文档后代码、真机/视觉结论必须人工确认、`src-tauri`/`qemu-center` 后端改动需要显式授权。

- [ ] **Step 2: 写 SECURITY.md**

说明不要提交私钥、设备日志、代理配置、GApps/Magisk 私有资产和个人路径；Root/隐藏能力仅限授权内部 App 测试；安全问题不要通过公开 Issue 发送敏感细节。

- [ ] **Step 3: 写 CHANGELOG.md**

建立 `Unreleased`、`0.1.0 Beta` 两个章节，明确记录新增、修复、限制、升级注意事项，不把尚未验证的功能写入已完成列表。

- [ ] **Step 4: 写 Issue Forms**

Bug 模板收集复现步骤、期望/实际结果、轨道、应用版本、Windows 版本、依赖版本、日志路径和截图；environment 模板额外收集 doctor/readiness 结果；feature 模板收集使用场景和轨道影响。

- [ ] **Step 5: 写 PR 模板**

包含变更范围、是否涉及后端、四套验证结果、是否需要真机走查、是否修改支持声明/兼容性矩阵、是否包含用户可见文案。

- [ ] **Step 6: 提交**

```powershell
git add CONTRIBUTING.md SECURITY.md CHANGELOG.md .github/ISSUE_TEMPLATE .github/pull_request_template.md
git commit -m "docs: 建立贡献与问题反馈规范"
```

### Task 5: 完成文档阶段验证

**Files:**
- Test: all Markdown files created by Tasks 1–4

- [ ] **Step 1: 检查工作区和 Markdown 差异**

```powershell
git diff --check
git status --short
```

期望：没有空格/换行错误；只有计划内文件变更。

- [ ] **Step 2: 检查关键支持声明**

```powershell
rg -n "Windows x64|实验性|未验证|Android 13|Android 14|不要硬杀|后端改动" README.md docs CONTRIBUTING.md SECURITY.md
```

- [ ] **Step 3: 运行项目基线验证**

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

- [ ] **Step 4: 记录并提交验证结果**

将验证结果和未执行的真机项目写入 PR 描述；文档阶段不把自动化全绿当作视觉或真机通过证据。
