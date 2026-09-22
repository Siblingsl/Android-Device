# Custom Window Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the main window's native title bar and add functional window controls to the existing top navigation.

**Architecture:** Keep the existing `Sidebar` as the visual top bar. Add a focused `WindowControls` component that owns Tauri window API calls and maximized-state synchronization; expose a non-interactive drag spacer in `Sidebar` so navigation controls cannot accidentally become drag targets.

**Tech Stack:** React 19, TypeScript, Tauri 2 `@tauri-apps/api/window`, Vitest, Testing Library, CSS in `src/styles/global.css`.

**Spec:** `docs/superpowers/specs/2026-09-22-custom-window-chrome.md`

## Global Constraints

- Modify only the main window; independent terminal windows keep native decorations.
- Preserve the existing `closeToTray` close-request handler.
- Do not modify Rust or QEMU code.
- Follow the project's required `npx tsc --noEmit`, `npx vitest run`, and two Cargo test commands before completion.
- Real-window behavior remains pending manual confirmation.

## Review Focus

- Browser/jsdom preview has no Tauri internals: controls must not throw or render unusable actions.
- Maximize state changes outside the button: the restore icon and accessible label must resync.
- Close-to-tray is enabled: the custom close button must still flow through the existing close-request handler.
- Narrow window: controls must remain visible while nav content is allowed to compress or scroll.
- Interactive descendants: clicking nav/settings/window buttons must not initiate dragging.

### Task 1: Add failing window-controls tests

**Files:**
- Create: `src/components/layout/WindowControls.test.tsx`

**Interfaces:**
- The tests will consume `WindowControls` from `src/components/layout/WindowControls.tsx`.
- The component will expose three buttons with labels for minimize, maximize/restore, and close.

- [x] **Step 1: Write the failing test**

  Cover the three button actions and the maximized-state label/icon transition using a mocked Tauri window object and a jsdom Tauri marker.

- [x] **Step 2: Run the focused test**

  Run: `npx vitest run src/components/layout/WindowControls.test.tsx`

  Expected: FAIL because `WindowControls.tsx` does not exist yet.

### Task 2: Implement the window-controls component

**Files:**
- Create: `src/components/layout/WindowControls.tsx`
- Modify: `src/i18n/pages/common.ts`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/styles/global.css`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- `WindowControls()` renders no controls when Tauri internals are unavailable.
- In Tauri, button handlers call `getCurrentWindow().minimize()`, `.toggleMaximize()`, and `.close()`.
- The maximize button observes `onResized` and uses `isMaximized()` to select maximize vs. restore semantics.

- [x] **Step 1: Implement the smallest component that passes Task 1**

  Keep the component limited to Tauri detection, three handlers, maximized-state synchronization, and accessible labels from existing i18n conventions.

- [x] **Step 2: Integrate the component into the top bar**

  Render the controls after the settings link and add a dedicated drag spacer before the navigation tools. Do not place the controls inside `.nav`.

- [x] **Step 3: Add focused CSS and disable main-window decorations**

  Use a compact right-aligned control group, 36px button targets, a red close hover state, and `decorations: false` only in the main `tauri.conf.json` window definition.

- [x] **Step 4: Run the focused test**

  Run: `npx vitest run src/components/layout/WindowControls.test.tsx`

  Expected: PASS.

### Task 3: Verify the complete change

**Files:**
- No additional files.

- [x] **Step 1: Run TypeScript verification**

  Run: `npx tsc --noEmit`

- [x] **Step 2: Run all frontend tests**

  Run: `npx vitest run`

- [x] **Step 3: Run the Rust verification gates**

  Run: `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path qemu-center/Cargo.toml`.

- [x] **Step 4: Review the diff and report the manual boundary**

  Confirm only the scoped files changed, then report that real Tauri window behavior still needs manual confirmation.

### Task 4: Restore native drag, resize, snap, and DPI interaction paths

**Files:**
- Modify: `src/components/layout/WindowControls.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/layout/WindowControls.test.tsx`
- Modify: `src/styles/global.css`
- Modify: `docs/superpowers/specs/2026-09-22-custom-window-chrome.md`

**Interfaces:**
- `WindowDragRegion` calls `getCurrentWindow().startDragging()` on primary-button press and `toggleMaximize()` on double-click.
- `WindowResizeHandles` renders eight directions and calls `startResizeDragging(direction)` on primary-button press.
- `WindowControls` keeps maximized-state synchronization through resize and scale-change listeners.

- [x] **Step 1: Write failing interaction tests**

  Extend the Tauri window mock with `startDragging`, `startResizeDragging`, and `onScaleChanged`; assert primary-button drag, double-click maximize, and all eight resize directions.

- [x] **Step 2: Run the focused tests and confirm RED**

  Run: `npx vitest run src/components/layout/WindowControls.test.tsx`

  Expected: FAIL because the current implementation has no drag-region handler or resize handles.

- [x] **Step 3: Implement explicit native interaction handlers**

  Add the two focused components, wire them into `Sidebar`, and keep all native API failures contained so browser preview remains safe.

- [x] **Step 4: Add DPI-safe resize hit zones**

  Add fixed edge/corner hit zones with direction cursors and `pointer-events` isolation. Use Tauri's native resize API so OS DPI and minimum-size behavior remain authoritative.

- [x] **Step 5: Run the focused tests and confirm GREEN**

  Run: `npx vitest run src/components/layout/WindowControls.test.tsx`

  Expected: PASS.

- [x] **Step 6: Run the complete verification gates**

  Run: `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path qemu-center/Cargo.toml`, and `npm run build`.

### Task 5: Allow custom window commands in Tauri ACL

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Create: `tests/windowCapabilities.test.ts`

**Interfaces:**
- The main-window capability explicitly allows close, minimize, toggle-maximize, start-dragging, and start-resize-dragging.

- [x] **Step 1: Add a failing capability regression test**

  Assert that `default.json` contains all five `core:window` permissions.

- [x] **Step 2: Run the focused test and confirm RED**

  The test failed because `core:window:default` alone did not include those permissions.

- [x] **Step 3: Add the five explicit permissions**

  Keep the existing capability scope and permissions unchanged apart from the required window commands.

- [x] **Step 4: Run the focused test and complete verification**

  Run the focused window tests and the project verification gates after restarting the Tauri dev window.

### Task 6: Align desktop icons with the current Just Run logo

**Files:**
- Modify: `src-tauri/icons/icon.ico`
- Modify: `src-tauri/icons/icon.png`
- Modify: `src-tauri/icons/32x32.png`
- Modify: `src-tauri/icons/128x128.png`
- Modify: `src-tauri/icons/128x128@2x.png`
- Modify: `src-tauri/icons/icon.icns`
- Modify: Appx-sized icon assets under `src-tauri/icons/`

**Interfaces:**
- Tauri bundle and tray icon assets are generated from `public/just-run-logo.png`.

- [x] **Step 1: Generate the desktop icon set from the current logo**

  Run `npx tauri icon public/just-run-logo.png -o src-tauri/icons` and retain only generated assets used by the desktop project.

- [x] **Step 2: Verify the generated icon and frontend build**

  Visually inspect the generated PNG and run `npm run build`.
