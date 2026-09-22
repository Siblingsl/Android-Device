# Frontend Route Code-Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the heavy Docker and QEMU runtime panels into on-demand chunks so the merged page starts with less JavaScript while preserving its route and task semantics.

**Architecture:** Keep `RuntimePage` as the shell and replace only its static panel imports with `React.lazy` dynamic imports. Each lazy panel is wrapped in `Suspense` with a null fallback, so the resolved panel remains the direct DOM child and the existing CSS/a11y contract is unchanged. No backend or service behavior changes.

**Tech Stack:** React 19, React Router, Vite/Rollup, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-20-frontend-route-code-splitting.md`

## Global Constraints

- Preserve `?track=` and `?view=compare` behavior.
- Preserve mounted-panel ownership while a long task is running.
- Do not add a DOM wrapper around a panel root.
- Add no dependency and change no Tauri/QEMU/Docker behavior.
- Verify with TypeScript, Vitest, production build, and `git diff --check`.

## Review Focus

- A dynamic import must not remove the panel's `tabpanel` id or label after resolution; pin this in the existing RuntimePage panel assertions.
- Switching tracks while one panel reports a task must keep the hidden panel mounted; pin this in the existing background-task test.
- The fallback must not create an extra layout child; pin this with the existing direct-child assertion.
- A failed module load must not silently look like a healthy panel; retain the default React error boundary behavior and do not add a fake success state.
- The build must emit independent Docker/QEMU chunks; inspect the Vite output and record the result in the handoff evidence.

---

### Task 1: Lazy-load the merged runtime panels

**Files:**
- Modify: `src/pages/containers/RuntimePage.tsx`
- Test: `src/pages/containers/RuntimePage.test.tsx`

**Interfaces:**
- Consumes: the existing default exports from `src/pages/tracks/DockerTrackPanel.tsx` and `src/pages/tracks/QemuTrackPanel.tsx`.
- Produces: two lazy components that accept the exact existing panel props and render the same panel roots.

- [x] **Step 1: Add a focused expectation for the resolved panel contract**

Keep the existing panel and direct-child assertions as the regression test and
add this resolved-panel assertion beside `expectOnlyDockerPanel`/
`expectOnlyQemuPanel`:

```tsx
await flush();
expect(panelEl("qemu")?.getAttribute("role")).toBe("tabpanel");
expect(panelEl("qemu")?.getAttribute("aria-labelledby")).toBe("runtime-tab-qemu");
```

- [x] **Step 2: Run the focused test before implementation**

Run: `npx vitest run src/pages/containers/RuntimePage.test.tsx --maxWorkers=1 --minWorkers=1`

Expected: PASS on the current static-import implementation; this records the
baseline contract before the import boundary changes.

- [x] **Step 3: Implement the minimum dynamic import boundary**

Change the React import and panel imports as follows:

```tsx
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

const DockerTrackPanel = lazy(() => import("../tracks/DockerTrackPanel"));
const QemuTrackPanel = lazy(() => import("../tracks/QemuTrackPanel"));
```

Wrap only each existing panel element, keeping the props and ordering intact:

```tsx
{track === "qemu" || tasks.qemu ? (
  <Suspense fallback={null}>
    <QemuTrackPanel
      active={track === "qemu"}
      onTaskChange={onQemuTask}
      showHeader={false}
      panelId={panelDomId("qemu")}
      panelLabelId={tabDomId("qemu")}
      refreshSignal={refreshSignals.qemu}
    />
  </Suspense>
) : null}
```

Do the same for Docker. Do not wrap the shell, compare view, or both panels in
a new DOM element.

- [x] **Step 4: Run the focused tests after implementation**

Run: `npx vitest run src/pages/containers/RuntimePage.test.tsx --maxWorkers=1 --minWorkers=1`

Expected: all RuntimePage tests pass, including legacy redirects, tabpanel
semantics, track switching, and background-task mounting.

### Task 2: Verify the production payload and repository gates

**Files:**
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md` only if the measured build output changes the chunk warning entry.
- Create: `work/runtime-core-protection-20260917/evidence/E-070-frontend-code-splitting-20260920.md`

**Interfaces:**
- Consumes: the dynamic imports from Task 1 and the existing Vite build output.
- Produces: measured chunk sizes and a reproducible verification record.

- [x] **Step 1: Run the production build and inspect emitted chunks**

Run: `npm run build`

Record the emitted `DockerTrackPanel-*.js`, `QemuTrackPanel-*.js`, and index
chunk sizes. Do not claim a reduction without comparing the output to the
recorded 1,028.64 kB baseline.

- [x] **Step 2: Run the full frontend gates**

Run: `npx tsc --noEmit`, `npx vitest run --maxWorkers=1 --minWorkers=1`, and `git diff --check`.

Expected: all commands exit 0; preserve the existing backend verification
counts because this plan does not change Rust code.

- [x] **Step 3: Record the evidence**

Write the measured build output and test counts into E-070. If the warning is
still present, retain the warning honestly and leave the handoff item open.
