# Persistent Terminal Sessions Design

## Goal

Add a reliable terminal workflow for device ADB shells and the Windows local shell without removing or changing the existing single-command ADB Shell. The new workflow provides a persistent PTY session, incremental output, an independent terminal window, explicit stop controls, and recoverable session errors.

## Scope

### Included

- Start a persistent device shell for a selected ADB serial.
- Start a persistent local shell using an explicit Windows shell choice: PowerShell or CMD.
- Stream output incrementally to the terminal window through Tauri events.
- Send raw terminal input, including Enter and control-key bytes.
- Stop a session explicitly and clean up its child process.
- Mark sessions as starting, running, stopped, exited, or failed.
- Open one independent terminal window per session and focus an existing window when requested again.
- Reuse the existing shell history and favorite commands without changing their storage keys.

### Not included

- Replacing the existing `DeviceShell` single-command runner.
- Embedding scrcpy or a device screen preview in the terminal window.
- Arbitrary local executable launching from the UI.
- A full terminal multiplexer, session persistence across application restarts, or remote SSH.

## Compatibility constraints

- Existing `DeviceService.shell(serial, command)` remains unchanged.
- Existing `DeviceShell` command history, favorites, copy output, and diagnostic injection remain available.
- No existing Tauri command is renamed or changes its return contract.
- The new session registry is additive and owns only sessions created through the new terminal entry.
- Closing a terminal window stops its session; application shutdown also attempts to stop every owned session.
- Device serials and local shell choices are validated before spawning a process.

## Architecture

The feature has four focused units:

1. `terminalSession` Rust service owns PTY processes, session IDs, writers, and lifecycle state.
2. Tauri commands expose start, write, stop, and list operations with stable JSON contracts.
3. A frontend `terminalSession` service wraps `invoke` and filters the shared output event stream by session ID.
4. `TerminalPage` renders a compact terminal window; the existing device detail page only adds an entry action and does not host the live stream itself.

The host PTY is created with `portable-pty`. Device sessions launch the configured ADB binary with `-s <serial> shell`; local sessions launch only the selected PowerShell or CMD executable. A reader task emits small output chunks through one Tauri event name, carrying the session ID and stream metadata. The UI appends chunks in order and caps the rendered buffer at 200,000 characters while keeping a clear-output action local to the window.

## Tauri contracts

The new commands use camelCase JSON fields at the frontend boundary:

```text
terminal_session_start({ kind: "device", serial: string })
  -> { id: string, kind: "device" | "local", title: string, status: "starting" | "running" }

terminal_session_start({ kind: "local", shell: "powershell" | "cmd" })
  -> same session object

terminal_session_write({ id: string, data: string }) -> { success: boolean, error: string }
terminal_session_stop({ id: string }) -> { success: boolean, error: string }
terminal_session_list() -> session objects
```

The shared event payload is:

```text
terminal://output -> {
  sessionId: string,
  kind: "stdout" | "stderr" | "exit",
  data: string,
  status?: "running" | "stopped" | "exited" | "failed",
  exitCode?: number
}
```

The frontend never constructs a shell command from free-form executable input. The only free-form input sent to a device or local shell is terminal keystroke data after a session has been created.

## User flow

### Device terminal

From an existing device detail view, the user chooses “独立终端”. The app starts a device session using the current device serial, opens/focuses the terminal window, and shows the serial in the title bar. If the device is offline or ADB rejects the spawn, the window shows the actionable error and keeps the existing single-command shell usable.

### Local terminal

The terminal entry offers “电脑本地终端” with a small shell selector. PowerShell is the default on Windows. CMD remains available for scripts that require cmd semantics. The window title identifies the selected shell, and no device serial is required.

### Lifecycle

The terminal window shows a small status badge, a stop button, a clear-output button, and a close action. Stop is idempotent. A natural process exit is rendered as a final status line rather than treated as a UI crash. If the window closes before the process exits, the frontend invokes stop during cleanup and the Rust registry also reclaims the process handle.

## Error handling

- Empty or unknown session IDs return a structured failure without touching another session.
- Device sessions reject an empty serial before spawning ADB.
- Local sessions reject shell values other than `powershell` and `cmd`.
- Failed spawn emits an exit/failure event and removes the half-created session.
- Failed writes keep the session visible as failed and display the backend reason.
- Repeated stop calls return success when the session is already stopped.
- Event listeners are removed when the terminal page unmounts.

## Testing strategy

- Rust unit tests validate request validation, shell selection, session ID lookup, idempotent stop behavior, and output/status event mapping without requiring a real Android device.
- Frontend service tests validate command payloads and event filtering.
- `TerminalPage` tests validate local/device start states, streamed output, Enter/input forwarding, clear output, stop, natural exit, and failed spawn feedback.
- Existing `DeviceShell` and all existing page/service tests must remain green.
- Production build and `cargo test --lib` are required before committing.

## Delivery order

1. Add the Rust session contracts and registry with tests.
2. Add the frontend session service and terminal page with tests.
3. Add the independent-window launcher and device/local entry points.
4. Run the full regression suite, commit each stable slice, and push the branch.
