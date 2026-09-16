# 首次启动环境引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Dashboard `readiness_checklist` 基础上，提供可解释、按轨道区分、可重新检查的首次启动环境引导，覆盖依赖状态和首台设备路径。

**Architecture:** 保留现有 `src-tauri/src/services/readiness.rs` 的一次性轻量探测和 `ReadinessItem` 稳定字段，按向后兼容方式增加状态/轨道/详情信息；前端通过 `DeviceService.readinessChecklist()` 消费快照，修复动作只打开已有页面或给出明确指导，不在外壳或对比视图中增加服务调用和定时器。

**Tech Stack:** Rust/Tauri commands、React/TypeScript、Zustand 现有状态、Vitest、Cargo 单元测试。

**Spec:** `docs/superpowers/specs/2026-09-16-open-source-beta-productization-design.md`

## Global Constraints

- **执行前置：必须取得用户对 `src-tauri`/`qemu-center` 后端改动的显式授权。未授权时只允许完成设计、测试夹具和文档，不得实施后端改动。**
- 复用现有 readiness、QEMU `doctor --json`、Docker/ADB/路径检查，不建立平行检测系统。
- 保留 Dashboard 当前一次性探测语义，不让昂贵或易卡顿探测进入 20 秒 Dashboard 刷新。
- 依赖状态区分 `ready`、`action_required`、`unsupported`、`unknown`；禁止用 0 或空值冒充可用。
- 不自动安装系统级依赖，不自动写入 WHPX、WSL、Docker 或用户 PATH。
- 不改变页面合并的外壳/对比视图零服务调用、零定时器不变量。
- 每阶段执行 `npx tsc --noEmit`、`npx vitest run`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path qemu-center/Cargo.toml`。

## Current Implementation Baseline

当前已有：

- `src-tauri/src/services/readiness.rs::checklist()`：Docker、ADB、scrcpy、WHPX、qemu-center、Ubuntu cloud image 六项。
- `src-tauri/src/commands/mod.rs::readiness_checklist()`：Tauri 命令。
- `src/services/deviceService.ts::readinessChecklist()`：前端桥接。
- `src/pages/Dashboard.tsx`：一次性读取并展示待处理清单。
- `src/types/index.ts::ReadinessItem`：`id/title/done/hint/cta` 稳定字段。

因此实施重点是“扩展和解释”，不是新建一套 onboarding 服务。

## File Map

- Modify: `src-tauri/src/services/readiness.rs` — 只读探测、状态组装和 Rust 测试。
- Modify: `src-tauri/src/commands/mod.rs` — 仅当返回类型/命令参数需要同步时修改。
- Modify: `src-tauri/src/lib.rs` — 仅当命令注册需要同步时修改。
- Modify: `src/types/index.ts` — 扩展兼容的 ReadinessItem 类型。
- Modify: `src/services/deviceService.ts` — 更新返回类型，不增加新的页面轮询。
- Modify: `src/pages/Dashboard.tsx` — 展示状态、轨道、详情和重新检查。
- Modify: `src/i18n/pages/dashboard.ts` — 增加中英文状态/按钮文案。
- Modify: `src/pages/Dashboard.test.tsx` — 覆盖状态和交互。
- Modify: `src/styles/global.css` — 仅增加清晰的状态/响应式样式。
- Reference: `src-tauri/src/services/docker.rs`、`src-tauri/src/services/qemu.rs`、`qemu-center/src/doctor.rs` — 复用现有检测，不平行重写。

### Task 1: 授权门和现有契约盘点

**Files:**
- Read: `AGENTS.md`
- Read: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Read: `src-tauri/src/services/readiness.rs`
- Read: `src/types/index.ts`
- Read: `src/pages/Dashboard.tsx`

- [ ] **Step 1: 取得显式后端授权**

在开始修改 `src-tauri`、`src-tauri/src/services/readiness.rs`、`src-tauri/src/commands/mod.rs` 或 `qemu-center` 前，取得用户明确授权。若没有授权，停止在本计划 Task 1，不执行后续后端任务。

- [ ] **Step 2: 列出当前探测和缺口**

将现有六项和新增目标逐项映射：Docker、ADB、scrcpy、WHPX、qemu-center、cloud image、GApps 版本、Android/ABI、设备档案、Docker 轨/QEMU 轨可用性；每项写明已有数据源或“需要新增只读数据源”。

- [ ] **Step 3: 确认不变量**

在实现前用测试断言以下行为：Dashboard readiness 只在 mount 时读取；Dashboard 20 秒 tick 不触发 readiness；`RuntimePage` 和 `RuntimeCompare` 不调用 readiness；旧 `done/title/hint/cta` 字段仍可被现有调用方读取。

### Task 2: 扩展只读 readiness 数据契约

**Files:**
- Modify: `src-tauri/src/services/readiness.rs`
- Modify: `src/types/index.ts`
- Modify: `src/services/deviceService.ts`
- Test: `src-tauri/src/services/readiness.rs`

**Interfaces:**
- Consumes: 现有六项 probe 结果和已有 GApps/ABI/设备档案验证函数可提供的数据。
- Produces: 向前兼容的 readiness item，前端可以显示状态、轨道、详情和动作。

- [ ] **Step 1: 写 Rust 失败测试**

扩展纯函数测试，覆盖 ready、action_required、unsupported 和 unknown；断言 unknown 不会被映射为 done，也不会产生伪造的数值。

- [ ] **Step 2: 写 TypeScript 兼容类型**

在 `ReadinessItem` 保留 `id/title/done/hint/cta`，增加非破坏性字段：

```ts
status?: "ready" | "action_required" | "unsupported" | "unknown";
track?: "shared" | "docker" | "qemu";
detail?: string;
```

旧后端返回缺少新字段时，前端按 `done ? "ready" : "action_required"` 兼容显示，但不能把未知数据当作 ready。

- [ ] **Step 3: 实现统一状态组装**

在 Rust 侧将已有 probe 结果映射到统一状态；WHPX 在非 Windows 上继续省略；QEMU 轨专属依赖不要阻塞 Docker 轨首台设备；GApps/ABI 不匹配必须是 `unsupported` 并携带明确版本原因。

- [ ] **Step 4: 运行目标测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml readiness
npx vitest run src/pages/Dashboard.test.tsx
```

- [ ] **Step 5: 提交契约阶段**

```powershell
git add src-tauri/src/services/readiness.rs src/types/index.ts src/services/deviceService.ts
git commit -m "feat: 扩展首次启动环境状态契约"
```

### Task 3: 实现 Dashboard 引导展示和重新检查

**Files:**
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/i18n/pages/dashboard.ts`
- Modify: `src/styles/global.css`
- Modify: `src/pages/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `DeviceService.readinessChecklist(): Promise<ReadinessItem[]>`。
- Produces: 状态、原因、轨道和安全动作；“重新检查”只刷新清单，不触发设备或实例写操作。

- [ ] **Step 1: 写失败的 Dashboard 测试**

覆盖：ready 项显示可用；action_required 显示原因和处理入口；unsupported 显示“不支持”而非失败；unknown 显示“无法判定”；点击重新检查只调用一次 `readinessChecklist`；组件卸载后结果不写入状态。

- [ ] **Step 2: 实现状态显示**

将当前 `done` 徽标扩展为四种状态徽标；保留现有按待处理项显示卡片的行为；没有待处理项时仍可显示轻量的“环境已准备”结果或按当前产品文案隐藏，但不能丢失重新检查入口。

- [ ] **Step 3: 实现安全动作**

`cta` 只导航到现有 `/settings`、`/adb`、`/containers?track=docker` 或 `?track=qemu`；不在卡片中执行系统安装、VM 删除、容器删除或后端写操作。

- [ ] **Step 4: 加入中英文文案**

将状态名、重新检查、轨道名和无数据原因放入 `src/i18n/pages/dashboard.ts`；后端返回的具体技术原因作为 detail 展示，不能只显示通用“失败”。

- [ ] **Step 5: 加入样式并运行前端测试**

```powershell
npx vitest run src/pages/Dashboard.test.tsx
npx tsc --noEmit
```

- [ ] **Step 6: 提交前端阶段**

```powershell
git add src/pages/Dashboard.tsx src/i18n/pages/dashboard.ts src/styles/global.css src/pages/Dashboard.test.tsx
git commit -m "feat: 完善首次启动环境引导展示"
```

### Task 4: 补齐 GApps、ABI 和轨道范围信息

**Files:**
- Modify: `src-tauri/src/services/readiness.rs`
- Modify: `src-tauri/src/services/docker.rs` only if an existing read-only helper can be reused
- Modify: `src-tauri/src/services/qemu.rs` only if an existing read-only helper can be reused
- Modify: `src/types/index.ts`
- Modify: `src/pages/Dashboard.tsx`
- Test: Rust readiness tests and `src/pages/Dashboard.test.tsx`

- [ ] **Step 1: 写缺口测试**

覆盖 Android 13 x86_64 GApps 可用、Android 14 目标与 Android 13 GApps 不兼容、缺少 GApps 资产、ABI 未知和 QEMU 依赖只影响 QEMU 轨道的场景。

- [ ] **Step 2: 复用现有验证逻辑**

调用已有 GApps 版本检查、设备档案和 ABI 约束；如果当前代码没有适合 readiness 的纯只读函数，先提取纯函数并为其加测试，不在 readiness 中复制字符串解析或创建流程。

- [ ] **Step 3: 保持首台设备优先级**

无 GApps 基础 Redroid 作为最快成功路径；高级预装只显示为可选能力和限制，不让缺少高级资产阻塞基础 Docker/QEMU 轨道状态。

- [ ] **Step 4: 验证**

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/services/readiness.rs src/types/index.ts src/pages/Dashboard.tsx src/pages/Dashboard.test.tsx
git commit -m "feat: 展示轨道与预装兼容性状态"
```

### Task 5: 真机人工确认和后端变更收口

**Files:**
- Reference: `docs/qa/clean-windows-beta-checklist.md`
- Reference: `docs/qa/evidence-index.md`
- Modify: `docs/compatibility.md` only after evidence exists

- [ ] **Step 1: 在真实 Tauri 应用中检查首次打开**

确认 Dashboard readiness 不阻塞主界面，依赖缺失时提示可读，QEMU 轨和 Docker 轨状态不互相误报。

- [ ] **Step 2: 检查重新检查和切页**

确认重新检查不会重复创建实例、不会触发 QEMU 启动、不会改变 Docker/QEMU 状态，只更新当前清单快照。

- [ ] **Step 3: 检查视觉/a11y**

按 QA 清单检查键盘焦点、状态颜色之外的文本语义、按钮禁用态、窄窗口和中英文布局；这些结论只写入人工证据。

- [ ] **Step 4: 更新支持矩阵**

只有当人工证据和日志索引存在时，才更新 `docs/compatibility.md`；否则保留“未验证”。

- [ ] **Step 5: 运行全部验证并提交收口**

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

提交：

```powershell
git add docs/compatibility.md docs/qa
git commit -m "qa: 收口首次启动引导真机证据"
```
