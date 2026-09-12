# Signal Desk UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Signal Desk visual system across the application and rebuild the device-detail Tab workspaces without changing device behavior.

**Architecture:** Keep existing routes, stores, service calls, and feature components. Add a shared detail-workspace shell around the existing Tab content, then use explicit module and scroll-region classes to make each feature readable as a vertical work area. Derive all global page styling from one token layer in `global.css`, so Dashboard, Devices, Docker, ADB, APK, Volumes, Logs, Settings, and DeviceDetail share the same spacing and hierarchy.

**Tech Stack:** React 19, TypeScript, React Router, lucide-react, Vite, Vitest, Tauri 2, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-09-12-signal-desk-ui-design.md`

## Global Constraints

- Preserve existing device service calls, callbacks, route paths, storage keys, and state transitions.
- Use the spec palette and semantic status mapping; do not introduce page-specific colors.
- Use `4 / 8 / 12 / 18 / 24px` spacing rhythm and 6px ordinary module radius.
- Long logs, shell output, file lists, app lists, and tables scroll inside their owning region.
- Keep overview usable offline and keep restricted Tabs visibly disabled with the existing reason.
- Add Chinese and English translations for every new user-facing label.
- Run the focused structural test after each task, then the full test suite and production build before completion.

---

### Task 1: Lock the new UI structure with regression tests

**Files:**
- Create: `tests/signalDeskLayout.test.ts`
- Test: `src/pages/DeviceDetail.tsx`, `src/styles/global.css`, `src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: current detail Tab names and existing global class names.
- Produces: structural assertions for `detail-shell`, `detail-context`, `detail-tabbar`, `detail-workspace`, `detail-module`, and explicit scroll-region classes.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const detail = readFileSync(resolve(root, "src/pages/DeviceDetail.tsx"), "utf8");
const styles = readFileSync(resolve(root, "src/styles/global.css"), "utf8");

describe("Signal Desk layout", () => {
  it("defines the device detail workspace shell", () => {
    expect(detail).toContain('className="detail-shell"');
    expect(detail).toContain('className="detail-context"');
    expect(detail).toContain('className="detail-tabbar"');
    expect(detail).toContain('className="detail-workspace"');
    expect(detail).toContain('className="detail-module"');
  });

  it("defines bounded detail scroll regions", () => {
    expect(styles).toMatch(/\.detail-scroll-region\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.detail-workspace\s*\{[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.page-device-detail[^}]*overflow-y:\s*auto/s);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: FAIL because the new detail-shell class names do not exist yet.

- [ ] **Step 3: Keep the test as the implementation contract**

Do not weaken assertions to match the current markup. The production changes in Tasks 2–5 must satisfy these exact structural checks.

- [ ] **Step 4: Commit the test**

```bash
git add tests/signalDeskLayout.test.ts
git commit -m "test: define signal desk layout contract"
```

### Task 2: Build the global Signal Desk foundation

**Files:**
- Modify: `src/styles/global.css`
- Test: `tests/signalDeskLayout.test.ts`

**Interfaces:**
- Consumes: existing CSS variables, `.app-shell`, `.content`, `.module`, `.tabs`, `.tab`, `.table-wrap`, `.shell-output`.
- Produces: consistent tokens, module title bands, buttons, forms, tab rails, and scroll primitives used by every page.

- [ ] **Step 1: Add the minimal token and primitive assertions**

Extend the focused test with:

```ts
it("uses the Signal Desk spacing and module primitives", () => {
  expect(styles).toContain("--surface-soft: #EEF2F4");
  expect(styles).toContain("--line-strong: #AABBC3");
  expect(styles).toMatch(/\.module\s*\{[^}]*border-top:\s*2px/s);
  expect(styles).toMatch(/\.module-head\s*\{[^}]*min-height:\s*35px/s);
  expect(styles).toMatch(/\.tabs\s*\{[^}]*border-bottom:\s*1px/s);
});
```

- [ ] **Step 2: Run the test and verify it fails for the missing token values**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: FAIL on the new token/primitive assertions before the CSS replacement.

- [ ] **Step 3: Implement the foundation**

Update the existing token block and shared selectors in `global.css` to the spec values. Keep one source of truth for colors. Normalize `.module`, `.module-head`, `.module-body`, `.tabs`, `.tab`, fields, buttons, `.table-wrap`, `.shell-output`, focus rings, and reduced-motion behavior. Add:

```css
.detail-scroll-region,
.table-wrap,
.shell-output { min-height: 0; overflow: auto; }

.detail-module { position: relative; display: flex; min-width: 0; min-height: 0; flex-direction: column; border-top: 2px solid var(--module-accent, var(--accent)); border-bottom: 1px solid var(--line); background: var(--surface); }
.detail-module-head { display: flex; min-height: 35px; align-items: center; justify-content: space-between; gap: 8px; padding: 0 11px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
```

Do not remove existing feature selectors until their replacements are applied and the full suite passes.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: the foundation assertions pass; shell assertions remain red until Task 3.

- [ ] **Step 5: Commit the foundation**

```bash
git add src/styles/global.css tests/signalDeskLayout.test.ts
git commit -m "feat: add signal desk visual foundation"
```

### Task 3: Rebuild the DeviceDetail shell and Tab rail

**Files:**
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/i18n/pages/devices.ts`
- Test: `tests/signalDeskLayout.test.ts`

**Interfaces:**
- Consumes: existing `device`, `tab`, `setTab`, `load`, `connectIfNeeded`, and Tab callbacks.
- Produces: `detail-shell`, `detail-context`, `detail-tabbar`, `detail-workspace` wrappers while preserving all existing feature component props and callbacks.

- [ ] **Step 1: Add exact shell assertions**

Extend the test with:

```ts
it("keeps all six detail tabs in the new tab rail", () => {
  for (const key of ["overview", "control", "files", "apps", "logs", "settings"]) {
    expect(detail).toContain(`"${key}"`);
  }
  expect(detail).toContain("detail-workspace-head");
  expect(detail).toContain("detail-tab-status");
});
```

- [ ] **Step 2: Run the test and verify the shell assertions fail**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: FAIL because the current page uses the generic `.tabs` and has no detail workspace shell.

- [ ] **Step 3: Replace only the page shell markup**

Wrap the existing detail return in:

```tsx
<div className="detail-shell">
  <div className="detail-context">...</div>
  <nav className="detail-tabbar" aria-label={t("detail.tabNavigation")}>
    ...existing six tab definitions...
  </nav>
  <main className="detail-workspace">
    <div className="detail-workspace-head">current tab title, summary, and status</div>
    <div className="detail-scroll-region">...existing conditional Tab content...</div>
  </main>
</div>
```

Keep the existing session-storage restore, offline check, routing, action handlers, and child component props unchanged. Add only translation keys for the tab navigation label and workspace summaries in Chinese and English.

- [ ] **Step 4: Add shell CSS**

Add explicit CSS for `.detail-shell`, `.detail-context`, `.detail-tabbar`, `.detail-tab`, `.detail-workspace`, `.detail-workspace-head`, `.detail-workspace-title`, `.detail-workspace-summary`, and `.detail-tab-status`. Ensure `.detail-scroll-region` owns overflow and the page cannot get horizontal overflow from any child.

- [ ] **Step 5: Run focused tests and TypeScript**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`; then `npx tsc --noEmit`.

Expected: focused layout tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the detail shell**

```bash
git add src/pages/DeviceDetail.tsx src/i18n/pages/devices.ts src/styles/global.css tests/signalDeskLayout.test.ts
git commit -m "feat: rebuild device detail workspace shell"
```

### Task 4: Recompose the Control, Files, Apps, Logs, and Settings workspaces

**Files:**
- Modify: `src/pages/DeviceDetail.tsx`
- Modify: `src/components/device/DeviceStream.tsx`
- Modify: `src/components/device/DeviceControlBar.tsx`
- Modify: `src/components/device/FileExplorer.tsx`
- Modify: `src/components/device/InteractiveTerminal.tsx`
- Modify: `src/components/device/AutomationPanel.tsx`
- Modify: `src/components/device/AgentPanel.tsx`
- Modify: `src/components/device/KeyboardMappingPanel.tsx`
- Modify: `src/components/device/RecordingPanel.tsx`
- Modify: `src/components/device/GnirehtetPanel.tsx`
- Test: `tests/signalDeskLayout.test.ts`

**Interfaces:**
- Consumes: existing component props and service callbacks exactly as currently defined.
- Produces: consistent `detail-module` and `detail-scroll-region` boundaries for every feature surface.

- [ ] **Step 1: Add workspace-specific structural assertions**

Extend the test with:

```ts
it("marks long-running feature regions as internal scroll areas", () => {
  expect(detail).toContain('className="detail-control-workspace"');
  expect(detail).toContain('className="detail-files-workspace"');
  expect(detail).toContain('className="detail-apps-workspace"');
  expect(detail).toContain('className="detail-logs-workspace"');
  expect(detail).toContain('className="detail-settings-workspace"');
  expect(styles).toMatch(/\.detail-control-workspace[^}]*min-height:\s*0/s);
  expect(styles).toMatch(/\.detail-files-workspace[^}]*min-height:\s*0/s);
  expect(styles).toMatch(/\.detail-apps-workspace[^}]*min-height:\s*0/s);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: FAIL on the feature workspace class assertions.

- [ ] **Step 3: Recompose Control without changing behavior**

Use a full-width screen stage followed by an action module. Put the existing automation, AI, keyboard mapping, recording, Gnirehtet, terminal, text input, clipboard input, and Shell controls into `detail-module` sections. Keep their state, effect hooks, service calls, and callback props unchanged. Add `detail-scroll-region` only around output/list areas.

- [ ] **Step 4: Recompose Files and Apps**

Wrap the existing file explorer and apps content in named workspace classes. Keep path persistence, bookmarks, upload/download/delete, app favorites, launch/stop/detail/uninstall/shortcut behavior unchanged. Add internal scrolling around tables and detail output, not around action toolbars.

- [ ] **Step 5: Recompose Logs and Settings**

Wrap the current log and settings content in named workspaces. Keep filters, refresh, save, reset, display, network, scrcpy, and advanced settings behavior unchanged. Make output and long field groups bounded with `min-height: 0`.

- [ ] **Step 6: Add the responsive CSS**

At `max-width: 900px`, collapse field grids and let toolbars wrap. At `max-width: 600px`, stack action groups and keep only the work region scrollable. Add `prefers-reduced-motion: reduce` rules for any new transition.

- [ ] **Step 7: Run focused tests and TypeScript**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`; then `npx tsc --noEmit`.

Expected: structural tests pass and TypeScript exits 0.

- [ ] **Step 8: Commit the workspaces**

```bash
git add src/pages/DeviceDetail.tsx src/components/device src/styles/global.css tests/signalDeskLayout.test.ts
git commit -m "feat: organize device detail feature workspaces"
```

### Task 5: Align all top-level pages to the same visual system

**Files:**
- Modify: `src/components/layout/AppLayout.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/Devices.tsx`
- Modify: `src/pages/Docker.tsx`
- Modify: `src/pages/Adb.tsx`
- Modify: `src/pages/Apk.tsx`
- Modify: `src/pages/Volumes.tsx`
- Modify: `src/pages/Logs.tsx`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/styles/global.css`
- Test: `tests/signalDeskLayout.test.ts`

**Interfaces:**
- Consumes: existing page-level content and handlers.
- Produces: consistent title bands, module headers, action hierarchy, and page scroll boundaries across the application.

- [ ] **Step 1: Add global page assertions**

Extend the test with:

```ts
it("keeps a shared app shell and status bar", () => {
  const layout = readFileSync(resolve(root, "src/components/layout/AppLayout.tsx"), "utf8");
  expect(layout).toContain("app-shell");
  expect(layout).toContain("StatusBar");
  expect(styles).toMatch(/\.page-header::before/);
  expect(styles).toMatch(/\.status-bar/);
});
```

- [ ] **Step 2: Run the test and verify the assertion result**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`

Expected: any missing shared shell selector is identified before CSS changes.

- [ ] **Step 3: Apply the shared page treatment**

Normalize page title bands, nav spacing, status bar, module headers, button variants, form fields, tables, empty states, and internal scroll regions. Do not change page logic or service calls. Keep the current Devices ledger behavior and existing action classes compatible.

- [ ] **Step 4: Check each page for horizontal overflow**

Use the shared `min-width: 0`, `overflow: hidden`, and internal scroll rules on page content, tables, logs, settings path panels, and detail workspaces. Do not hide meaningful content with clipping.

- [ ] **Step 5: Run focused tests and TypeScript**

Run: `npm test -- --run tests/signalDeskLayout.test.ts`; then `npx tsc --noEmit`.

Expected: all structural assertions pass and TypeScript exits 0.

- [ ] **Step 6: Commit the global alignment**

```bash
git add src/components/layout src/pages src/styles/global.css tests/signalDeskLayout.test.ts
git commit -m "feat: align application pages to signal desk ui"
```

### Task 6: Full verification and visual review

**Files:**
- Modify: `tests/signalDeskLayout.test.ts` only if an assertion accurately reflects the approved spec.

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: fresh evidence that the UI redesign builds, tests, and renders without logic regressions.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test -- --run`

Expected: every test file passes with zero failures.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: TypeScript and Vite complete with exit code 0. Existing chunk-size warnings are acceptable if no build error occurs.

- [ ] **Step 3: Check the diff and line endings**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; unrelated user modifications remain unstaged and untouched.

- [ ] **Step 4: Perform the visual review**

Open the app at a wide and narrow window size and inspect Dashboard, Devices, Docker, ADB, Settings, and DeviceDetail. Check the six detail Tabs, offline state, empty state, loading state, tables, log output, shell output, and responsive wrapping. Confirm there is no duplicated entry point, no accidental right-side pile-up, and no unbounded outer scroll caused by a child module.

- [ ] **Step 5: Commit only test adjustments if required**

```bash
git add tests/signalDeskLayout.test.ts
git commit -m "test: cover final signal desk layout"
```
