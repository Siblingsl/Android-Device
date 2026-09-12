# Redroid Device Center Feature Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify every P0, P1, and P2 capability in `docs/FEATURE-COMPLETION-SPEC.md` without breaking current Docker, Redroid, ADB, APK, logs, settings, or Root/Magisk behavior.

> 执行记录：原始复选框保留为实施时的逐步记录；当前代码接入状态、测试证据和环境限制以 `docs/FEATURE-COMPLETION-SPEC.md` 第 6 节为准。所有能在当前 Windows 主机上验证的门禁均已重新执行；在线设备、Docker 服务和 macOS 实机验收不以静态检查替代。

**Architecture:** Keep Tauri commands as the native boundary and extend `DeviceService` as the only renderer-to-native API. Add typed session/task models for streaming, group operations, file transfer, terminal, recording, wireless pairing, automation, and schedules. Keep existing pages as entry points while extracting focused workbench components so internal scrolling and module layout remain stable.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, Zustand, Vite, scrcpy/ADB/Docker, Vitest for pure behavior tests, and Tauri runtime smoke tests.

**Spec:** `docs/FEATURE-COMPLETION-SPEC.md`

## Global Constraints

- Preserve existing Docker, Redroid, ADB, APK, logs, settings, and Root/Magisk commands and data formats.
- Every asynchronous feature must expose running, success, failure, cancellation, and cleanup states.
- Offline devices disable ADB-dependent actions and explain why.
- Dangerous operations require confirmation.
- Module-internal scrolling is preferred; no unnecessary page-level overflow.
- Production code is written only after a failing behavior test has been observed.
- Run `npm run build` and `cargo check --manifest-path src-tauri/Cargo.toml` at every phase gate.

## File Map

- Modify `src/types/index.ts` for typed task, session, stream, terminal, file, wireless, recording, automation, and preference contracts.
- Modify `src/services/deviceService.ts` for typed invoke wrappers.
- Add `src/lib/taskQueue.ts` for cancellable bounded concurrency and result aggregation.
- Add `src/lib/controlActions.ts` for normalized device actions and broadcast dispatch.
- Add `src/components/device/` workbench components for stream, control bar, group control, terminal, files, recordings, wireless, and automation.
- Modify `src/pages/DeviceDetail.tsx` and `src/pages/Devices.tsx` only to compose focused components and preserve existing routes.
- Modify `src/pages/Settings.tsx` for global/device preference sections and import/export.
- Add `src-tauri/src/services/stream.rs`, `terminal.rs`, `transfer.rs`, `wireless.rs`, and `recording.rs` as focused native services; keep automation and scheduling execution in the typed renderer services `src/lib/automationRuntime.ts` and `src/lib/scheduler.ts`.
- Modify `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, and `src-tauri/src/models/mod.rs` to expose the services without changing existing command signatures.
- Add `tests/` for pure queue/action/config behavior and `src-tauri/tests/` for native parsing and argument safety.

## Execution Order

### Task P0-00: Test harness and baseline snapshot

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/baseline.test.ts`
- Create: `src/lib/testIds.ts`

**Acceptance:** The baseline build passes, Vitest runs, and the test records current behavior contracts without modifying runtime behavior.

- [ ] Add Vitest and test scripts.
- [ ] Write a failing smoke test for the new task result type before adding shared task code.
- [ ] Run the focused test and confirm the expected missing-type failure.
- [ ] Add only the shared test types and configuration needed to make the test pass.
- [ ] Run `npm run build`, `npm test`, and `cargo check --manifest-path src-tauri/Cargo.toml`.

### Task P0-01: Typed operation/task model

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/lib/taskQueue.ts`
- Create: `tests/taskQueue.test.ts`

**Acceptance:** Bounded concurrent tasks return per-item results, support cancellation, and release workers.

- [ ] Write failing tests for success, failure isolation, concurrency limit, and cancellation.
- [ ] Run the focused tests and verify they fail because the queue is absent.
- [ ] Implement `runTaskQueue<T>(items, worker, options)` with `TaskState`, `TaskResult`, and `cancel()`.
- [ ] Run focused tests, then build and the full test suite.

### Task P0-02: Embedded scrcpy session contract

**Files:**
- Create: `src-tauri/src/services/stream.rs`
- Create: `src-tauri/tests/stream_args.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/types/index.ts`

**Acceptance:** A stream session has a typed lifecycle and safe scrcpy arguments; existing detached scrcpy commands remain unchanged.

- [ ] Add failing Rust tests for argument validation and session state transitions.
- [ ] Run Rust tests to observe the expected missing service failure.
- [ ] Implement a stream session registry with start/stop/status and safe argument construction.
- [ ] Expose `scrcpy_stream_start`, `scrcpy_stream_stop`, `scrcpy_stream_status`, and stream event payloads.
- [ ] Add the typed frontend wrappers.
- [ ] Run Rust tests, TypeScript build, and runtime smoke test with a real configured scrcpy binary.

### Task P0-03: Device stream workbench

**Files:**
- Create: `src/components/device/DeviceStream.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/styles/global.css`

**Acceptance:** Device detail renders an embedded live stream area with input, fullscreen, scale, rotate, reconnect, and truthful error states.

- [ ] Write failing component behavior tests for offline disabled state and reconnect action.
- [ ] Run tests to observe the missing workbench behavior.
- [ ] Implement the stream workbench using the typed session contract and existing screenshot fallback.
- [ ] Add pointer/keyboard event normalization and lifecycle cleanup.
- [ ] Run component tests, build, and an actual online-device smoke test.

### Task P0-04: Unified control bar

**Files:**
- Create: `src/lib/controlActions.ts`
- Create: `src/components/device/DeviceControlBar.tsx`
- Create: `tests/controlActions.test.ts`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/pages/Devices.tsx`
- Modify: `src/styles/global.css`

**Acceptance:** Existing actions and new stream actions are available in a reorderable, collapsible, persistent control bar.

- [ ] Write failing tests for action availability and offline gating.
- [ ] Implement normalized actions and persisted toolbar configuration.
- [ ] Compose the control bar into detail and list contexts.
- [ ] Verify dangerous actions use the existing confirmation path.
- [ ] Run tests, build, and manual control checks on an online Redroid device.

### Task P0-05: Group-control queue

**Files:**
- Create: `src/components/device/GroupControlPanel.tsx`
- Modify: `src/pages/Devices.tsx`
- Modify: `src/stores/appStore.ts`
- Modify: `src/services/deviceService.ts`
- Create: `tests/groupControl.test.ts`

**Acceptance:** Selected devices can receive broadcast input and batch operations with independent outcomes, cancellation, and retry.

- [ ] Write failing tests for selection isolation, failure isolation, cancellation, and retry.
- [ ] Implement the queue using `runTaskQueue` and `controlActions`.
- [ ] Add result panel and “retry failed” behavior.
- [ ] Run focused tests, build, and a two-device smoke test.

### Task P0-06: File transfer and Explorer

**Files:**
- Create: `src-tauri/src/services/transfer.rs`
- Create: `src-tauri/tests/transfer_paths.rs`
- Create: `src/components/device/FileExplorer.tsx`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/DeviceDetail.tsx`

**Acceptance:** Multi-select file operations, directory upload/download, preview/edit, drag/drop, progress, cancellation, and retry work on an online device.

- [ ] Write failing Rust path-safety tests and frontend selection/task tests.
- [ ] Implement path normalization and recursive transfer commands with progress events.
- [ ] Implement the Explorer workbench while preserving current single-file operations.
- [ ] Run path tests, frontend tests, build, and a real directory transfer.

### Task P0-07: Interactive terminal

**Files:**
- Create: `src-tauri/src/services/terminal.rs`
- Create: `src-tauri/tests/terminal_sessions.rs`
- Create: `src/components/device/InteractiveTerminal.tsx`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/DeviceDetail.tsx`

**Acceptance:** Device ADB Shell sessions support interactive input/output, resize, interrupt, close, and cleanup; local terminal support is separately identified.

- [ ] Write failing session lifecycle tests.
- [ ] Implement the session registry and event stream.
- [ ] Implement the terminal UI and cleanup on route/device changes.
- [ ] Run session tests, build, and `top`/`logcat` live-command smoke tests.

### Task P0-08: Wireless pairing and discovery

**Files:**
- Create: `src-tauri/src/services/wireless.rs`
- Create: `src-tauri/tests/wireless_state.rs`
- Create: `src/components/device/WirelessPairingDialog.tsx`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/Adb.tsx`

**Acceptance:** Pair-code, QR/manual address, mDNS discovery, saved addresses, USB-to-Wi-Fi and batch connect work while existing `/24` scan remains intact.

- [ ] Write failing wireless state-machine tests.
- [ ] Implement safe address parsing, pairing, discovery events, and saved-address storage.
- [ ] Add the pairing/discovery UI and status mapping.
- [ ] Run tests, build, and a real wireless ADB verification where the host supports it.

### P0 Gate

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] Run Tauri with Docker, one online Redroid device, one offline device, and two-device batch scenarios.
- [ ] Confirm existing Dashboard, Docker, ADB, APK, Volumes, Logs, Settings, Root/Magisk flows still work.

## P1 Tasks

### Task P1-01: Recording, audio, camera, OTG, and gamepad input

**Files:** `src-tauri/src/services/recording.rs`, `src/components/device/RecordingPanel.tsx`, scrcpy command wrappers, tests.

**Acceptance:** Video/audio/camera/OTG modes expose real running/stop/failure states and produce usable output when supported by the installed scrcpy version.

### Task P1-02: Advanced scrcpy preferences

**Files:** `src/types/index.ts`, `src-tauri/src/models/mod.rs`, `src-tauri/src/services/settings.rs`, `src/pages/Settings.tsx`, `src/components/device/ScrcpyPreferences.tsx`, tests.

**Acceptance:** Global, per-device, and device-group settings validate, persist, migrate, and map deterministically to scrcpy arguments.

### Task P1-03: Gnirehtet

**Files:** `src-tauri/src/services/gnirehtet.rs`, commands, service wrapper, `src/components/device/GnirehtetPanel.tsx`, tests.

**Acceptance:** Install, start, stop, status, repair, and batch operations use real results and clean up processes.

### Task P1-04: Window arrangement

**Files:** `src/components/layout/ArrangementDialog.tsx`, `src/stores/layoutStore.ts`, Tauri window commands, tests.

**Acceptance:** Grid, drag, resize, save/load/reset and per-device placement survive application restart.

### Task P1-05: Application management enhancement

**Files:** `src/pages/DeviceDetail.tsx`, `src/services/deviceService.ts`, `src-tauri/src/services/device.rs`, optional Activity command, tests.

**Acceptance:** App picker, recent/favorite apps, Activity launch, batch actions and desktop shortcuts report real results.

### Task P1-06: Device metadata and telemetry

**Files:** `src/types/index.ts`, `src-tauri/src/services/device.rs`, `src/components/device/DeviceMetadataPanel.tsx`, `src/pages/Devices.tsx`, tests.

**Acceptance:** Remarks, groups, labels, offline cleanup, battery telemetry and auto-connect/auto-mirror persist without changing serial identity or Docker volumes.

### Task P1-07: Global shortcuts

**Files:** Tauri global shortcut plugin, commands, `src/pages/Settings.tsx`, `src/components/settings/ShortcutEditor.tsx`, `src/lib/shortcutConfig.ts`, tests.

**Acceptance:** Shortcuts register globally, detect conflicts, persist, and dispatch only enabled actions.

### Task P1-08: Tray, launch, and window integration

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/services/launch.rs`, Tauri config, `src/components/layout/AppLayout.tsx`, settings UI, tests.

**Acceptance:** Tray, close-to-tray, auto-launch, desktop shortcut and edge-hide behavior are user-configurable and do not terminate active tasks unexpectedly.

### Task P1-09: Updater and configuration import/export

**Files:** updater service, settings model, `src/components/settings/ConfigTransfer.tsx`, `src/lib/configTransfer.ts`, `src/lib/updateConfig.ts`, migration tests.

**Acceptance:** Updates and config transfer are truthful, cancellable, versioned, and do not overwrite configuration without preview/confirmation.

### P1 Gate

- [ ] Run the complete P0 gate.
- [ ] Run P1 unit/integration tests and real recording, camera, wireless-network, layout, shortcut, and configuration scenarios.
- [ ] Verify every unsupported platform/tool capability is disabled with a reason instead of showing a false success.

## P2 Tasks

### Task P2-01: Keyboard mapping

**Files:** `src/components/device/KeyboardMappingPanel.tsx`, `src/components/device/DeviceStream.tsx`, `src/lib/keyboardMapping.ts`, settings storage, tests.

**Acceptance:** Mapping schemes are editable, scoped, importable, exportable, and route click, long-press, swipe, joystick press/release, scroll, KeyEvent, and automation-script events to the correct device/app. Missing scripts fail explicitly instead of being treated as success.

### Task P2-02: Visual automation

**Files:** `src/components/device/AutomationPanel.tsx`, `src/lib/automation.ts`, `src/lib/automationRuntime.ts`, `src/lib/imageMatcher.ts`, tests.

**Acceptance:** Scripts support the specified steps, variables, conditions, loops, image matching, pause/resume/stop, logs, persistence, and batch execution without unsafe continuation after failure.

### Task P2-03: Scheduler

**Files:** `src/components/settings/SchedulerPanel.tsx`, `src/lib/scheduler.ts`, `src/components/layout/AppLayout.tsx`, persistence, tests.

**Acceptance:** Local-time schedules run once per intended occurrence, survive restart, prevent duplicate concurrent runs, and expose history/retry/logs.

### Task P2-04: AI/MCP

**Files:** provider settings, `src/components/device/AgentPanel.tsx`, `src/lib/mcpProtocol.ts`, `src-tauri/src/services/mcp.rs`, tool policy, tests.

**Acceptance:** Side-effecting tools require confirmation, limits and timeouts are enforced, sessions are auditable, and failure cannot silently continue dangerous actions.

### Task P2-05: macOS

**Files:** Tauri platform adapters, build configuration, platform tests, packaging scripts.

**Acceptance:** macOS package builds and the supported Docker/ADB/scrcpy/device flows pass without Windows-specific path or process assumptions.

### P2 Gate and final regression

- [ ] Run all unit, integration, and native tests.
- [ ] Run `npm run build`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] Verify P0/P1/P2 requirements against `docs/FEATURE-COMPLETION-SPEC.md` item by item.
- [ ] Run the complete Tauri smoke matrix: Docker unavailable, ADB unavailable, offline device, unauthorized device, online device, multiple devices, task cancellation, process failure, restart, and configuration migration.
- [ ] Only after all evidence is collected may the goal be marked complete.

## Current execution evidence (2026-09-11)

- TypeScript: `npm test -- --run` — 16 个测试文件、63 个测试通过；补充验证了自动化步骤日志、可中断等待、图片模板裁剪、文件传输进度、文件路径恢复、窗口恢复开关与边界回写、设备流清理、Scrcpy 作用域优先级、键盘映射摇杆/自动化动作/前台应用匹配、更新取消状态，以及 AI 配置迁移、多配置切换和任务会话持久化。
- P1-05 应用图标：后端从已安装 APK 的 aapt 资源中选择最高密度图标，前端按可见行懒加载并缓存；缺少 aapt2、APK 或可解码资源时回传明确错误。
- P1-09 更新下载：下载中提供取消入口，关闭更新资源后回到可重新检查状态，取消异常不会被误报为下载失败。
- Frontend build: `npm run build` — 1814 个模块通过；仅保留单个 JS chunk 大于 600 kB 的性能提示。
- Rust: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml` — 56 个测试通过。
- macOS target boundary: `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-apple-darwin` correctly stopped because the Windows host has no Apple `cc` toolchain; this is retained as an environment limitation, not counted as macOS acceptance.
- Localization: `python scripts/i18n-audit.py` — 缺失键 0、占位符不匹配 0。
- Tauri smoke: `npm run tauri dev` 启动成功；退出后应用进程和开发端口均已清理。
- MCP smoke: `rdc-mcp` stdio 已完成 `initialize` 与 `tools/list` 双请求验证，返回真实工具 schema。
- Environment-limited acceptance remains explicitly open in the feature specification: authorized online ADB device, connected Docker Desktop, Gnirehtet binary, and a real macOS host/toolchain are required for those runtime paths.
- Release safety gate: `node scripts/tauri-release-build.mjs` correctly refuses to build when `RDC_UPDATE_ENDPOINT` or `RDC_UPDATE_PUBKEY` is absent.
