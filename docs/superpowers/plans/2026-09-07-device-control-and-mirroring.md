# Device Control and Mirroring Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the device detail control and scrcpy experience without changing existing device-management commands, entry points, or data models.

**Architecture:** Keep `DeviceService` and the existing Rust commands as the only device-operation boundary. Add small, testable helpers for shell-result validation, action lifecycle, preview refresh state, and input validation; then move the control UI into focused components while keeping `DeviceDetail.tsx` responsible for device data and tab composition.

**Tech Stack:** React 19, TypeScript, Tauri 2, Zustand, Vitest, existing `DeviceService`, existing Rust scrcpy/ADB commands, CSS variables in `src/styles/global.css`.

**Spec:** `docs/superpowers/specs/2026-09-07-device-control-and-mirroring-design.md`

## Global Constraints

- Do not embed the scrcpy video stream into the WebView or introduce a new video codec/window-injection path.
- Do not delete the existing independent scrcpy window, screenshot preview, or mouse click/drag/wheel/right-click/middle-click controls.
- Do not modify Rust command names, command parameters, or the meaning of existing settings fields.
- Do not change device, container, volume, or auto-start data models.
- `ShellResult.success === false` is always a failure, even when the Promise resolves normally.
- Error priority is `stderr` → `stdout` → the page's localized fallback message.
- Hidden pages and offline devices must not keep screenshot polling active.
- Keep Chinese and English dictionaries in sync; Chinese remains the source dictionary.
- Every production behavior change must have a failing test observed before its implementation.
- Before completion, run the full test command and `npm run build` and report the actual results.

## File Map

Create these focused files:

- `src/lib/deviceActions.ts` — shell-result failure extraction and action lifecycle helper.
- `src/lib/deviceActions.test.ts` — unit tests for result validation, error normalization, and `finally` recovery.
- `src/lib/devicePreview.ts` — pure preview state and refresh scheduling helpers.
- `src/lib/devicePreview.test.ts` — preview state, pause/resume, and stale-timer tests.
- `src/lib/deviceInput.ts` — text/clipboard validation and screen keyboard shortcut mapping.
- `src/lib/deviceInput.test.ts` — input validation and shortcut guard tests.
- `src/components/device/DevicePreview.tsx` — screenshot preview, image coordinate mapping, mouse gestures, and preview toolbar.
- `src/components/device/DeviceControlPanel.tsx` — navigation/status/display controls and text/clipboard input.
- `src/components/device/DeviceShell.tsx` — Shell input, output, favorites, and history.

Modify these existing files:

- `package.json` and `package-lock.json` — add the test command and Vitest development dependency.
- `src/pages/DeviceDetail.tsx` — compose the new device components and pass existing device/service callbacks.
- `src/i18n/pages/deviceDetail.ts` — add matching Chinese and English strings for preview states, validation, action failures, and keyboard hints.
- `src/styles/global.css` — add focused preview/control/shell styles without changing the existing page grid contract.

## Task 1: Establish test runner and shell-result helpers

**Files:**

- Create: `src/lib/deviceActions.ts`
- Create: `src/lib/deviceActions.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces `shellResultFailure(result, fallback): string | null`.
- Produces `normalizeActionError(error, fallback): Error`.

- [ ] **Step 1: Add the failing result-validation test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeActionError, shellResultFailure } from "./deviceActions";

describe("shellResultFailure", () => {
  it("returns stderr when a resolved shell result reports failure", () => {
    expect(
      shellResultFailure(
        { success: false, stdout: "", stderr: "permission denied", exitCode: 1 },
        "操作失败",
      ),
    ).toBe("permission denied");
  });

  it("uses the fallback when a failed result has no output", () => {
    expect(shellResultFailure({ success: false, stdout: "", stderr: "" }, "操作失败")).toBe(
      "操作失败",
    );
  });

  it("normalizes non-Error exceptions", () => {
    expect(normalizeActionError("ADB unavailable", "操作失败").message).toBe("ADB unavailable");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the helper is missing**

Run: `npm test -- src/lib/deviceActions.test.ts`

Expected: FAIL with the module or export not found, not a passing test.

- [ ] **Step 3: Add the minimal Vitest setup and helper implementation**

Add the `test` script and `vitest` dev dependency. Implement `shellResultFailure` and `normalizeActionError`; keep the failure priority exactly as follows:

```ts
export type ShellResultLike = {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export function shellResultFailure(result: ShellResultLike, fallback: string): string | null {
  if (result.success) return null;
  return (result.stderr || result.stdout || fallback).trim() || fallback;
}

export function normalizeActionError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim()) return error;
  const message = String(error ?? "").trim();
  return new Error(message || fallback);
}
```

- [ ] **Step 4: Run the focused tests and commit the self-contained result helpers**

Run: `npm test -- src/lib/deviceActions.test.ts`

Expected: all focused tests pass.

Commit: `git add package.json package-lock.json src/lib/deviceActions.ts src/lib/deviceActions.test.ts; git commit -m "test: add device result helpers"`

## Task 2: Make existing control and Shell actions honest about failures

**Files:**

- Modify: `src/pages/DeviceDetail.tsx` (current `Control` and Shell action logic)
- Modify: `src/i18n/pages/deviceDetail.ts`
- Test: `src/lib/deviceActions.test.ts`

**Interfaces:**

- Consumes `shellResultFailure` and `normalizeActionError` from Task 1.
- Produces `runDeviceAction<T>(operation, options): Promise<T>` where `options` includes `fallback`, optional `onStart`, `onSuccess`, `onError`, and `onFinally` callbacks.
- Produces `formatShellOutput(stdout, stderr, exitCode): string` for the shared Shell/scrcpy diagnostic view.
- Keeps `DeviceService` method signatures unchanged.
- Keeps existing `rdc.shell.history` and `rdc.shell.favorites` storage keys unchanged.

- [ ] **Step 1: Add the failing lifecycle test before implementing `runDeviceAction`**

```ts
import { expect, it } from "vitest";
import { runDeviceAction } from "./deviceActions";

it("runs onFinally after a resolved failed ShellResult", async () => {
  const events: string[] = [];

  await expect(
    runDeviceAction(
      async () => ({ success: false, stdout: "device offline", stderr: "", exitCode: 1 }),
      {
        fallback: "设备操作失败",
        onStart: () => events.push("start"),
        onError: (error) => events.push(`error:${error.message}`),
        onFinally: () => events.push("finally"),
      },
    ),
  ).rejects.toThrow("device offline");

  expect(events).toEqual(["start", "error:device offline", "finally"]);
});
```

- [ ] **Step 2: Run the focused lifecycle test and verify the missing-helper failure**

Run: `npm test -- src/lib/deviceActions.test.ts -t "resolved failed"`

Expected: FAIL because `runDeviceAction` is not implemented yet.

- [ ] **Step 3: Implement `runDeviceAction` with `try/catch/finally` and resolved-result failure checking**

The implementation must call `onStart` once, call `onSuccess` only after the operation returns a non-failing `ShellResultLike`, call `onError` with a normalized `Error`, and always call `onFinally` once. It must rethrow the normalized error so callers can decide whether to show a status-bar message, output diagnostic, or alert.

```ts
export interface DeviceActionOptions<T extends ShellResultLike> {
  fallback: string;
  onStart?: () => void | Promise<void>;
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onFinally?: () => void | Promise<void>;
}

export async function runDeviceAction<T extends ShellResultLike>(
  operation: () => Promise<T>,
  options: DeviceActionOptions<T>,
): Promise<T> {
  await options.onStart?.();
  try {
    const result = await operation();
    const failure = shellResultFailure(result, options.fallback);
    if (failure) throw new Error(failure);
    await options.onSuccess?.(result);
    return result;
  } catch (error) {
    const normalized = normalizeActionError(error, options.fallback);
    await options.onError?.(normalized);
    throw normalized;
  } finally {
    await options.onFinally?.();
  }
}
```

- [ ] **Step 4: Add the failing output-format test and implement the formatter**

```ts
it("preserves stderr and exit code in command diagnostics", () => {
  expect(formatShellOutput("stdout text", "stderr text", 7)).toBe(
    "stdout text\nstderr text\n[exit 7]",
  );
});
```

Import `formatShellOutput` in the test. Implement it so it omits empty streams without adding blank lines and always includes `[exit N]` when an exit code is provided:

```ts
export function formatShellOutput(stdout: string, stderr: string, exitCode?: number): string {
  const lines = [stdout.trim(), stderr.trim()].filter(Boolean);
  if (exitCode !== undefined) lines.push(`[exit ${exitCode}]`);
  return lines.join("\n");
}
```

- [ ] **Step 5: Replace the local `act` implementation with the shared lifecycle**

For every button action that returns `ShellResult`, treat `success: false` as an error, write the diagnostic to the Shell output when the action is in the control area, and restore the busy state in `onFinally`. Preserve the existing labels and refresh the screenshot only after success.

- [ ] **Step 6: Harden `runShell`**

Wrap the Shell call with the same lifecycle. On failure, render stdout/stderr plus `[exit N]` in the output area, set the localized failure status, do not add a failed command twice to history, and always re-enable the Run button.

- [ ] **Step 7: Run focused tests and the TypeScript build**

Run: `npm test -- src/lib/deviceActions.test.ts; npm run build`

Expected: focused tests pass and the build exits with code 0.

- [ ] **Step 8: Commit the failure-feedback regression fix**

Commit: `git add src/pages/DeviceDetail.tsx src/i18n/pages/deviceDetail.ts src/lib/deviceActions.test.ts; git commit -m "fix: surface device control failures"`

## Task 3: Add a testable screenshot-preview state and refresh controller

**Files:**

- Create: `src/lib/devicePreview.ts`
- Create: `src/lib/devicePreview.test.ts`

**Interfaces:**

- Produces `PreviewState` with `status: "empty" | "loading" | "ready" | "error"`, `image`, `path`, `updatedAt`, and `error`.
- Produces `startPreviewRequest(previous): PreviewState`.
- Produces `finishPreviewRequest(previous, result, now): PreviewState`.
- Produces `failPreviewRequest(previous, message): PreviewState`.
- Produces `emptyPreview(): PreviewState` and `canRefreshPreview({ disabled, visible }): boolean`.
- Produces a refresh gate that prevents overlapping timers and exposes `pause()`, `resume()`, and `dispose()`.

- [ ] **Step 1: Write the failing state-transition tests**

```ts
it("keeps the last successful image when a later screenshot fails", () => {
  const ready = finishPreviewRequest(
    startPreviewRequest(emptyPreview()),
    { success: true, base64: "abc", path: "C:\\shots\\one.png" },
    1000,
  );

  const failed = failPreviewRequest(ready, "ADB timeout");

  expect(failed.status).toBe("error");
  expect(failed.image).toBe("data:image/png;base64,abc");
  expect(failed.path).toBe("C:\\shots\\one.png");
  expect(failed.error).toBe("ADB timeout");
});
```

- [ ] **Step 2: Run the focused preview test and verify it fails for the missing module/state**

Run: `npm test -- src/lib/devicePreview.test.ts`

Expected: FAIL because the preview state helpers do not exist yet.

- [ ] **Step 3: Implement the minimal state transitions**

`finishPreviewRequest` must reject unsuccessful screenshot results through the error path, convert non-empty base64 into a data URL, preserve the previous image/path on failure, and update `updatedAt` only on success.

```ts
export function emptyPreview(): PreviewState {
  return { status: "empty", image: null, path: "", updatedAt: null, error: "" };
}

export function startPreviewRequest(previous: PreviewState): PreviewState {
  return { ...previous, status: "loading", error: "" };
}

export function finishPreviewRequest(
  previous: PreviewState,
  result: { success: boolean; base64?: string; path?: string; error?: string },
  now: number,
): PreviewState {
  if (!result.success) return failPreviewRequest(previous, result.error || "截图失败");
  return {
    ...previous,
    status: "ready",
    image: result.base64 ? `data:image/png;base64,${result.base64}` : previous.image,
    path: result.path || previous.path,
    updatedAt: now,
    error: "",
  };
}
```

- [ ] **Step 4: Add timer pause/resume tests with fake timers**

```ts
import { vi } from "vitest";

it("does not create duplicate refresh timers after pause and resume", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const gate = createPreviewRefreshGate(refresh, 2000);

  gate.resume();
  gate.resume();
  vi.advanceTimersByTime(1999);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);

  gate.pause();
  gate.resume();
  gate.dispose();
  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
```

- [ ] **Step 5: Implement the refresh gate**

Keep a single timer handle. `pause()` clears it, `resume()` does nothing when paused state is false or a timer already exists, and `dispose()` clears the handle permanently. The caller must gate `resume()` on `document.visibilityState === "visible"` and the device online flag.

```ts
export function createPreviewRefreshGate(refresh: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  return {
    resume() {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) refresh();
      }, delayMs);
    },
    pause() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      disposed = true;
    },
  };
}
```

- [ ] **Step 6: Add the failing eligibility test and implement `canRefreshPreview`**

```ts
it("does not refresh when the device is offline or the page is hidden", () => {
  expect(canRefreshPreview({ disabled: true, visible: true })).toBe(false);
  expect(canRefreshPreview({ disabled: false, visible: false })).toBe(false);
  expect(canRefreshPreview({ disabled: false, visible: true })).toBe(true);
});
```

Run: `npm test -- src/lib/devicePreview.test.ts -t "offline"`

Expected: FAIL before implementing the helper. Then implement it as `!disabled && visible` and rerun the focused test.

```ts
export function canRefreshPreview(input: { disabled: boolean; visible: boolean }): boolean {
  return !input.disabled && input.visible;
}
```

- [ ] **Step 7: Run focused preview tests and commit**

Run: `npm test -- src/lib/devicePreview.test.ts`

Expected: all preview state and timer tests pass.

Commit: `git add src/lib/devicePreview.ts src/lib/devicePreview.test.ts; git commit -m "feat: add resilient screenshot preview state"`

## Task 4: Extract and integrate `DevicePreview`

**Files:**

- Create: `src/components/device/DevicePreview.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/i18n/pages/deviceDetail.ts`
- Modify: `src/styles/global.css`

**Interfaces:**

- `DevicePreview` accepts `serial`, optional `resolution`, `disabled`, `scrcpyStatus`, `onStatus`, `onDiagnostic`, and `onAction(label, operation)`.
- It emits no new backend calls; it uses the existing `DeviceService.screenshot`, `tap`, `swipe`, `home`, and `back` methods.
- It calls an `onAction` callback for actions that need the page-level status/busy policy.

- [ ] **Step 1: Implement `DevicePreview` around the existing screen interaction semantics**

Move the current screen-area mouse behavior without changing coordinate mapping: click = tap, drag = swipe, wheel = swipe, right-click = BACK, middle-click = HOME, double-click = two taps. Add a focusable screen container and keep all toolbar clicks from bubbling into screen actions.

- [ ] **Step 2: Implement the four visible preview states**

Use the state helpers from Task 3. Show an explicit refresh CTA for `empty`, a lightweight loading state for `loading`, the image and timestamp for `ready`, and the error plus retry action for `error`. Keep the previous image in the error state.

- [ ] **Step 3: Wire visibility and device-online pause behavior**

Listen to `visibilitychange`, clear timers on serial change/unmount, and do not call screenshot while the device is disabled/offline. Do not start automatic refresh until the user enables it or a successful preview exists.

- [ ] **Step 4: Run build and preview tests, then commit**

Run: `npm test -- src/lib/devicePreview.test.ts; npm run build`

Expected: tests pass and TypeScript/Vite build exits with code 0.

Commit: `git add src/components/device/DevicePreview.tsx src/pages/DeviceDetail.tsx src/i18n/pages/deviceDetail.ts src/styles/global.css src/lib/devicePreview.test.ts; git commit -m "feat: improve device screenshot preview"`

## Task 5: Extract the control panel and add input/keyboard safeguards

**Files:**

- Create: `src/lib/deviceInput.ts`
- Create: `src/lib/deviceInput.test.ts`
- Create: `src/components/device/DeviceControlPanel.tsx`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/i18n/pages/deviceDetail.ts`
- Modify: `src/styles/global.css`

**Interfaces:**

- Produces `validateDeviceText(value, emptyMessage): string | null`.
- Produces `shortcutForScreenKey(event): "home" | "back" | "recent" | "wake" | "lock" | null`.
- `DeviceControlPanel` accepts the existing serial, disabled flag, action callback, screenshot callback, and status callback; it does not call Rust directly for actions that can be passed through `onAction`.

- [ ] **Step 1: Write failing input and shortcut tests**

```ts
it("rejects whitespace-only device text", () => {
  expect(validateDeviceText("  ", "请输入内容")).toBe("请输入内容");
});

it("does not map shortcuts while an input field is focused", () => {
  const event = { key: "Home", target: { tagName: "INPUT" } } as unknown as KeyboardEvent;
  expect(shortcutForScreenKey(event)).toBeNull();
});
```

- [ ] **Step 2: Run the focused tests and verify the missing-helper failure**

Run: `npm test -- src/lib/deviceInput.test.ts`

Expected: FAIL because the validation and shortcut helpers do not exist.

- [ ] **Step 3: Implement validation and conservative shortcuts**

Return a fallback error for blank text/clipboard. Only map `Home`, `Escape`, `End`, `WakeUp`, and `ScrollLock` when the event target is not an input, textarea, select, or button and the screen container has focus. Do not prevent default for unmapped keys.

- [ ] **Step 4: Move and regroup the current controls**

Keep HOME, BACK, RECENT, power, volume, lock, wake, notifications, settings, screenshot, full-screen, and rotate actions. Provide explicit landscape/portrait toggling rather than always sending `true`; keep the existing service parameter `landscape: boolean`.

- [ ] **Step 5: Run input tests and build**

Run: `npm test -- src/lib/deviceInput.test.ts; npm run build`

Expected: focused tests pass and build exits with code 0.

- [ ] **Step 6: Commit the control-panel enhancement**

Commit: `git add src/lib/deviceInput.ts src/lib/deviceInput.test.ts src/components/device/DeviceControlPanel.tsx src/pages/DeviceDetail.tsx src/i18n/pages/deviceDetail.ts src/styles/global.css; git commit -m "feat: refine device control panel"`

## Task 6: Extract Shell and improve scrcpy lifecycle feedback

**Files:**

- Create: `src/components/device/DeviceShell.tsx`
- Modify: `src/lib/deviceActions.ts`
- Modify: `src/lib/deviceActions.test.ts`
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/i18n/pages/deviceDetail.ts`
- Modify: `src/styles/global.css`
- Review only: `src/services/deviceService.ts`, `src-tauri/src/services/scrcpy.rs`

**Interfaces:**

- `DeviceShell` owns only Shell input/output, favorites, history, copy, and clear-output behavior.
- `DeviceDetail` continues to own `serial`, device availability, status-bar text, and service selection.
- Scrcpy continues to use `scrcpyStart`, `scrcpyStop`, `scrcpyRestart`, and `scrcpyStatus` with their current arguments.
- Produces `scrcpyStateFromResult(result, phase): "running" | "stopped" | "error"`.

- [ ] **Step 1: Add the failing scrcpy state test**

```ts
it("marks a failed scrcpy start as a retryable error", () => {
  expect(
    scrcpyStateFromResult(
      { success: false, stdout: "", stderr: "encoder unavailable", exitCode: 1 },
      "start",
    ),
  ).toBe("error");
});
```

- [ ] **Step 2: Run the focused test and verify the missing-helper failure**

Run: `npm test -- src/lib/deviceActions.test.ts -t "retryable error"`

Expected: FAIL because `scrcpyStateFromResult` is not implemented yet.

- [ ] **Step 3: Implement `scrcpyStateFromResult` and move Shell rendering**

Implement `scrcpyStateFromResult` with `error` for failed results, `running` for successful `start`/`restart`, and `stopped` for successful `stop`. The Shell Run button must show loading, preserve stdout/stderr/exit code, show a localized failure status, and always become usable again. Failed commands must not be added to history; successful commands keep the current de-duplicated 30-entry history.

- [ ] **Step 4: Harden scrcpy start/stop/reconnect UI**

Give each action its own busy key. On start, keep the existing TCP connect check and current saved scrcpy arguments. On success, refresh status immediately; on failure, keep the backend diagnostic in Shell output and show a retryable stopped/error state. Check stop and restart `ShellResult.success` instead of marking success merely because the Promise resolved. Do not automatically stop scrcpy when the device is offline.

- [ ] **Step 5: Run the focused tests and full build**

Run: `npm test -- src/lib/deviceActions.test.ts; npm run build`

Expected: tests pass and build exits with code 0.

- [ ] **Step 6: Commit the Shell and scrcpy lifecycle changes**

Commit: `git add src/components/device/DeviceShell.tsx src/pages/DeviceDetail.tsx src/i18n/pages/deviceDetail.ts src/styles/global.css src/lib/deviceActions.ts src/lib/deviceActions.test.ts; git commit -m "feat: improve shell and scrcpy recovery"`

## Task 7: Final integration, bilingual copy, and verification

**Files:**

- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/i18n/pages/deviceDetail.ts`
- Modify: `src/styles/global.css`
- Review: `src/services/deviceService.ts`, `src-tauri/src/services/scrcpy.rs`, `docs/FEATURE-SPEC.md`, `README.md`

- [ ] **Step 1: Scan both locale dictionaries for missing new keys**

Run: `python scripts/i18n-audit.py`

Expected: no new device-detail keys missing from either language dictionary. If the script output format differs, inspect `src/i18n/pages/deviceDetail.ts` directly and compare key sets before proceeding.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: Vitest exits with code 0 and reports zero failed tests.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: TypeScript and Vite both complete successfully with exit code 0.

- [ ] **Step 4: Inspect the final diff for compatibility**

Run: `git diff main...HEAD -- src/pages/DeviceDetail.tsx src/components/device src/lib src/i18n/pages/deviceDetail.ts src/styles/global.css; git diff --check`

Verify manually from the diff that no Rust command name, `DeviceService` signature, localStorage/sessionStorage key, or existing device entry point changed.

- [ ] **Step 5: Perform a focused UI smoke check in the Tauri app**

Open an online device and verify: screenshot empty → refresh → ready; action success; action failure → visible reason → controls usable; auto-refresh pause/resume; scrcpy start/stop/reconnect; Shell success/failure; offline controls remain disabled. Repeat the visible labels once in English mode.

- [ ] **Step 6: Update the feature checklist and commit final integration**

Update only the relevant rows in `docs/FEATURE-SPEC.md` and the scrcpy description in `README.md` if the wording is now inaccurate. Then run `git diff --check` again and commit:

`git add src docs/FEATURE-SPEC.md README.md; git commit -m "feat: polish device control and mirroring"`
