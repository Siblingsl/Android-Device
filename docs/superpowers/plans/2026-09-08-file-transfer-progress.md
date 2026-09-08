# 文件传输进度与取消 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有文件传输命令和调用行为的前提下，为文件页增加真实可用的传输状态、可取消操作和可选字节进度。

**Architecture:** 保留 `upload_file` / `download_file` 原路径，新增带 `operationId` 的跟踪命令。Rust 用 managed `TransferRegistry` 管理取消标记，用独立的可取消进程执行器读取 ADB 输出并发送 Tauri 生命周期事件；前端先监听事件，再调用新命令，无法取得百分比时显示不确定进度。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tauri 2、Rust 2021、Serde、parking_lot、ADB。

**Spec:** `docs/superpowers/specs/2026-09-08-file-transfer-progress-design.md`

## Global Constraints

- 现有 `upload_file` 和 `download_file` 命令必须继续保留，参数、返回值和成功/失败语义不变。
- ADB 版本或运行环境可能不输出可解析的传输百分比，因此界面不得用时间或假定速度推算百分比。
- 文件页当前限制同一详情页内的并发文件传输；本设计保留该行为。
- 不修改现有 `run_command_timeout`，新增独立的可取消命令执行路径。
- 取消时不得把半截上传暴露为最终远程文件，也不得覆盖用户选择的最终下载文件。
- 旧的错误反馈、重复点击保护和文件列表刷新行为必须继续保留。
- 不添加断点续传、传输队列、后台持久化任务或跨应用恢复。
- 不扩展到 APK 安装和其他长时设备操作。

---

## 文件结构与职责

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/services/transfer.rs` | `FileTransferProgress` 事件载荷、活动传输注册表、ADB 百分比解析和事件发送 |
| `src-tauri/src/services/util.rs` | 新增可取消、可读流式输出的进程执行器；原有执行器不动 |
| `src-tauri/src/services/adb.rs` | 新增 `push_tracked` / `pull_tracked` ADB 包装，复用统一执行器 |
| `src-tauri/src/services/device.rs` | 新增上传/下载跟踪业务逻辑、临时路径、安全落位和事件映射 |
| `src-tauri/src/services/mod.rs` | 注册 `transfer` 服务模块 |
| `src-tauri/src/commands/mod.rs` | 暴露三个新的 Tauri 命令，并管理传输注册表生命周期 |
| `src-tauri/src/lib.rs` | 注册 managed state 和新的 Tauri 命令 |
| `src/types/index.ts` | 定义与 Rust 事件一致的 `FileTransferProgress` 类型 |
| `src/services/deviceService.ts` | 增加三个跟踪传输服务方法；现有方法不变 |
| `src/services/deviceService.test.ts` | 验证新服务方法的命令名和参数映射 |
| `src/pages/DeviceDetail.tsx` | 文件页接入事件监听、百分比/不确定进度、取消、失败重试 |
| `src/pages/DeviceDetail.test.tsx` | 文件页传输事件、取消、卸载清理和旧功能回归测试 |
| `src/i18n/pages/deviceDetail.ts` | 中英文补充取消、进度和取消完成文案 |

每个后端模块只负责自己的边界：命令层不拼接 ADB 参数，ADB 层不处理远程临时文件，前端服务层不解析事件，页面层不直接调用 `tauriInvoke`。

## 接口冻结

Rust 事件载荷：

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferProgress {
    pub operation_id: String,
    pub direction: String,
    pub status: String,
    pub bytes_transferred: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub message: String,
}
```

前端对应类型：

```ts
export type FileTransferDirection = "upload" | "download";
export type FileTransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface FileTransferProgress {
  operationId: string;
  direction: FileTransferDirection;
  status: FileTransferStatus;
  bytesTransferred: number | null;
  totalBytes: number | null;
  percent: number | null;
  message: string;
}
```

Rust registry 和执行器接口：

```rust
#[derive(Clone, Default)]
pub struct TransferRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TransferRegistry {
    pub fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String>;
    pub fn cancel(&self, operation_id: &str) -> bool;
    pub fn finish(&self, operation_id: &str);
}

pub enum CancellableCommandResult {
    Completed(ShellResult),
    Cancelled(ShellResult),
    TimedOut(ShellResult),
}

pub fn run_command_cancellable(
    program: &str,
    args: &[&str],
    timeout: Duration,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> CancellableCommandResult;
```

ADB 包装接口：

```rust
pub fn push_tracked(
    serial: &str,
    local: &str,
    remote: &str,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> CancellableCommandResult;

pub fn pull_tracked(
    serial: &str,
    remote: &str,
    local: &str,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> CancellableCommandResult;
```

Tauri 命令接口：

```rust
pub async fn upload_file_tracked(
    app: tauri::AppHandle,
    registry: tauri::State<'_, TransferRegistry>,
    serial: String,
    local: String,
    remote: String,
    operation_id: String,
) -> ShellResult;

pub async fn download_file_tracked(
    app: tauri::AppHandle,
    registry: tauri::State<'_, TransferRegistry>,
    serial: String,
    remote: String,
    local: String,
    operation_id: String,
) -> ShellResult;

pub fn cancel_file_transfer(
    registry: tauri::State<'_, TransferRegistry>,
    operation_id: String,
) -> bool;
```

## 实施任务

### Task 1: 建立传输事件模型、注册表和进度解析器

**Files:**
- Create: `src-tauri/src/services/transfer.rs`
- Modify: `src-tauri/src/services/mod.rs:1-10`
- Test: `src-tauri/src/services/transfer.rs` 内的 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `serde::Serialize`、`parking_lot::Mutex`、`tauri::AppHandle`。
- Produces: `FileTransferProgress`、`TransferRegistry`、`ParsedProgress`、`parse_adb_progress`、`emit_progress`，供 Task 2、Task 3、Task 4 使用。

- [ ] **Step 1: Write the failing tests**

在 `transfer.rs` 中先写以下测试，测试公开行为而不读取内部 HashMap：

```rust
#[test]
fn progress_serializes_using_frontend_field_names() {
    let payload = FileTransferProgress {
        operation_id: "op-1".into(),
        direction: "upload".into(),
        status: "running".into(),
        bytes_transferred: Some(512),
        total_bytes: Some(1024),
        percent: Some(50),
        message: "上传中".into(),
    };
    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["operationId"], "op-1");
    assert_eq!(value["bytesTransferred"], 512);
    assert_eq!(value["totalBytes"], 1024);
}

#[test]
fn registry_rejects_empty_and_duplicate_ids_and_cleans_finished_ids() {
    let registry = TransferRegistry::default();
    assert!(registry.start(" ").is_err());
    let _token = registry.start("op-1").unwrap();
    assert!(registry.start("op-1").is_err());
    assert!(registry.cancel("op-1"));
    registry.finish("op-1");
    assert!(registry.start("op-1").is_ok());
    assert!(!registry.cancel("missing"));
}

#[test]
fn parser_accepts_cr_refreshed_percent_and_maps_known_total() {
    let parsed = parse_adb_progress("[  0%] file\r[ 50%] file\r[100%] file", Some(2048)).unwrap();
    assert_eq!(parsed.percent, 100);
    assert_eq!(parsed.bytes_transferred, Some(2048));
    assert_eq!(parsed.total_bytes, Some(2048));
}

#[test]
fn parser_ignores_unrelated_numbers_and_unknown_total() {
    assert!(parse_adb_progress("pull 2026 bytes without percent", Some(1)).is_none());
    let parsed = parse_adb_progress("[ 25%] file", None).unwrap();
    assert_eq!(parsed.percent, 25);
    assert_eq!(parsed.bytes_transferred, None);
    assert_eq!(parsed.total_bytes, None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml transfer::tests`

Expected: FAIL because `transfer.rs`, `TransferRegistry`, `FileTransferProgress` and `parse_adb_progress` do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement `TransferRegistry` with `Arc<parking_lot::Mutex<HashMap<String, Arc<AtomicBool>>>>`; reject `operation_id.trim().is_empty()`, use `Ordering::SeqCst` for cancellation, and remove entries in `finish`.

Implement `parse_adb_progress` without adding a regex dependency: scan for ASCII digit runs immediately followed by `%`, use the last match, clamp it to `0..=100`, and only calculate `bytes_transferred = total * percent / 100` when `total` is `Some`.

Implement `emit_progress` with `app.emit("file-transfer-progress", payload)` and convert the emitter error to `String`. Register the module in `services/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml transfer::tests`

Expected: PASS for all transfer model, registry, and parser tests.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/transfer.rs src-tauri/src/services/mod.rs
git commit -m "feat: add transfer progress protocol"
```

### Task 2: 增加可取消的流式进程执行器和 ADB 包装

**Files:**
- Modify: `src-tauri/src/services/util.rs:1-205`
- Modify: `src-tauri/src/services/adb.rs:389-405`
- Test: `src-tauri/src/services/util.rs` 内新增测试模块

**Interfaces:**
- Consumes: Task 1 的 `TransferRegistry` token 和输出回调约定。
- Produces: `CancellableCommandResult`、`run_command_cancellable`、`adb::push_tracked`、`adb::pull_tracked`，供 Task 3 使用；既有 `run_command_timeout` 不变。

- [ ] **Step 1: Write the failing tests**

在 `util.rs` 的测试模块中增加结果分类和取消测试。使用平台原生命令避免依赖 ADB：

```rust
#[test]
fn cancellable_runner_reports_success_for_immediate_command() {
    let cancel = std::sync::atomic::AtomicBool::new(false);
    #[cfg(windows)]
    let (program, args) = ("cmd", vec!["/C", "exit", "0"]);
    #[cfg(not(windows))]
    let (program, args) = ("sh", vec!["-c", "exit 0"]);
    let refs: Vec<&str> = args.iter().copied().collect();
    let result = run_command_cancellable(program, &refs, Duration::from_secs(2), &cancel, |_| {});
    assert!(matches!(result, CancellableCommandResult::Completed(r) if r.success));
}

#[test]
fn cancellable_runner_reports_cancelled_and_stops_long_command() {
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[cfg(windows)]
    let (program, args) = ("cmd", vec!["/C", "ping -n 30 127.0.0.1 > nul"]);
    #[cfg(not(windows))]
    let (program, args) = ("sh", vec!["-c", "sleep 30"]);
    let refs: Vec<&str> = args.iter().copied().collect();
    let cancel_for_worker = cancel.clone();
    let worker = std::thread::spawn(move || {
        run_command_cancellable(program, &refs, Duration::from_secs(20), &cancel_for_worker, |_| {})
    });
    std::thread::sleep(Duration::from_millis(100));
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = worker.join().unwrap();
    assert!(matches!(result, CancellableCommandResult::Cancelled(_)));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml util::tests::cancellable_runner`

Expected: FAIL because the cancellable result type and runner are not defined.

- [ ] **Step 3: Write the minimal implementation**

Add `CancellableCommandResult` and `run_command_cancellable`. Spawn the child with piped stdout/stderr, consume both streams on reader threads, forward each output chunk to the callback, and poll `try_wait()` until completion, timeout, or `cancel.load(Ordering::SeqCst)` becomes true. Reuse the existing `kill_process` platform branch for timeout and cancellation. Preserve stdout, stderr, and exit code in the returned `ShellResult`; label a cancellation as `Cancelled` even when the child exits with the signal/forced-kill code.

Add `push_tracked` and `pull_tracked` next to the existing wrappers, passing the same ADB executable, `-s serial`, `push/pull`, source and destination arguments and the existing 120-second timeout. Do not change `push` or `pull`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml util::tests::cancellable_runner`

Expected: PASS for immediate completion and cancellation; existing Rust tests remain green when run with `cargo test --locked --manifest-path src-tauri/Cargo.toml`.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/util.rs src-tauri/src/services/adb.rs
git commit -m "feat: add cancellable adb process execution"
```

### Task 3: 实现上传/下载跟踪业务和安全临时落位

**Files:**
- Modify: `src-tauri/src/services/device.rs:671-717`
- Test: `src-tauri/src/services/device.rs` 内测试模块，新增临时路径和结果映射测试

**Interfaces:**
- Consumes: Task 1 的 `FileTransferProgress` / `parse_adb_progress` / `emit_progress`，Task 2 的 tracked ADB wrappers。
- Produces: `device::upload_file_tracked` 和 `device::download_file_tracked`，供 Task 4 的命令层调用。

- [ ] **Step 1: Write the failing tests**

先把不依赖真实设备的路径和终态映射测试写入 `device.rs`：

```rust
#[test]
fn tracked_remote_path_keeps_target_separate_from_partial_upload() {
    let staged = tracked_remote_path("/sdcard/report.apk", "op-1");
    assert_eq!(staged, "/sdcard/report.apk.rdc_transfer_op-1.part");
    assert_ne!(staged, "/sdcard/report.apk");
}

#[test]
fn tracked_download_temp_path_is_inside_selected_parent() {
    let temp = tracked_download_temp_path(std::path::Path::new("exports/report.apk"), "op-1");
    assert_eq!(temp, std::path::PathBuf::from("exports/.rdc_pull_op-1"));
}
```

Add a small pure helper test for terminal status selection: `Completed(success=true)` maps to `completed`, `Completed(success=false)` and `TimedOut` map to `failed`, and `Cancelled` maps to `cancelled`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml device::metrics_tests::tracked_`

Expected: FAIL because the tracked path helpers and status mapper do not exist.

- [ ] **Step 3: Write the minimal implementation**

Add `tracked_remote_path` using a sanitized operation ID containing only ASCII letters, digits, `_` and `-`; append `.rdc_transfer_<id>.part` to the trimmed target path. Add `tracked_download_temp_path` beside the selected file using `.rdc_pull_<id>`.

Implement:

```rust
pub fn upload_file_tracked(
    app: &tauri::AppHandle,
    serial: &str,
    local: &str,
    remote: &str,
    operation_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> ShellResult;

pub fn download_file_tracked(
    app: &tauri::AppHandle,
    serial: &str,
    remote: &str,
    local: &str,
    operation_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> ShellResult;
```

Each function emits `queued` then `running`, obtains total bytes from local metadata for upload or a quoted `adb shell stat -c %s` probe for a file download, and passes an output callback to `push_tracked` / `pull_tracked`. The callback parses ADB output and emits only monotonic real percentages.

For upload, push to the unique remote `.part` path, check cancellation, then run the existing ADB shell channel with a safely single-quoted `mv -f <part> <remote>`. On failure or cancellation, run best-effort `rm -f` against only the unique part path. Never remove the original remote target.

For download, preserve the current directory-target branch; for a file target create the parent, pull into the unique temporary directory, move the one pulled entry to the requested final path only after success, and remove the temporary directory on every branch. Emit exactly one terminal event after cleanup. Return the original `ShellResult` shape so the command layer and existing feedback can continue to use it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml device::metrics_tests`

Expected: PASS for path and terminal mapping tests; no ADB device is required. Then run `cargo test --locked --manifest-path src-tauri/Cargo.toml` and expect all existing Rust tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/device.rs
git commit -m "feat: add safe tracked file transfers"
```

### Task 4: 接入 Tauri managed state 和新命令

**Files:**
- Modify: `src-tauri/src/commands/mod.rs:1-8,213-243`
- Modify: `src-tauri/src/lib.rs:11-60`
- Test: `cargo test --locked --manifest-path src-tauri/Cargo.toml` 编译和已有命令回归

**Interfaces:**
- Consumes: Task 1 的 `TransferRegistry`，Task 3 的两个 device tracked 函数。
- Produces: `upload_file_tracked`、`download_file_tracked`、`cancel_file_transfer` Tauri commands and managed `TransferRegistry` state。

- [ ] **Step 1: Write the failing command-contract test**

在 `commands/mod.rs` 的测试模块先写纯函数契约测试，确保命令层把注册失败转换为既有 `ShellResult` 形状：

```rust
#[test]
fn tracked_transfer_error_preserves_shell_result_contract() {
    let result = tracked_transfer_error("duplicate transfer");
    assert!(!result.success);
    assert_eq!(result.stderr, "duplicate transfer");
    assert_eq!(result.exit_code, -1);
}
```

同时列出三个新命令的目标签名，但暂不把它们加入 handler；此步骤只建立可测试的命令层错误转换契约。

- [ ] **Step 2: Run the command-contract test to verify it fails**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::tests::tracked_transfer_error_preserves_shell_result_contract`

Expected: FAIL because `tracked_transfer_error` and the command-layer test module do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement `tracked_transfer_error` to return `ShellResult { success: false, stdout: String::new(), stderr: message.into(), exit_code: -1 }`. Clone `registry.inner()` before the async boundary. On `start` failure return `tracked_transfer_error(error)`; on success call the device function inside the existing `blocking` helper, call `finish` after it returns, and never hold the `State` borrow across `.await`. `cancel_file_transfer` calls `registry.cancel(&operation_id)` and returns the boolean directly.

Register `transfer::TransferRegistry` as managed state before `.invoke_handler(...)`, and add all three commands next to the existing file commands while leaving `upload_file` and `download_file` registered unchanged.

- [ ] **Step 4: Run the compile and Rust tests**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::tests::tracked_transfer_error_preserves_shell_result_contract`

Expected: PASS.

Then run: `cargo check --locked --manifest-path src-tauri/Cargo.toml`

Expected: PASS with no new compiler errors. Then run `cargo test --locked --manifest-path src-tauri/Cargo.toml` and expect all tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: register tracked transfer commands"
```

### Task 5: 暴露前端类型和服务方法

**Files:**
- Modify: `src/types/index.ts:182-204`
- Modify: `src/services/deviceService.ts:1-35, file methods near existing upload/download methods`
- Create: `src/services/deviceService.test.ts`
- Test: `src/services/deviceService.test.ts`

**Interfaces:**
- Consumes: Task 4 的 exact command names and camelCase payload。
- Produces: `FileTransferProgress`, `uploadFileTracked`, `downloadFileTracked`, `cancelFileTransfer`，供 Task 6 使用。

- [ ] **Step 1: Write the failing tests**

Create a Vitest service test with `@tauri-apps/api/core` mocked:

```ts
it("maps tracked upload arguments without changing legacy upload", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });
  await DeviceService.uploadFileTracked("serial-1", "C:/a.txt", "/sdcard/a.txt", "op-1");
  expect(invoke).toHaveBeenCalledWith("upload_file_tracked", {
    serial: "serial-1",
    local: "C:/a.txt",
    remote: "/sdcard/a.txt",
    operationId: "op-1",
  });
});

it("maps tracked download and cancellation commands", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 })
    .mockResolvedValueOnce(true);
  await DeviceService.downloadFileTracked("serial-1", "/sdcard/a.txt", "C:/a.txt", "op-2");
  await DeviceService.cancelFileTransfer("op-2");
  expect(invoke).toHaveBeenNthCalledWith(1, "download_file_tracked", {
    serial: "serial-1",
    remote: "/sdcard/a.txt",
    local: "C:/a.txt",
    operationId: "op-2",
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "cancel_file_transfer", { operationId: "op-2" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/deviceService.test.ts`

Expected: FAIL because the new service methods and event type do not exist.

- [ ] **Step 3: Write the minimal implementation**

Add the exact TypeScript unions and interface from the interface-freeze section. Add service methods that call the existing local `invoke` helper, preserving its `friendlyError` behavior:

```ts
uploadFileTracked: (serial: string, local: string, remote: string, operationId: string) =>
  invoke<ShellResult>("upload_file_tracked", { serial, local, remote, operationId }),
downloadFileTracked: (serial: string, remote: string, local: string, operationId: string) =>
  invoke<ShellResult>("download_file_tracked", { serial, remote, local, operationId }),
cancelFileTransfer: (operationId: string) =>
  invoke<boolean>("cancel_file_transfer", { operationId }),
```

Leave existing `uploadFile` and `downloadFile` method bodies byte-for-byte unchanged.

- [ ] **Step 4: Run tests and type-check**

Run: `npm test -- src/services/deviceService.test.ts`

Expected: PASS. Then run `npm run build` and expect TypeScript and Vite to pass before page integration.

- [ ] **Step 5: Commit**

```powershell
git add src/types/index.ts src/services/deviceService.ts src/services/deviceService.test.ts
git commit -m "feat: expose tracked transfer service"
```

### Task 6: 接入文件页事件状态、取消和不确定进度

**Files:**
- Modify: `src/pages/DeviceDetail.tsx:73-77,1836-1993,2046-2080,2215-2233`
- Modify: `src/pages/DeviceDetail.test.tsx:1-40,170-190,776-900`
- Modify: `src/i18n/pages/deviceDetail.ts:284-306,726-748`
- Test: `src/pages/DeviceDetail.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `FileTransferProgress` and tracked service methods; `@tauri-apps/api/event.listen`。
- Produces: file page UI that shows tracked state, optionally shows `<progress>`, cancels once, ignores stale events, preserves existing retry and picker behavior。

- [ ] **Step 1: Write the failing tests**

Extend the existing service mock with `uploadFileTracked`, `downloadFileTracked`, and `cancelFileTransfer`; mock `@tauri-apps/api/event.listen` so each call stores its callback and returns an async unlisten function. Add tests for these exact scenarios:

```tsx
it("uses tracked upload and renders a real event percentage", async () => {
  const pending = deferred<ShellResult>();
  vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
  vi.mocked(DeviceService.uploadFileTracked).mockReturnValueOnce(pending.promise);
  renderDetail("files");
  await clickUploadAndFlush();
  expect(DeviceService.uploadFileTracked).toHaveBeenCalledWith(
    "device-1-serial",
    "C:/upload.txt",
    "/sdcard/upload.txt",
    expect.any(String),
  );
  emitTransfer({ status: "running", percent: 50, bytesTransferred: 512, totalBytes: 1024 });
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
  pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
});

it("shows indeterminate progress when the backend has no percentage", async () => {
  startPendingTrackedDownload();
  emitTransfer({ status: "running", percent: null, bytesTransferred: null, totalBytes: null });
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByRole("status").textContent).toContain("进行中");
});

it("sends cancellation once and stays silent for a cancelled transfer", async () => {
  startPendingTrackedDownload();
  vi.mocked(DeviceService.cancelFileTransfer).mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: /取消/ }));
  fireEvent.click(screen.getByRole("button", { name: /正在取消|取消/ }));
  expect(DeviceService.cancelFileTransfer).toHaveBeenCalledTimes(1);
  emitTransfer({ status: "cancelled", percent: null, bytesTransferred: null, totalBytes: null });
  expect(screen.queryByText(/失败/)).not.toBeInTheDocument();
});

it("removes the listener on unmount and ignores an event from another operation", async () => {
  const view = renderDetail("files");
  emitTransfer({ operationId: "other-op", status: "running", percent: 90 });
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  view.unmount();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

it("retries with a new operation id without reopening the dialogs", async () => {
  vi.mocked(DeviceService.downloadFileTracked)
    .mockRejectedValueOnce(new Error("download unavailable"))
    .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });
  startDownloadThroughSaveDialog();
  await clickRetryAndFlush();
  expect(DeviceService.downloadFileTracked).toHaveBeenCalledTimes(2);
  expect(new Set(vi.mocked(DeviceService.downloadFileTracked).mock.calls.map((call) => call[3])).size).toBe(2);
  expect(save).toHaveBeenCalledTimes(1);
});
```

Use the existing `deferred`, `renderDetail`, picker mocks and cleanup helpers; do not delete or weaken the already-passing legacy upload/download error, cancellation silence, duplicate blocking, retry and concurrency tests. The helper `emitTransfer` must fill omitted fields from the active operation and dispatch through the captured `listen` callback, so tests exercise the same event filter as production.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/pages/DeviceDetail.test.tsx`

Expected: FAIL because the page still invokes legacy methods, has no event listener, no percentage element, and no cancel button.

- [ ] **Step 3: Write the minimal implementation**

Import `listen` and `FileTransferProgress`. Extend `FileTransferState` with `operationId`, `target`, `status`, `percent`, `bytesTransferred`, `totalBytes`, and `cancelling`; keep `error` and existing retry refs.

Create a per-panel listener readiness promise in `useEffect`: call `listen<FileTransferProgress>("file-transfer-progress", ...)` on mount, resolve readiness before any tracked invoke, update state only when `event.payload.operationId` equals the active operation, and call the returned unlisten function on unmount. If listener setup rejects, resolve readiness with no listener so the command result still controls success/failure.

Generate operation IDs with `crypto.randomUUID()` when available and the deterministic-format fallback ``transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`` otherwise. `runUpload` and `runDownload` must await listener readiness, call tracked methods with the new ID, and preserve the current local/remote retry closures. A new retry must create a new ID and must not reopen `open` or `save`.

Add `cancelTransfer` guarded by `transfer.status === "queued" || transfer.status === "running"` and `!transfer.cancelling`; set `cancelling` before invoking `DeviceService.cancelFileTransfer`, so repeated clicks cannot issue a second command. Do not raise an alert for a normal cancellation response. Keep existing `reportOperationError` for actual command failures.

Render a native `<progress role="progressbar" max={100} value={transfer.percent}>` only when `percent !== null`; otherwise render the existing status text with an indeterminate-progress label. Add a cancel button while active and retain the retry button on `error`. Terminal success refreshes files as before; failed terminal states retain the current error; cancelled terminal states clear the active transfer without an error alert. Continue blocking concurrent upload/download actions while an active transfer exists.

Add Chinese and English keys for `transferRunning`, `transferIndeterminate`, `transferCancelling`, `cancelTransfer`, `transferCancelled`, and `transferPercent` in the existing device detail locale object. Keep current uploading/downloading, success, failure and retry keys unchanged.

- [ ] **Step 4: Run tests and build**

Run: `npm test -- src/pages/DeviceDetail.test.tsx`

Expected: PASS for new tracked transfer tests and all existing file/app/device detail tests in the file.

Then run: `npm run build`

Expected: PASS with no TypeScript errors and no missing event/type imports.

- [ ] **Step 5: Commit**

```powershell
git add src/pages/DeviceDetail.tsx src/pages/DeviceDetail.test.tsx src/i18n/pages/deviceDetail.ts
git commit -m "feat: add file transfer progress and cancellation UI"
```

### Task 7: 完成跨层回归和交付前验证

**Files:**
- Test only: existing project test/build/audit commands
- Review: all files changed by Tasks 1-6 and `docs/superpowers/specs/2026-09-08-file-transfer-progress-design.md`

**Interfaces:**
- Consumes: all tracked transfer interfaces and the committed design/spec.
- Produces: verified working tree with no regressions, no missing translations, and a concise change summary.

- [ ] **Step 1: Run the focused frontend suite**

Run: `npm test -- src/services/deviceService.test.ts src/pages/DeviceDetail.test.tsx`

Expected: PASS, including event cleanup, cancel deduplication, indeterminate progress, retry ID replacement, and all prior file behaviors.

- [ ] **Step 2: Run the full frontend suite and build**

Run: `npm test`

Expected: all test files and tests pass with zero failures.

Run: `npm run build`

Expected: TypeScript and Vite build pass.

- [ ] **Step 3: Run Rust and translation/security checks**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass; any warnings must be pre-existing or directly explained by the tracked transfer implementation.

Run: `python scripts/i18n-audit.py`

Expected: missing translation keys `0`, placeholder mismatches `0`.

Run: `npm audit --audit-level=moderate`

Expected: zero moderate-or-higher vulnerabilities.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only intentional files are changed; no generated or temporary transfer files are present. Verify that legacy `upload_file`, `download_file`, `uploadFile`, and `downloadFile` bodies remain unchanged.

- [ ] **Step 5: Commit verification notes if needed and prepare handoff**

Do not amend functional commits solely to add narration. Report the focused commits, test results, and the fact that the old transfer commands remain available. Do not push to `origin` unless the user explicitly asks.

## Execution order

Execute Tasks 1 through 6 in order because each task consumes the exact interface produced by the previous one. Task 7 is the only completion gate. After every task, inspect `git diff --check` and `git status --short` before starting the next task.
