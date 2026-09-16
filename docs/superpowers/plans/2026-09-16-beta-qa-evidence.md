# Beta 真机 QA 与证据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用干净 Windows x64 和现有真机环境验证安装、双轨首台设备、可选预装、升级回滚和视觉/a11y，并产出可复核的截图、视频和兼容性证据。

**Architecture:** QA 记录与源码同仓保存，运行环境和人工判断分开记录。自动化测试只证明代码行为；QEMU/WHPX、安装、视觉和交互结论必须附人工操作记录。

**Tech Stack:** Windows x64、Docker Desktop、QEMU/WHPX、ADB、scrcpy、现有 Tauri 应用、Markdown、截图/屏幕录制工具。

**Spec:** `docs/superpowers/specs/2026-09-16-open-source-beta-productization-design.md`

## Global Constraints

- 不使用浏览器预览替代 Tauri 真机应用。
- 不用自动化 DOM 断言替代视觉、键盘导航和无障碍人工判断。
- 不硬杀 QEMU；停止、快照、恢复按 `qemu-center/README.md` 的安全边界操作。
- 现有 QEMU 真机 7/7 证据可作为历史基线，但 QEMU CLI 当前版本仍需按清单复核。
- 清单中的“未执行”必须保持未执行，不能为了通过发布门改成“通过”。
- 本计划不修改后端；发现行为问题时先记录 Issue，再按项目规则申请后端授权。

## File Map

- Create: `docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md` — 页面合并 C/D/E 走查。
- Create: `docs/qa/clean-windows-beta-checklist.md` — 干净机器安装和首台设备验收。
- Create: `docs/qa/evidence-index.md` — 证据索引、环境信息和素材位置。
- Create: `docs/demo-script.md` — 3–5 分钟主演示脚本。
- Modify: `docs/compatibility.md` — 只写入已有证据支持的状态。

### Task 1: 将 P7-1 清单纳入仓库

**Files:**
- Create: `docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md`
- Reference: AutoCoder 控制工作区 `DELIVERY/2026-09-16-merge-p7-walkthrough-checklist.md`

- [ ] **Step 1: 复制外部清单原文**

把外部清单复制到仓库目标路径，保留 C（骨架与导航）、D（两轨功能面）、E（无障碍与视觉）结构；不要改写通过条件。若外部文件不可访问，使用续接文档中已记录的约 40 项范围重新建立同等字段：操作、期望、结果、备注、证据。

- [ ] **Step 2: 增加人工结果字段**

每项使用 `未执行 / 通过 / 不通过 / 不适用` 四选一，并保留环境、日期、应用版本和证据路径字段。默认结果必须为“未执行”。

- [ ] **Step 3: 提交清单**

```powershell
git add docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md
git commit -m "qa: 纳入合并页真机走查清单"
```

### Task 2: 建立干净 Windows x64 验收清单

**Files:**
- Create: `docs/qa/clean-windows-beta-checklist.md`

- [ ] **Step 1: 写环境基线**

记录 Windows 版本/build、CPU 厂商/型号、内存、磁盘剩余空间、虚拟化状态、网络代理、是否安装 Docker/WSL2/ADB/scrcpy/QEMU。验收机器必须没有项目开发环境；如有预装，明确列出并标记为非干净。

- [ ] **Step 2: 写安装流程**

逐项覆盖下载、校验、安装、启动、首次检查、依赖处理、退出和重新打开；每项记录开始/结束时间、结果和截图路径。

- [ ] **Step 3: 写双轨首台设备流程**

Docker 轨覆盖 binder、镜像、无 GApps 基础设备、ADB；QEMU 轨覆盖 WHPX、QEMU、cloud image、VM、guest wait、redroid、ADB；每轨记录首次成功耗时。

- [ ] **Step 4: 写可选能力与失败路径**

覆盖 Android 13 GApps、Android 14 不匹配提示、Magisk/Zygisk、LSPosed/Shamiko/Cloak、设备档案、升级、数据保留、回滚、卸载再安装。只在实际运行后填写结果。

- [ ] **Step 5: 提交**

```powershell
git add docs/qa/clean-windows-beta-checklist.md
git commit -m "qa: 增加干净 Windows Beta 验收清单"
```

### Task 3: 执行 P7-1 真机人工走查

**Files:**
- Modify: `docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md`
- Create: `docs/qa/evidence-index.md`

- [ ] **Step 1: 启动真实环境**

启动 Tauri 应用、保持 node1 按优雅流程运行、确认 Docker Desktop 状态；不要使用浏览器预览得出真机结论。

- [ ] **Step 2: 完成 C 节**

检查合并页路由、单一侧边栏入口、轨道切换、刷新后 URL 状态、旧路径跳转、空数据、错误和加载状态。

- [ ] **Step 3: 完成 D 节**

分别操作 Docker 和 QEMU 的列表、创建、启动/停止、日志、设备连接、预装和对比视图；记录任何与预期不符的状态，不绕过失败。

- [ ] **Step 4: 完成 E 节**

用键盘完成主要路径，检查焦点、tablist 语义、按钮禁用态、文本对比度、窄窗口、中文/英文切换和图标辨识度；截图记录不通过项。

- [ ] **Step 5: 建立证据索引**

`evidence-index.md` 记录每项证据的日期、环境、清单编号、结论、截图/视频路径、日志路径和关联提交；没有素材的项目保持“未执行”。

- [ ] **Step 6: 提交走查记录**

```powershell
git add docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md docs/qa/evidence-index.md
git commit -m "qa: 记录合并页真机人工走查"
```

### Task 4: 执行干净 Windows 安装和双轨验收

**Files:**
- Modify: `docs/qa/clean-windows-beta-checklist.md`
- Modify: `docs/qa/evidence-index.md`
- Modify: `docs/compatibility.md`

- [ ] **Step 1: 记录安装包安装**

从发布 Artifact 或 Release 下载包，记录校验和、安装路径、Windows 安全提示、启动结果和卸载结果。

- [ ] **Step 2: 记录 Docker 轨道**

在没有开发依赖的前提下完成 Docker Desktop、binder、镜像、设备创建和 ADB 连接；失败时记录应用提示和日志，不直接手工修复后跳过原始失败。

- [ ] **Step 3: 记录 QEMU 轨道**

完成 WHPX 启用/重启、QEMU 准备、cloud image 校验、节点启动、实例创建和 ADB 连接；保存 `qemu.log`、`console.log` 和 verify 结果。

- [ ] **Step 4: 记录高级能力和恢复**

用 Android 13 x86_64 验证 GApps；用 Android 14 验证拒绝提示；验证 Root 预装、升级、数据哨兵、恢复和重启后的状态。不要把 Shamiko 自报不支持写成通过。

- [ ] **Step 5: 更新矩阵**

只把本次实际完成并有证据的组合改为“已验证”；失败和未测试组合保留相应等级并加限制说明。

- [ ] **Step 6: 提交 QA 证据**

```powershell
git add docs/qa docs/compatibility.md
git commit -m "qa: 记录干净 Windows 双轨验收证据"
```

### Task 5: 产出演示脚本和素材索引

**Files:**
- Create: `docs/demo-script.md`
- Modify: `docs/qa/evidence-index.md`

- [ ] **Step 1: 写主视频脚本**

脚本固定包含：项目定位、环境准备度、选择一条轨道、创建首台设备、ADB/控制、一个可选能力、失败提示和回到文档排障；总时长目标为 3–5 分钟。

- [ ] **Step 2: 录制真实视频**

在已通过 QA 的环境录制，不把开发终端作为主画面；视频中显示版本和轨道选择。高级 Root/GApps 流程另录补充片段，不塞入主视频。

- [ ] **Step 3: 建立素材索引**

索引记录视频文件或托管链接、版本、录制环境和覆盖的清单项；截图使用能长期访问的仓库/Release/项目资产位置。

- [ ] **Step 4: 提交脚本和索引**

```powershell
git add docs/demo-script.md docs/qa/evidence-index.md
git commit -m "docs: 增加 Beta 演示脚本与证据索引"
```

### Task 6: QA 阶段验证

**Files:**
- Test: `docs/qa/2026-09-16-merge-p7-walkthrough-checklist.md`
- Test: `docs/qa/clean-windows-beta-checklist.md`
- Test: `docs/qa/evidence-index.md`
- Test: `docs/compatibility.md`

- [ ] **Step 1: 检查记录完整性**

```powershell
git diff --check
rg -n "未执行|通过|不通过|环境|证据|Windows x64|Docker|QEMU|GApps" docs/qa docs/compatibility.md
```

- [ ] **Step 2: 运行代码基线验证**

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

- [ ] **Step 3: 发布人工结论**

只在清单、证据索引和实际素材都存在时，向 Release Notes 提供“已验证”结论；否则写明待人工确认或实验性。
