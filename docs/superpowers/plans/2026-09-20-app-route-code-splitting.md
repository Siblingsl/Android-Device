# App Route Code-Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load page-level React modules on demand so the desktop app's initial JavaScript payload is smaller without changing route behavior.

**Architecture:** Keep `AppLayout`, `HashRouter`, `Routes`, and the i18n provider in the synchronous shell. Replace page imports in `src/App.tsx` with named-export adapters passed to `lazy`, and wrap route elements in `Suspense fallback={null}`. The existing runtime shell remains responsible for its own panel-level lazy boundaries and lifecycle ownership.

**Tech Stack:** React 19, React Router, Vite/Rollup, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-app-route-code-splitting.md`

## Global Constraints

- Use React `lazy` and `Suspense` with existing dependencies only.
- Do not add a DOM wrapper inside `AppLayout` or around the runtime panels.
- Do not change Tauri commands, service calls, QEMU/Docker behavior, or authorization behavior.
- Use a null fallback so route loading does not introduce a permanent layout element or alter page-specific markup.

## Review Focus

- A named-export adapter must preserve each page's existing export and route props; pin the route source contract and TypeScript build.
- The dedicated `?window=device` path must resolve `DeviceWindowPage` without mounting the main shell; pin it in the route source contract and existing preview path.
- A route transition must not leave a stale page mounted behind a null fallback; pin the existing App-backed runtime redirect tests.
- Runtime panels must remain direct children of their existing layout scope; keep the existing RuntimePage panel and lifecycle assertions.
- The build must prove the page modules are emitted outside the main index chunk; record the actual output rather than inferring from source imports.

---

### Task 1: Replace synchronous page imports with lazy route modules

**Files:**
- Modify: `src/App.tsx`
- Modify: `tests/signalDeskLayout.test.ts`
- Modify: `src/pages/containers/RuntimePage.test.tsx` only if the lazy route changes require an explicit flush assertion

**Interfaces:**
- Consumes: existing page exports (`Dashboard`, `Devices`, `DeviceDetail`, `RuntimePage`, `AdbPage`, `ApkPage`, `VolumesPage`, `LogsPage`, `MonitorAlertsPage`, `SettingsPage`, `DeviceWindowPage`, `TerminalPage`).
- Produces: lazy components with the same rendered route behavior and no new public page exports.

- [x] **Step 1: Write the failing source-contract assertions**

Update the existing route reachability tests so they require dynamic imports
and a Suspense boundary while preserving route paths:

```ts
expect(app).toContain('lazy(() => import("./pages/Terminal"));');
expect(app).toContain('<Suspense fallback={null}>');
expect(app).toContain('<Route path="terminal" element={<TerminalPage />} />');
expect(app).not.toContain('import { TerminalPage } from "./pages/Terminal";');
```

Add the same source assertion for `DeviceWindowPage`, because its branch is
outside the route tree and must remain a separately loaded page.

- [x] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
npx vitest run tests/signalDeskLayout.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: the route reachability tests fail because `App.tsx` still contains
static page imports and no lazy route boundary.

- [x] **Step 3: Add lazy adapters and Suspense boundaries**

In `src/App.tsx`, import `lazy` and `Suspense`, then define one adapter per
named page export. Keep the runtime page's default export as a direct lazy
import:

```tsx
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Devices = lazy(() => import("./pages/Devices").then((m) => ({ default: m.Devices })));
const DeviceDetail = lazy(() => import("./pages/DeviceDetail").then((m) => ({ default: m.DeviceDetail })));
const RuntimePage = lazy(() => import("./pages/containers/RuntimePage"));
const AdbPage = lazy(() => import("./pages/Adb").then((m) => ({ default: m.AdbPage })));
const ApkPage = lazy(() => import("./pages/Apk").then((m) => ({ default: m.ApkPage })));
const VolumesPage = lazy(() => import("./pages/Volumes").then((m) => ({ default: m.VolumesPage })));
const LogsPage = lazy(() => import("./pages/Logs").then((m) => ({ default: m.LogsPage })));
const MonitorAlertsPage = lazy(() => import("./pages/MonitorAlerts").then((m) => ({ default: m.MonitorAlertsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const DeviceWindowPage = lazy(() => import("./pages/DeviceWindow").then((m) => ({ default: m.DeviceWindowPage })));
const TerminalPage = lazy(() => import("./pages/Terminal").then((m) => ({ default: m.TerminalPage })));
```

Render the device-window branch and the route tree inside one `Suspense
fallback={null}` without introducing any page wrapper:

```tsx
if (windowMode === "device") {
  return <Suspense fallback={null}><I18nProvider><DeviceWindowPage /></I18nProvider></Suspense>;
}

return <Suspense fallback={null}><I18nProvider><HashRouter>{/* existing Routes */}</HashRouter></I18nProvider></Suspense>;
```

- [x] **Step 4: Run the focused route tests and existing runtime tests**

Run:

```powershell
npx vitest run tests/signalDeskLayout.test.ts src/pages/containers/RuntimePage.test.tsx --maxWorkers=1 --minWorkers=1
```

Expected: all focused tests pass, including legacy redirects, runtime panel
tabpanel semantics, background-task mounting, and the standalone route.

### Task 2: Measure the production payload and record evidence

**Files:**
- Create: `work/runtime-core-protection-20260917/evidence/E-076-app-route-code-splitting-20260920.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md` only to update the chunk-warning row and evidence index with measured output

**Interfaces:**
- Consumes: dynamic route imports from Task 1 and Vite production output.
- Produces: reproducible chunk-size evidence and an accurate handoff status.

- [x] **Step 1: Build and inspect emitted chunks**

Run:

```powershell
npm run build
```

Record the exact `index-*.js` size and the emitted page chunks. Compare the
index against the 944.01 kB baseline; do not call the warning resolved unless
the output itself supports that conclusion.

- [x] **Step 2: Run the required repository gates**

Run:

```powershell
npx tsc --noEmit
npx vitest run
git diff --check
```

Expected: all exit 0. Backend test counts remain unchanged because this plan
does not touch Rust or authorization code.

- [x] **Step 3: Write the evidence and update the handoff**

Record the build output, focused/full test counts, and the honest manual
boundary in E-076. If the index still exceeds the warning threshold, leave the
chunk-warning item open and state the measured reduction.
