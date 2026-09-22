# Security Review Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复上一轮审查确认的可变镜像、guest 请求边界、无界输入输出、CSP 缺失和 React 卸载后定时器异常。

**Architecture:** 所有受保护 QEMU 路径 fail closed：镜像必须使用 SHA-256 digest，guest runner 在特权操作前验证请求结构、路径和字段长度；子进程、HTTP 响应和请求文件均有明确上限。前端将短时反馈定时器绑定到组件生命周期并在卸载时清理。

**Tech Stack:** Rust/Tauri、Rust qemu-center、Python guest runner、React/Vitest。

**Spec:** 本对话上一轮只读代码审查报告。

## Global Constraints

- 只修改上一轮五个问题涉及的实现与回归测试，不评价或清理无关风格、命名、注释。
- 保留当前工作树中的所有既有改动，不执行 reset、checkout、clean 或提交用户未要求的其他变更。
- 后端修改已获用户对“修复所有问题”的明确授权。
- 每项行为修复先写回归测试并观察预期失败，再写最小实现。
- 完成前运行项目要求的 TypeScript、Vitest、三个 Rust crate、Python 测试，以及可用 lint/SAST 检查。

## Review Focus

- tag、空镜像和非法 digest 不得进入受保护构建或 Docker run。
- guest 请求中的模块、属性、上下文路径和 JSON 文件不得越界或无限增长。
- Docker/HTTP 子进程输出超过上限时应中止并返回明确错误，而不是耗尽内存。
- 组件卸载后不得再执行状态更新定时器。
- 生产 Tauri 配置必须启用限制性 CSP。

### Task 1: 固定受保护 Redroid 镜像

**Files:**
- Modify: `src-tauri/src/services/preset.rs`
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `qemu-center/src/redroid.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/vm.rs`
- Test: Rust unit tests in the same files

- [ ] **Step 1: Add failing tests** for accepting a valid `@sha256:` reference and rejecting tags, empty values, malformed digests, and the QEMU default path.
- [ ] **Step 2: Run focused Rust tests and confirm the new assertions fail.**
- [ ] **Step 3: Enforce immutable image references before QEMU preset preparation and before qemu-center Docker execution; remove the mutable default execution path.
- [ ] **Step 4: Run focused tests and the complete qemu-center/src-tauri Rust suites.**

### Task 2: Harden guest request parsing and bounded I/O

**Files:**
- Modify: `src-tauri/src/services/qemu_guest.py`
- Modify: `src-tauri/src/services/qemu_loader.py`
- Test: `src-tauri/src/services/test_qemu_guest.py`
- Test: `src-tauri/src/services/test_qemu_loader.py`

- [ ] **Step 1: Add failing tests** for oversized request files/grant payloads, unsafe module IDs, unsafe expected properties, out-of-root contexts, and oversized Docker subprocess output.
- [ ] **Step 2: Run focused Python tests and confirm the new assertions fail.**
- [ ] **Step 3: Add request schema validation, root containment, bounded Base64/request reads, bounded subprocess collection, and bounded loader request reads.
- [ ] **Step 4: Run all Python service tests.**

### Task 3: Enable production CSP

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Test: `tests/securityConfig.test.ts`

- [ ] **Step 1: Add a failing config test** requiring a non-null restrictive CSP.
- [ ] **Step 2: Run the focused test and confirm it fails.**
- [ ] **Step 3: Set a production CSP with no remote scripts, objects, frames, or arbitrary connections.
- [ ] **Step 4: Run the focused test and TypeScript checks.**

### Task 4: Clear Docker creation feedback timers on unmount

**Files:**
- Modify: `src/pages/tracks/DockerTrackPanel.tsx`
- Test: `src/pages/Docker.test.tsx`

- [ ] **Step 1: Add a failing test** that unmounts immediately after a successful creation schedules the flash reset.
- [ ] **Step 2: Run the focused Docker test and confirm the unhandled timer error is reproduced.**
- [ ] **Step 3: Store both feedback timer handles and clear them in the component cleanup.
- [ ] **Step 4: Run the focused Docker test and the complete Vitest suite.**

### Final verification

- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npx vitest run`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `cargo test --manifest-path qemu-center/Cargo.toml`.
- [ ] Run `cargo test --manifest-path authorization-service/Cargo.toml`.
- [ ] Run Python unittest discovery, Ruff, Clippy, and available SAST tools; record unavailable tools without installing dependencies.
