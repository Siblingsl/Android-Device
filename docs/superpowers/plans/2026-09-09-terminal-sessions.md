# Persistent Terminal Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent device and local terminal sessions in independent Tauri windows while keeping the existing single-command ADB Shell unchanged.

**Architecture:** Add a Rust `TerminalRegistry` backed by `portable-pty` for process ownership, input, output events, and lifecycle cleanup. Add a small frontend service that wraps the new Tauri commands and output event, then render a route outside `AppLayout` so the terminal window stays compact and independent. Existing Shell controls continue using `DeviceService.shell`.

**Tech Stack:** React 19, TypeScript, React Router HashRouter, Tauri 2, Rust 2021, `portable-pty` 0.9.0, Vitest, Testing Library, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-09-terminal-sessions-design.md`

## Global Constraints

- Existing `DeviceService.shell(serial, command)` remains unchanged.
- Existing `DeviceShell` command history, favorites, copy output, and diagnostic injection remain available.
- No existing Tauri command is renamed or changes its return contract.
- The new session registry is additive and owns only sessions created through the new terminal entry.
- Closing a terminal window stops its session; application shutdown also attempts to stop every owned session.
- Device serials and local shell choices are validated before spawning a process.
- The frontend never constructs a shell command from free-form executable input.
- Existing `DeviceShell` and all existing page/service tests must remain green.
- `Reference_Projects/` is not a project source directory and must not be staged or modified.

---

### Task 1: Add the Rust terminal session domain and PTY registry

**Files:**
- Create: `src-tauri/src/services/terminal.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: `src-tauri/src/services/terminal.rs` unit test module

**Interfaces:**
- Produces `TerminalStartRequest`, `TerminalSessionInfo`, `TerminalOutputEvent`, `TerminalCommandResult`, and `TerminalRegistry` for Tasks 2–5.
- Produces `terminal::start(app, registry, request) -> Result<TerminalSessionInfo, String>`.
- Produces `terminal::write(registry, id, data) -> TerminalCommandResult`.
- Produces `terminal::stop(registry, id) -> TerminalCommandResult`.
- Produces `terminal::list(registry) -> Vec<TerminalSessionInfo>`.
- Emits the event name `terminal://output` with the exact payload fields from the spec.

- [ ] **Step 1: Add the dependency and write failing validation tests**

Add `portable-pty = "0.9.0"` to the Rust dependencies. Before implementing the registry, add tests for the pure request rules and shell selection:

```rust
#[test]
fn rejects_empty_device_serial() {
    let request = TerminalStartRequest {
        kind: "device".into(),
        serial: "  ".into(),
        shell: String::new(),
    };
    assert_eq!(validate_request(&request), Err("device serial is required".into()));
}

#[test]
fn accepts_only_supported_local_shells() {
    let powershell = local_command("powershell").unwrap();
    assert_eq!(powershell.program, "powershell.exe");
    assert!(local_command("bash").is_err());
}

#[test]
fn rejects_unknown_session_ids_without_mutating_the_registry() {
    let registry = TerminalRegistry::default();
    let result = write(&registry, "missing", "echo\r".into());
    assert!(!result.success);
    assert_eq!(list(&registry).len(), 0);
}
```

- [ ] **Step 2: Run the focused Rust tests and verify they fail for the missing implementation**

Run `cargo test --lib services::terminal` from `src-tauri`. Expected result: compilation/test failure because `terminal.rs`, its request validator, shell selector, and registry do not exist yet.

- [ ] **Step 3: Implement the minimal session model and validation**

Define the serializable types with `#[serde(rename_all = "camelCase")]`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartRequest {
    pub kind: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub shell: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub kind: String,
    pub data: String,
    pub status: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandResult {
    pub success: bool,
    pub error: String,
}
```

Implement `validate_request` so `kind == "device"` requires a non-empty serial and `kind == "local"` requires `shell == "powershell" || shell == "cmd"`. Implement `local_command` with the Windows PowerShell and CMD executables only; do not accept an executable path from the request.

- [ ] **Step 4: Implement PTY ownership and lifecycle methods**

Store the registry in `Arc<Mutex<HashMap<String, TerminalEntry>>>`. Each entry owns the PTY writer, child handle, session info, and a stopped flag. Use `portable_pty::native_pty_system().openpty(...)`, spawn either `adb -s <serial> shell` or the selected local shell, and start a reader thread that emits UTF-8-lossy chunks through `AppHandle::emit("terminal://output", TerminalOutputEvent { ... })`.

Use `Uuid::new_v4()` for IDs. `write` locks only the selected writer, writes UTF-8 input, and flushes it. `stop` removes the entry, marks it stopped, kills the child, and returns success for a repeated stop. The reader emits an `exit` event with `exited`, `stopped`, or `failed` status and the optional exit code. Add `stop_all` for application shutdown.

- [ ] **Step 5: Run the focused Rust tests and commit the stable Rust slice**

Run `cargo test --lib services::terminal` and then `cargo test --lib`. Expected result: the new unit tests and the existing Rust suite pass. Run `git diff --check`, stage only `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/services/mod.rs`, and `src-tauri/src/services/terminal.rs`, then commit:

```text
feat: add persistent terminal session registry
```

Push the branch before moving to Task 2.

### Task 2: Expose terminal sessions through Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/services/terminal.rs` command-facing contract tests

**Interfaces:**
- Consumes all public types and methods from Task 1.
- Produces the Tauri commands `terminal_session_start`, `terminal_session_write`, `terminal_session_stop`, and `terminal_session_list`.

- [ ] **Step 1: Write failing command registration/contract tests**

Add Rust tests around the command-facing service calls that assert a device request is passed to the device launcher, a local request is passed to the selected local shell, and an unknown session write returns `{ success: false, error: ... }`. Keep the tests independent of a real Android device by testing validation before spawn and registry lookup separately.

- [ ] **Step 2: Run the focused tests and verify the command surface is missing**

Run `cargo test --lib services::terminal`. Expected result: the new command contract tests fail because the Tauri wrappers and registrations are not present.

- [ ] **Step 3: Add the command wrappers and managed state**

Add the wrappers to `src-tauri/src/commands/mod.rs`:

```rust
#[tauri::command]
pub async fn terminal_session_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, terminal::TerminalRegistry>,
    request: terminal::TerminalStartRequest,
) -> Result<terminal::TerminalSessionInfo, String> {
    terminal::start(app, state.inner().clone(), request)
}

#[tauri::command]
pub async fn terminal_session_write(
    state: tauri::State<'_, terminal::TerminalRegistry>,
    id: String,
    data: String,
) -> terminal::TerminalCommandResult {
    terminal::write(state.inner(), &id, &data)
}

#[tauri::command]
pub async fn terminal_session_stop(
    state: tauri::State<'_, terminal::TerminalRegistry>,
    id: String,
) -> terminal::TerminalCommandResult {
    terminal::stop(state.inner(), &id)
}

#[tauri::command]
pub async fn terminal_session_list(
    state: tauri::State<'_, terminal::TerminalRegistry>,
) -> Vec<terminal::TerminalSessionInfo> {
    terminal::list(state.inner())
}
```

Register `TerminalRegistry::default()` with `.manage(...)` and register all four commands in `tauri::generate_handler!`. Add an application exit hook that calls `stop_all` before the process exits.

- [ ] **Step 4: Run the Rust suite and commit the command slice**

Run `cargo test --lib`. Expected result: all Rust tests pass. Run `git diff --check`, stage only the command and lib files, and commit:

```text
feat: expose terminal sessions through tauri
```

Push the branch.

### Task 3: Add the frontend terminal service and route page

**Files:**
- Create: `src/services/terminalSessionService.ts`
- Create: `src/services/terminalSessionService.test.ts`
- Create: `src/pages/Terminal.tsx`
- Create: `src/pages/Terminal.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/pages/common.ts`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes the four Tauri commands and `terminal://output` event from Task 2.
- Produces `terminalSessionService.startDevice(serial)`, `startLocal(shell)`, `write(id, data)`, `stop(id)`, `list()`, and `listen(handler)`.
- Produces a `TerminalPage` route that renders without `AppLayout`.

- [ ] **Step 1: Write failing service tests**

Mock `@tauri-apps/api/core` and `@tauri-apps/api/event`, then assert the service sends the exact payloads:

```ts
it("starts a device session with its serial", async () => {
  await terminalSessionService.startDevice("emulator-5554");
  expect(invoke).toHaveBeenCalledWith("terminal_session_start", {
    request: { kind: "device", serial: "emulator-5554" },
  });
});

it("forwards output only through the shared terminal event", async () => {
  const handler = vi.fn();
  await terminalSessionService.listen(handler);
  expect(listen).toHaveBeenCalledWith("terminal://output", expect.any(Function));
});
```

- [ ] **Step 2: Run the focused frontend tests and verify they fail**

Run `npx vitest run src/services/terminalSessionService.test.ts`. Expected result: failure because the service file and methods do not exist.

- [ ] **Step 3: Implement the service wrapper**

Use the exact public methods:

```ts
import { listen as tauriListen } from "@tauri-apps/api/event";

export const terminalSessionService = {
  startDevice: (serial: string) => invoke<TerminalSessionInfo>("terminal_session_start", { request: { kind: "device", serial } }),
  startLocal: (shell: TerminalLocalShell) => invoke<TerminalSessionInfo>("terminal_session_start", { request: { kind: "local", shell } }),
  write: (id: string, data: string) => invoke<TerminalCommandResult>("terminal_session_write", { id, data }),
  stop: (id: string) => invoke<TerminalCommandResult>("terminal_session_stop", { id }),
  list: () => invoke<TerminalSessionInfo[]>("terminal_session_list"),
  listen: (handler: (event: TerminalOutputEvent) => void) => tauriListen<TerminalOutputEvent>("terminal://output", (event) => handler(event.payload)),
};
```

Export the session and event types. Preserve `friendlyError` behavior by using the same invoke wrapper pattern as `deviceService`.

- [ ] **Step 4: Write the failing `TerminalPage` behavior tests**

Test the page with a session query parameter and mocked service methods. Cover initial title/status, output append, failed write feedback, Enter sending `input + "\r"`, Ctrl+C sending `"\u0003"`, clear output, stop, and exit status. Keep one assertion per behavior.

- [ ] **Step 5: Implement the compact terminal page and route**

Add a root-level `terminal` route before the `AppLayout` route. The page reads `session` from `useSearchParams`, subscribes to output on mount, appends output with a 200,000-character cap, and unregisters the listener on unmount. The command line sends the current line plus `\r` on Enter, sends `\u0003` on Ctrl+C, and clears itself only after a successful write. Render the status badge, output area, input line, Stop, Clear, and Copy buttons with translated labels.

On unmount, call `terminalSessionService.stop(sessionId)` and ignore the result so closing a window is safe. If the session query is missing, render an actionable empty state rather than invoking a blank ID.

- [ ] **Step 6: Add translations and focused styling, then verify and commit**

Add Chinese and English keys for the terminal title, device/local labels, PowerShell/CMD options, statuses, input placeholder, stop, clear, copy, missing session, and failure messages. Add scoped `.terminal-page`, `.terminal-output`, `.terminal-toolbar`, and `.terminal-input` styles that use the existing color tokens, preserve keyboard focus, and respect `prefers-reduced-motion`.

Run `npx vitest run src/services/terminalSessionService.test.ts src/pages/Terminal.test.tsx`, then `npx tsc --noEmit`. Expected result: all focused tests and type checking pass. Commit only the frontend service, page, route, i18n, and CSS files:

```text
feat: add persistent terminal page
```

Push the branch.

### Task 4: Add independent window launching and existing UI entry points

**Files:**
- Create: `src/lib/terminalWindow.ts`
- Create: `src/lib/terminalWindow.test.ts`
- Modify: `src/components/device/DeviceShell.tsx`
- Create: `src/components/device/DeviceShell.test.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/components/layout/ToolLauncher.tsx`
- Modify: `src/i18n/pages/common.ts`

**Interfaces:**
- Consumes `terminalSessionService` from Task 3.
- Produces `openTerminalWindow(session)` and two user-visible entry points: device independent terminal and local terminal.

- [ ] **Step 1: Write failing launcher tests**

Mock `@tauri-apps/api/webviewWindow` and assert that opening a session creates a window with a stable `terminal-<sessionId>` label and a HashRouter URL containing the encoded session ID. Assert that requesting the same label focuses the existing window instead of creating a second one.

- [ ] **Step 2: Run the launcher tests and verify they fail**

Run `npx vitest run src/lib/terminalWindow.test.ts`. Expected result: failure because the launcher does not exist.

- [ ] **Step 3: Implement stable independent-window creation**

Implement `openTerminalWindow(session)` using Tauri `WebviewWindow`. Use `index.html#/terminal?session=<encoded id>` as the URL, a 960×640 default size, and `resizable: true`. Reuse an existing window by label and call `show()` plus `setFocus()`; surface creation failures to the caller so the existing page can report them.

- [ ] **Step 4: Add the device entry without changing existing Shell behavior**

Add an optional `onOpenTerminal?: () => void` prop to `DeviceShell`. Render one compact secondary button in the card action area. In `DeviceDetail`, start a device session with the current serial, call `openTerminalWindow`, and send the existing status message on success or the existing error feedback path on failure. Leave the current command input and `DeviceService.shell` call untouched.

- [ ] **Step 5: Add the local terminal entry to the tools menu**

Add a “电脑本地终端” tool item that opens a small shell-choice prompt or compact selector, defaults to PowerShell, calls `terminalSessionService.startLocal(shell)`, and opens the returned session. Keep the existing navigation links and tool menu layout unchanged.

- [ ] **Step 6: Run focused UI tests and commit the launcher slice**

Run `npx vitest run src/lib/terminalWindow.test.ts src/components/device/DeviceShell.test.tsx src/pages/DeviceDetail.test.tsx`. Expected result: new launcher/entry tests and all existing device detail tests pass. Commit only the launcher and entry files:

```text
feat: open terminals in independent windows
```

Push the branch.

### Task 5: Full verification and delivery checkpoint

**Files:**
- Modify: none unless a failing regression test identifies a defect in Tasks 1–4

- [ ] **Step 1: Run the complete frontend test suite**

Run `npm test -- --run`. Expected result: all existing tests plus the terminal service, page, launcher, and entry tests pass.

- [ ] **Step 2: Run type checking and production build**

Run `npx tsc --noEmit` and `npm run build`. Expected result: both succeed. Treat any existing Vite chunk-size advisory as a warning, not a functional failure.

- [ ] **Step 3: Run the complete Rust test suite**

Run `cargo test --lib` from `src-tauri`. Expected result: the existing Rust tests and all terminal session tests pass.

- [ ] **Step 4: Review the final diff and repository boundary**

Run `git diff --check`, `git status --short`, and `git diff origin/main...HEAD --stat`. Confirm that no file under `Reference_Projects/` is staged or modified and that `DeviceService.shell` remains unchanged.

- [ ] **Step 5: Push the final verified branch state**

Run `git push origin codex/device-status-board-ui` and record the final commit hash, test counts, build result, and any non-failing warnings in the delivery message.
