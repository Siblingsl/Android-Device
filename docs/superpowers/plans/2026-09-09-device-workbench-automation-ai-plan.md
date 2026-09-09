# 设备工作台、自动化与 AI 操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已确认的四张设计图完成全页面紧凑工作台改造，并在保留既有能力的基础上增加自动化脚本与带风险确认的 AI 设备操作。

**Architecture:** 先统一 React 页面壳和视觉 token，再把自动化与 Copilot 作为独立的服务/模型/页面接入。设备动作继续经由现有 Tauri commands；自动化调度器和 AI 工具注册表只编排、校验和记录，不复制底层设备实现。新增持久化使用独立命名空间，避免改写已有设置格式。

**Tech Stack:** React 19, TypeScript, Vite, Tauri 2, Rust 2021, Zustand, Vitest, Testing Library, serde/serde_json, 现有 DeviceService 与 Tauri commands。

**Spec:** `docs/superpowers/specs/2026-09-09-device-workbench-automation-ai-design.md`

## Global Constraints

- 严格遵守四张已确认设计图的层级、密度和独立 scrcpy 预览规则。
- 不删除、不改写现有设备、Docker、ADB、scrcpy、终端、日志、设置和确认提示逻辑。
- `Reference_Projects/` 只读，不加入 git，不复制其 UI 代码。
- 所有新增行为按 TDD：先写失败测试，再实现最小代码，再跑全量测试。
- 每个阶段独立提交并推送到当前分支；提交前运行目标测试、全量测试、构建和 `git diff --check`。

## 文件边界

- UI 壳与 token：`src/components/layout/`, `src/styles/global.css`, 各 `src/pages/*.tsx`
- 新增类型：`src/types/index.ts`
- 新增前端服务：`src/services/automationService.ts`, `src/services/copilotService.ts`
- 新增页面：`src/pages/Automation.tsx`, `src/pages/Copilot.tsx`
- 新增 Rust 服务：`src-tauri/src/services/automation.rs`, `src-tauri/src/services/copilot.rs`
- 新增命令注册：`src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- 新增 i18n：`src/i18n/pages/automation.ts`, `src/i18n/pages/copilot.ts`, `src/i18n/index.ts`
- 新增测试：对应页面、服务、调度器和命令测试文件

### Task 1: 建立全页面工作台壳与设计回归基线

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`, `src/components/layout/AppLayout.tsx`, `src/components/layout/WorkspaceHeader.tsx`
- Modify: `src/styles/global.css`
- Modify: `src/pages/Apk.tsx`, `src/pages/Docker.tsx`, `src/pages/Volumes.tsx`, `src/pages/Terminal.tsx`, `src/pages/FloatingControl.tsx`, `src/pages/MonitorAlerts.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Test: 对应已有测试文件和新增结构断言

**Interfaces:** 保留所有现有 props、事件和服务调用；仅增加稳定的工作台 class、区域包装和无障碍标签。

- [ ] 写出每个未统一页面的结构回归测试，断言标题轨、主工作面、动作轨、状态反馈轨存在。
- [ ] 运行目标测试，确认新结构断言先失败。
- [ ] 逐页按设计图增加布局包装，先完成 Docker/Volumes/APK/Terminal/FloatingControl/Monitor，再调整 DeviceDetail 的概览/控制/日志/设置。
- [ ] 运行目标测试和全量测试，检查现有交互断言没有回归。
- [ ] 使用浏览器/客户端运行截图检查四张设计图的密度、间距、表格和控制 dock。
- [ ] 提交 `feat: align remaining pages with workbench design` 并推送。

### Task 2: 增加自动化脚本领域模型与持久化

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/lib/automationModel.ts`, `src/lib/automationModel.test.ts`
- Create: `src-tauri/src/services/automation.rs`, `src-tauri/src/services/automation_test.rs` 或模块内测试
- Modify: `src-tauri/src/services/mod.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src/services/automationService.ts`, `src/services/automationService.test.ts`

**Interfaces:**
- `automation_list_scripts() -> Result<Vec<AutomationScript>, String>`
- `automation_save_script(script: AutomationScript) -> Result<AutomationScript, String>`
- `automation_delete_script(id: String) -> Result<(), String>`
- `automation_import_script(path: String) -> Result<AutomationScript, String>`
- `automation_export_script(id: String, path: String) -> Result<(), String>`

- [ ] 先为步骤联合类型、默认脚本、变量校验、导入版本校验写失败测试。
- [ ] 实现 TypeScript 类型和纯函数校验，拒绝未知步骤、空脚本名称和非法变量名。
- [ ] 先实现独立 JSON 存储服务，文件损坏时返回可解释错误并保留旧文件。
- [ ] 注册 Tauri commands，并在前端 service 中封装统一错误处理。
- [ ] 运行 Rust/前端目标测试和构建。
- [ ] 提交 `feat: add automation script storage model` 并推送。

### Task 3: 实现自动化调度器与执行日志

**Files:**
- Create: `src-tauri/src/services/automation_runner.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src/lib/automationRunner.ts`, `src/lib/automationRunner.test.ts`
- Modify: `src/services/automationService.ts`

**Interfaces:**
- `automation_run(request: AutomationRunRequest) -> Result<AutomationRunSummary, String>`
- `automation_pause(run_id: String) -> bool`
- `automation_resume(run_id: String) -> bool`
- `automation_stop(run_id: String) -> bool`
- `automation_run_status(run_id: String) -> AutomationRunState`

- [ ] 用假设备命令适配器写失败测试，覆盖单步顺序、等待、失败策略、暂停/继续、停止、重试和并发上限。
- [ ] 实现运行状态注册表、取消 token、每设备队列和事件 payload。
- [ ] 将步骤执行映射到现有 device/ADB/screenshot/scrcpy 命令，不新写重复底层动作。
- [ ] 加入 imageMatch 步骤的截图输入、阈值和失败分支；未准备视觉依赖时返回明确能力错误。
- [ ] 加入批量设备执行和事件日志，脱敏变量值。
- [ ] 运行服务、Rust commands、全量测试和构建。
- [ ] 提交 `feat: execute automation scripts across devices` 并推送。

### Task 4: 实现自动化页面

**Files:**
- Create: `src/pages/Automation.tsx`, `src/pages/Automation.test.tsx`
- Create: `src/i18n/pages/automation.ts`
- Modify: `src/i18n/index.ts`, `src/App.tsx`, `src/components/layout/Sidebar.tsx`, `src/types/index.ts`
- Modify: `src/styles/global.css`

- [ ] 先写页面结构失败测试：脚本列表、步骤编排、变量区、执行 rail、批量设备选择、运行日志。
- [ ] 实现与设计图一致的三段式工作台：左侧脚本账本、中间步骤序列、右侧步骤/变量编辑 dock；页面仍使用顶部工具栏，不增加大侧边导航。
- [ ] 接入新 service 的创建/保存/导入/导出/删除和运行控制。
- [ ] 保留所有执行状态、失败重试、暂停/继续/停止和确认提示。
- [ ] 运行页面目标测试、全量测试、构建并启动客户端检查实际密度。
- [ ] 提交 `feat: add automation workflow workbench` 并推送。

### Task 5: 实现 AI 工具注册表与安全确认边界

**Files:**
- Create: `src-tauri/src/services/copilot.rs`, `src-tauri/src/services/copilot_tools.rs`
- Create: `src-tauri/src/services/copilot.test.rs` 或模块内测试
- Modify: `src-tauri/Cargo.toml`（仅在现有依赖无法完成 HTTP 请求时加入明确、最小的 HTTP 依赖）
- Modify: `src-tauri/src/services/mod.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src/types/copilot.ts`, `src/services/copilotService.ts`, `src/services/copilotService.test.ts`

**Interfaces:**
- `copilot_list_tools() -> Vec<CopilotToolDescriptor>`
- `copilot_start(request: CopilotRequest) -> Result<CopilotTask, String>`
- `copilot_confirm(task_id: String, call_id: String, approved: bool) -> Result<(), String>`
- `copilot_cancel(task_id: String) -> bool`
- `copilot_list_sessions() -> Vec<CopilotSessionSummary>`

- [ ] 先写工具风险分类、参数 schema、只读默认放行和写入必须确认的失败测试。
- [ ] 实现工具注册表，把每个工具映射到现有 DeviceService/Tauri 命令。
- [ ] 实现任务步数、单步超时、总超时、取消、重试和等待确认状态机。
- [ ] 实现 OpenAI-compatible 请求边界，API Key 只在 Rust 内存中使用，错误信息脱敏。
- [ ] 对视觉请求明确检查模型能力和截图输入支持。
- [ ] 运行 Rust/前端测试和构建。
- [ ] 提交 `feat: add guarded copilot device tools` 并推送。

### Task 6: 实现 AI 操作工作台

**Files:**
- Create: `src/pages/Copilot.tsx`, `src/pages/Copilot.test.tsx`
- Create: `src/i18n/pages/copilot.ts`
- Modify: `src/i18n/index.ts`, `src/App.tsx`, `src/components/layout/Sidebar.tsx`, `src/styles/global.css`
- Modify: `src/pages/Settings.tsx`, `src/types/index.ts`

- [ ] 先写页面结构失败测试：模型/供应商设置入口、设备选择、对话流、工具调用预览、确认按钮、执行日志、取消按钮。
- [ ] 实现四张设计图统一的 AI 工作台：顶部任务状态 rail，中间对话与工具时间线，右侧设备/模型/风险 dock，底部输入区。
- [ ] 接入 session/history、确认和取消状态，不把 AI 操作混入普通 Shell 输入框。
- [ ] 在设置页增加 API URL、Key、模型、最大步数、超时和视觉能力配置，保留旧设置保存/放弃行为。
- [ ] 运行目标测试、全量测试、构建和客户端冒烟检查。
- [ ] 提交 `feat: add copilot operation workbench` 并推送。

### Task 7: 全量验收与备份

**Files:**
- Modify only if verification exposes a regression.

- [ ] 逐路由打开所有页面，记录 UI 结构与四张设计图的偏差。
- [ ] 验证普通设备操作、文件传输、应用管理、终端、ADB、Docker、日志和设置的关键路径。
- [ ] 验证自动化创建/导入/导出/运行/暂停/停止/批量/日志。
- [ ] 验证 AI 只读任务、写操作确认、拒绝、取消、超时、API 错误和视觉能力错误。
- [ ] 运行 `npm test -- --run`, `npm run build`, `git diff --check`。
- [ ] 检查 `git status --short`，确保 `Reference_Projects/` 仍未被跟踪或修改。
- [ ] 创建最后一个阶段提交并推送，报告所有验证证据和仍存在的非阻断警告。
