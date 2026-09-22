# Security Review Findings Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复上轮代码审查发现的供应链信任、敏感文件清理、终端资源耗尽、授权服务并发/重放边界和 PTY 异常处理问题。

**Architecture:** 采用 fail-closed 原则：远程安装物没有可信摘要时拒绝继续，受保护文件清理失败时不返回成功，所有长生命周期资源都有显式上限。授权请求增加签名时间窗，使 nonce 可以安全按时间清理而不重新打开重放窗口。

**Tech Stack:** Rust/Tauri、Rust authorization-service、独立 Rust qemu-center、Python guest runner、Cargo/Vitest/Python unittest。

**Spec:** 上轮只读代码审查结论（本对话上一轮最终报告）。

## Global Constraints

- 不修改与本轮四项审查范围无关的代码风格、命名和注释。
- 保留现有工作树中的用户改动，不执行 reset、checkout 或清理未提交文件。
- `src-tauri`、`qemu-center` 和 `authorization-service` 的后端修改已获用户明确授权。
- 每个行为修复先写回归测试并观察失败，再写最小实现。
- 必须执行项目要求的 TypeScript、Vitest、三个 Rust crate、Python 测试和可用的 lint/SAST 检查。

## Review Focus

- 没有可信摘要/签名的远程 QEMU 安装器、Ubuntu 镜像和 Docker 安装脚本必须 fail closed。
- 任一宿主或 guest 清理失败时，受保护操作不得继续报告成功。
- 终端输入、输出、活跃会话和已停止会话集合必须有边界。
- 授权请求 nonce 必须有长度和时间窗；清理旧 nonce 不得允许旧签名请求重放。
- guest 授权响应必须有读取上限；PTY reader 错误必须可见，Windows 启动测试不能依赖首个输出块。

### Task 1: 远程供应链 fail-closed

**Files:**
- Modify: `qemu-center/src/setup.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/cloudinit.rs`
- Modify: `qemu-center/src/guest.rs`
- Test: existing unit tests in the same files

**Interfaces:**
- Produces `setup::ImagePlan` without an unverifiable-success branch.
- Produces a QEMU installer flow requiring `RDC_QEMU_INSTALLER_SHA256` and matching the downloaded file before NSIS execution.
- Produces PowerShell single-quote escaping for all generated `-Command` paths.

- [x] **Step 1: Write failing tests** for rejected unverified image plans, invalid/mismatched installer hashes, and PowerShell paths containing apostrophes.
- [x] **Step 2: Run the focused qemu-center tests and confirm they fail for the expected reasons.**
- [x] **Step 3: Implement the minimum fail-closed checks, require the installer digest, escape PowerShell literals, and change guest Docker setup to signed apt packages rather than `curl | sh`.
- [x] **Step 4: Run focused qemu-center tests, then the full qemu-center test suite.**

### Task 2: Protected artifact cleanup errors

**Files:**
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `src-tauri/src/services/qemu_loader.py`
- Test: Rust unit tests in `qemu_presets.rs`; Python tests in `test_qemu_loader.py`

**Interfaces:**
- Produces a cleanup helper that treats “not found” as success but propagates every other local/remote cleanup error.
- Produces result merging that changes a successful protected operation to failure when cleanup is unconfirmed.

- [x] **Step 1: Add failing tests** for cleanup-error propagation and loader deletion failure reporting.
- [x] **Step 2: Run the focused Rust/Python tests and confirm the new assertions fail.**
- [x] **Step 3: Implement local/guest cleanup aggregation and return cleanup failure instead of silently discarding it.
- [x] **Step 4: Run the focused tests and the full `src-tauri` Python tests.**

### Task 3: Terminal resource limits and PTY error visibility

**Files:**
- Modify: `src-tauri/src/services/terminal.rs`
- Modify: `src-tauri/src/services/terminal_session.rs`
- Test: Rust unit tests in both terminal modules

**Interfaces:**
- Produces bounded terminal constants for input, output, and active sessions.
- Produces reader-error state visible through `terminal_read`/exit events.
- Produces robust Windows PTY test readiness polling and bounded stopped-session bookkeeping.

- [x] **Step 1: Add failing tests** for output truncation, oversized input rejection, session capacity, and stopped-ID pruning.
- [x] **Step 2: Run the focused terminal tests and confirm they fail.**
- [x] **Step 3: Implement ring-buffer behavior, input/session limits, idle reaping, error propagation, and readiness polling.
- [x] **Step 4: Run all `src-tauri` Rust tests and confirm the PTY regression is fixed.**

### Task 4: Authorization request boundaries and transfer concurrency

**Files:**
- Modify: `authorization-service/src/crypto.rs`
- Modify: `authorization-service/src/routes.rs`
- Modify: `authorization-service/src/store.rs`
- Modify: `src-tauri/src/services/authorization_client.rs`
- Test: authorization-service route/store/crypto tests and authorization client tests

**Interfaces:**
- Session, heartbeat, and execution-grant requests carry a signed/current `iat` time field.
- `used_nonces` pruning is limited to entries outside the accepted freshness window.
- Nonces have a bounded length and the transfer hash is performed outside the global transfer mutex.

- [x] **Step 1: Add failing tests** for stale/missing timestamps, oversized nonces, safe nonce pruning, and transfer capacity re-checking after file hashing.
- [x] **Step 2: Run focused authorization tests and confirm failure.**
- [x] **Step 3: Update signed proof/request types, enforce the time window, prune only expired nonce records, move artifact hashing outside the mutex, and re-check capacity before insertion.
- [x] **Step 4: Run all authorization-service tests and the authorization client tests.**

### Task 5: Guest response size bound and final verification

**Files:**
- Modify: `src-tauri/src/services/qemu_guest.py`
- Test: `src-tauri/src/services/test_qemu_guest.py`

- [x] **Step 1: Add a failing test** for an oversized consume response.
- [x] **Step 2: Run the Python focused test and confirm failure.**
- [x] **Step 3: Add `Content-Length` and bounded `read()` checks for authorization receipts.
- [x] **Step 4: Run all required project checks, lint, and available SAST tools; record unavailable tools without installing dependencies or modifying unrelated files.**
