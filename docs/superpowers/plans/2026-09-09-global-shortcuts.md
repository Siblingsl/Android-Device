# 系统级全局快捷键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有应用内快捷键的前提下，为桌面客户端增加可启用、可禁用、可显示注册状态的系统级全局快捷键。

**Architecture:** Rust 侧只负责初始化 Tauri global-shortcut 插件和声明权限；前端新增独立注册管理模块，负责格式转换、逐项注册、注销、状态持久化和触发动作映射。AppLayout 继续作为唯一动作执行入口，设置页通过自定义事件通知注册管理器重新加载配置，Web 预览环境在原生插件不可用时自动降级到现有应用内快捷键。

**Tech Stack:** Tauri 2、`tauri-plugin-global-shortcut` 2.x、`@tauri-apps/plugin-global-shortcut` 2.x、React、TypeScript、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-09-global-shortcuts-design.md`

## Global Constraints

- 不修改后端 `AppSettings` 结构和现有 `settings.json` 格式。
- 只注册五个安全动作：仪表盘、设备中心、终端、刷新工作区、设置。
- 系统级注册失败不得阻止客户端启动；现有应用内快捷键始终保留。
- 不触碰 scrcpy、ADB、Docker、文件传输和设备详情控制流程。
- `Reference_Projects/` 是用户资料目录，不得修改或提交。
- 每个实现任务都必须先写失败测试，再写最小实现。

## File Map

- Modify: `src-tauri/Cargo.toml` — 添加桌面目标的 Rust global-shortcut 依赖。
- Modify: `src-tauri/Cargo.lock` — 锁定 Rust 依赖版本。
- Modify: `src-tauri/src/lib.rs` — 初始化 global-shortcut 插件。
- Modify: `src-tauri/capabilities/default.json` — 添加注册/注销/查询权限。
- Modify: `package.json` — 添加前端 global-shortcut guest binding。
- Modify: `package-lock.json` — 锁定前端依赖版本。
- Create: `src/lib/globalShortcuts.ts` — 原生快捷键格式转换、逐项注册、注销和状态存储。
- Create: `src/lib/globalShortcuts.test.ts` — 转换、降级、逐项失败和事件通知测试。
- Modify: `src/lib/shortcuts.ts` — 增加启用开关和注册状态的共享存储工具。
- Modify: `src/lib/shortcuts.test.ts` — 覆盖启用开关和状态存储。
- Modify: `src/components/layout/AppLayout.tsx` — 启动注册生命周期和统一触发分发。
- Modify: `src/pages/Settings.tsx` — 增加系统级快捷键开关和注册状态。
- Modify: `src/pages/Settings.test.tsx` — 覆盖开关、状态和重新注册通知。
- Modify: `src/i18n/pages/settings.ts` — 增加中英文状态文案。
- Modify: `src/styles/global.css` — 增加紧凑状态标签样式。

### Task 1: Add the Tauri plugin and permission boundary

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `src-tauri` compile check and frontend dependency resolution

**Interfaces:**
- Produces a desktop runtime with `tauri_plugin_global_shortcut` initialized once.
- Exposes frontend functions from `@tauri-apps/plugin-global-shortcut` for later tasks.

- [ ] **Step 1: Add the dependency and permission changes**

Use the project package manager to add `@tauri-apps/plugin-global-shortcut` at the current Tauri 2 major version and add `tauri-plugin-global-shortcut = "2"` under a desktop-only target in `src-tauri/Cargo.toml`. Register the plugin in `tauri::Builder` after the existing dialog plugin, guarded by `#[cfg(desktop)]` so non-desktop targets keep compiling. Add these permissions to `src-tauri/capabilities/default.json`:

```json
"global-shortcut:allow-is-registered",
"global-shortcut:allow-register",
"global-shortcut:allow-unregister",
"global-shortcut:allow-unregister-all"
```

- [ ] **Step 2: Run the dependency and compile checks**

Run: `npm install`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: dependency resolution succeeds and the Tauri library compiles without changing any existing command registration.

- [ ] **Step 3: Commit the plugin boundary**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json package-lock.json
git commit -m "build: add tauri global shortcut plugin"
```

### Task 2: Build the isolated global shortcut manager

**Files:**
- Create: `src/lib/globalShortcuts.ts`
- Create: `src/lib/globalShortcuts.test.ts`
- Modify: `src/lib/shortcuts.ts`
- Modify: `src/lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: `ShortcutBindings`, `ShortcutAction`, `readShortcuts`, and the Tauri plugin `register` / `unregisterAll` APIs.
- Produces: `GlobalShortcutStatus`, `readGlobalShortcutsEnabled(): boolean`, `persistGlobalShortcutsEnabled(enabled: boolean): void`, `readGlobalShortcutStatus(): GlobalShortcutStatus | null`, `persistGlobalShortcutStatus(status: GlobalShortcutStatus): void`, `notifyGlobalShortcutsChanged(): void`, `registerGlobalShortcuts(bindings, enabled, onAction): Promise<GlobalShortcutStatus>`, and `unregisterGlobalShortcuts(): Promise<void>`.

Use this status shape so the UI can distinguish a disabled app from a native registration failure:

```typescript
type GlobalShortcutFailure = "occupied" | "invalid" | "unavailable";

interface GlobalShortcutStatus {
  available: boolean;
  enabled: boolean;
  registered: ShortcutAction[];
  failed: Partial<Record<ShortcutAction, GlobalShortcutFailure>>;
}
```

- [ ] **Step 1: Write failing format and lifecycle tests**

Cover these behaviors in `src/lib/globalShortcuts.test.ts`:

```typescript
it("converts the app shortcut format to Tauri CommandOrControl format", () => {
  expect(toTauriShortcut("Ctrl+Shift+P")).toBe("CommandOrControl+Shift+P");
  expect(toTauriShortcut("Alt+D")).toBe("Alt+D");
});

it("keeps other shortcuts registering when one native registration fails", async () => {
  // Mock register so the second shortcut rejects and the first/third resolve.
  const result = await registerGlobalShortcuts(bindings, true, onAction);
  expect(result.registered).toEqual(["openDashboard", "openTerminal"]);
  expect(result.failed.openDevices).toBe("occupied");
});

it("does not call native registration when system shortcuts are disabled", async () => {
  await registerGlobalShortcuts(bindings, false, onAction);
  expect(register).not.toHaveBeenCalled();
});
```

Also add `rdc.shortcuts.enabled` read/write tests to `src/lib/shortcuts.test.ts`, with a missing value defaulting to `true` and invalid stored values falling back to `true`.

- [ ] **Step 2: Run the tests and verify the expected red state**

Run: `npm test -- src/lib/globalShortcuts.test.ts src/lib/shortcuts.test.ts --run`

Expected: the new suite fails because the manager functions do not exist yet; existing shortcut tests remain green.

- [ ] **Step 3: Implement the minimal manager**

Implement `globalShortcuts.ts` with these exact rules:

- `toTauriShortcut` replaces the leading `Ctrl` or `Meta` token with `CommandOrControl` and leaves `Alt`, `Shift`, and key tokens unchanged.
- `registerGlobalShortcuts` first calls `unregisterAll`, returns disabled statuses without registering when `enabled` is false, and registers each valid action one at a time.
- Each registration callback ignores release events and calls `onAction(action)` only for pressed events.
- A failed individual registration records `"occupied"`; no failure throws out of the whole batch.
- If the plugin call is unavailable in Web preview, return `available: false` and mark every action `"unavailable"` without throwing.
- Persist the last status under `rdc.shortcuts.status` and dispatch a `rdc:global-shortcuts-changed` browser event after configuration changes.

Add the boolean storage helpers to `shortcuts.ts` without changing existing `rdc.shortcuts` data.

- [ ] **Step 4: Run the focused tests and refactor only after green**

Run: `npm test -- src/lib/globalShortcuts.test.ts src/lib/shortcuts.test.ts --run`

Expected: all focused tests pass, including the partial-failure and Web preview fallback cases.

- [ ] **Step 5: Commit the isolated manager**

```bash
git add src/lib/globalShortcuts.ts src/lib/globalShortcuts.test.ts src/lib/shortcuts.ts src/lib/shortcuts.test.ts
git commit -m "feat: manage native global shortcuts"
```

### Task 3: Connect registration lifecycle to AppLayout

**Files:**
- Modify: `src/components/layout/AppLayout.tsx`
- Test: `src/components/layout/AppLayout.test.tsx` (create if no existing layout integration test exists)

**Interfaces:**
- Consumes: `registerGlobalShortcuts`, `unregisterGlobalShortcuts`, `readShortcuts`, `readGlobalShortcutsEnabled`, and the existing `navigate`, `refreshStatus`, and `refreshDevices` functions.
- Produces: one mounted registration lifecycle that executes the same five `ShortcutAction` cases used by the existing app-window listener.

- [ ] **Step 1: Write failing lifecycle and action-dispatch tests**

Mock the native manager and render `AppLayout` with a memory router and the existing outlet stub. Verify:

```typescript
it("registers configured shortcuts on mount and unregisters on unmount", async () => {
  const view = render(<AppLayout />);
  await waitFor(() => expect(registerGlobalShortcuts).toHaveBeenCalled());
  view.unmount();
  expect(unregisterGlobalShortcuts).toHaveBeenCalled();
});

it("re-registers after the settings page broadcasts a shortcut change", async () => {
  render(<AppLayout />);
  window.dispatchEvent(new Event("rdc:global-shortcuts-changed"));
  await waitFor(() => expect(registerGlobalShortcuts).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: Run the tests and verify the expected red state**

Run: `npm test -- src/components/layout/AppLayout.test.tsx --run`

Expected: the new lifecycle assertions fail because AppLayout does not call the native manager yet.

- [ ] **Step 3: Implement lifecycle and shared action dispatch**

Add a `useEffect` in `AppLayout` that registers on mount, listens for `rdc:global-shortcuts-changed`, re-registers on that event, and unregisters during cleanup. Keep the existing `keydown` listener and route both native and in-window triggers through one local `runShortcutAction(action)` function. Before navigation, best-effort call the Tauri window `show` and `setFocus` APIs; catch those calls so Web preview and unsupported window states cannot block navigation.

- [ ] **Step 4: Run focused layout tests**

Run: `npm test -- src/components/layout/AppLayout.test.tsx src/lib/globalShortcuts.test.ts --run`

Expected: registration, cleanup, event re-registration, navigation mapping, and refresh mapping all pass.

- [ ] **Step 5: Commit the AppLayout integration**

```bash
git add src/components/layout/AppLayout.tsx src/components/layout/AppLayout.test.tsx
git commit -m "feat: activate global shortcut lifecycle"
```

### Task 4: Add the enable switch and registration status UI

**Files:**
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/Settings.test.tsx`
- Modify: `src/i18n/pages/settings.ts`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: `readGlobalShortcutsEnabled`, `persistGlobalShortcutsEnabled`, `readGlobalShortcutStatus`, and `notifyGlobalShortcutsChanged`.
- Produces: a compact settings card that controls native registration and displays registered, disabled, occupied, invalid, and unavailable states.

- [ ] **Step 1: Write failing settings UI tests**

Extend `Settings.test.tsx` with these behaviors:

```typescript
it("shows system shortcut registration as enabled by default", () => {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  expect(screen.getByRole("checkbox", { name: "启用系统级快捷键" })).toBeChecked();
  expect(screen.getByText(/系统快捷键已启用/)).toBeTruthy();
});

it("persists disabling system shortcuts and requests re-registration", () => {
  const dispatchSpy = vi.spyOn(window, "dispatchEvent");
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "启用系统级快捷键" }));
  expect(localStorage.getItem("rdc.shortcuts.enabled")).toBe("0");
  expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "rdc:global-shortcuts-changed" }));
  dispatchSpy.mockRestore();
});
```

Add a status fixture test that renders one registered action and one occupied action with the correct Chinese labels. Keep the existing custom shortcut capture and reset tests unchanged.

- [ ] **Step 2: Run the tests and verify the expected red state**

Run: `npm test -- src/pages/Settings.test.tsx --run`

Expected: the new switch and status assertions fail because the settings card has no native registration controls yet; existing settings tests remain green.

- [ ] **Step 3: Implement the compact status UI**

Add the checkbox to the existing shortcuts card rather than creating a new page. On change, persist the value, dispatch the change event, clear stale error text, and update the status bar. Read status updates from `rdc.shortcuts.status` on mount and on the same browser event. Show a summary count and one small status chip per shortcut row. Keep the current capture, conflict, reset, and local persistence behavior unchanged.

- [ ] **Step 4: Add bilingual copy and styles**

Add translations for the switch, enabled/disabled summary, registered, occupied, invalid, unavailable, and not-registered labels. Extend the existing shortcut card styles with compact status chips, preserving visible keyboard focus and the current responsive one-column behavior.

- [ ] **Step 5: Run focused settings tests**

Run: `npm test -- src/pages/Settings.test.tsx src/lib/shortcuts.test.ts --run`

Expected: all shortcut capture, conflict, reset, enable switch, and status tests pass in Chinese defaults.

- [ ] **Step 6: Commit the settings UI**

```bash
git add src/pages/Settings.tsx src/pages/Settings.test.tsx src/i18n/pages/settings.ts src/styles/global.css
git commit -m "feat: expose global shortcut status"
```

### Task 5: Full verification, desktop launch, and push

**Files:**
- No new source files; verify all files from Tasks 1–4.

- [ ] **Step 1: Run the full frontend test suite**

Run: `npm test -- --run`

Expected: every test file and test case passes, including all existing device, scrcpy, file transfer, wireless debugging, and monitor tests.

- [ ] **Step 2: Run frontend and Tauri builds**

Run: `npm run build`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: TypeScript/Vite build and Tauri Rust check succeed. The existing large-chunk warning is acceptable if no new build error appears.

- [ ] **Step 3: Check the diff and preserve user files**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; `Reference_Projects/` remains untracked and absent from every commit.

- [ ] **Step 4: Launch the client and smoke-check the settings screen**

Use the existing Tauri development launch procedure. Confirm the `Redroid Device Center` window opens, Settings shows the system shortcut switch, and disabling the switch does not prevent navigating through the existing UI.

- [ ] **Step 5: Push the implementation commits**

```bash
git push origin codex/device-status-board-ui
```

Expected: the branch on GitHub contains the implementation commits and the working tree contains only the pre-existing untracked `Reference_Projects/` directory.
