# QEMU Balloon Memory Reclaim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, fail-closed QEMU guest-memory reclaim action that can reduce host working set without stopping the VM or changing its maximum RAM.

**Architecture:** Add a virtio-balloon device to the pure QEMU argv builder, expose a typed QMP `balloon`/`query-balloon` exchange, and compute a conservative target from existing guest redroid cgroup stats. Wire the result through qemu-center, the Tauri service, and the QEMU node card; the action remains explicit and is never a background timer.

**Tech Stack:** Rust std-only qemu-center/QMP code, existing serde/clap/Tauri command bridge, React/TypeScript, Vitest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-20-qemu-balloon-memory-reclaim.md`

## Global Constraints

- Never hard-kill QEMU or write qcow2 while QEMU is running.
- Never issue a balloon target below 1536 MiB or above the registered node `mem_mib`.
- Missing or unknown active-instance metrics must fail closed without sending QMP `balloon`.
- The action must be explicit; do not add a background reclaim timer in this plan.
- Backend changes remain covered by `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path qemu-center/Cargo.toml`.
- Real WHPX, login, continuous browsing, and 30-minute memory conclusions remain manual until performed on the target host.

## Review Focus

- Old QEMU processes without `virtio-balloon-pci`: report unsupported and leave the VM running; test in Task 2.
- Active instance with missing/unknown `memory_current_bytes`: refuse to reclaim; test in Task 2.
- Exited rows mixed with running rows: ignore exited rows but include every confirmed running row; test in Task 2.
- QMP success followed by an unverifiable `query-balloon` result: report verification failure without stopping the VM; test in Task 1.
- Repeated clicks while a node operation is running: keep one operation and disable the button; test in Task 3.

---

### Task 1: QEMU balloon device and typed QMP protocol

**Files:**
- Modify: `qemu-center/src/vm.rs`
- Modify: `qemu-center/src/qmp.rs`
- Test: `qemu-center/src/vm.rs` and `qemu-center/src/qmp.rs` inline tests

**Interfaces:**
- Produces `vm::BALLOON_DEVICE_ID`, `vm::qmp_balloon_frame(target_bytes)`, and `vm::qmp_query_balloon_frame()`.
- Produces `qmp::reclaim_memory(port, target_mib, timeout)` returning the verified actual balloon bytes or a typed `QmpError`.

- [x] **Step 1: Write failing tests** for the launch argv containing exactly one `virtio-balloon-pci,id=balloon0`, the JSON frames, and a fake QMP server returning an `actual` value.
- [x] **Step 2: Run the focused tests** with `cargo test --manifest-path qemu-center/Cargo.toml vm:: -- --nocapture` and `cargo test --manifest-path qemu-center/Cargo.toml qmp:: -- --nocapture`; confirm the new symbols/frames fail before implementation.
- [x] **Step 3: Implement the minimum protocol**: add the device after the existing virtio devices, serialize `value` in bytes, issue `balloon`, then `query-balloon`, parse a positive integer `actual`, and map absent/malformed values to `QmpError::Transport`.
- [x] **Step 4: Re-run the focused tests** and confirm fake success, QMP rejection, malformed reply, and argv tests pass.
- [x] **Step 5: Run `cargo fmt --manifest-path qemu-center/Cargo.toml -- --check`** and `cargo test --manifest-path qemu-center/Cargo.toml`.

### Task 2: Conservative reclaim planner and CLI command

**Files:**
- Modify: `qemu-center/src/redroid.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/vm.rs` if a reusable liveness validation helper is needed
- Test: inline Rust tests in `qemu-center/src/redroid.rs`, `qemu-center/src/main.rs`

**Interfaces:**
- Produces `redroid::ReclaimPlan` and `redroid::plan_memory_reclaim(node_mem_mib, rows)`.
- Adds `VmCmd::MemoryReclaim { name: String }` and `cmd_vm_memory_reclaim`.
- CLI output includes `target_mib`, `actual_mib`, `reclaimed_mib`, and a no-op reason without leaking grant contents.

- [x] **Step 1: Write failing planner tests** for no active rows → 1536 MiB, standard active usage → 256 MiB-aligned target, exited rows ignored, unknown active metric → fail closed, and target already near max → no-op.
- [x] **Step 2: Run `cargo test --manifest-path qemu-center/Cargo.toml redroid:: -- --nocapture`** and confirm the planner tests fail because `ReclaimPlan` is absent.
- [x] **Step 3: Implement the pure planner** with normalized `Up`/`running` status, `used + max(768, count*512)` reserve, 1536 MiB floor, 256 MiB ceiling alignment, node-memory cap, and a no-op when less than 256 MiB is reclaimable.
- [x] **Step 4: Add the CLI flow**: load registry, require QMP `Running`, call the existing guest stats read path, refuse unknown active metrics, call `qmp::reclaim_memory`, and print the verified result. Do not modify registry or disk state.
- [x] **Step 5: Add CLI tests** for an unregistered VM, stopped/unknown VM, unsupported balloon device, and successful result rendering; then run `cargo test --manifest-path qemu-center/Cargo.toml`.

### Task 3: Tauri bridge and QEMU node action

**Files:**
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/i18n/pages/qemu.ts`
- Test: existing QEMU service/page tests and a focused planner/bridge test where applicable

**Interfaces:**
- Adds `QemuService.vmMemoryReclaim(name)` and the Tauri command `qemu_vm_memory_reclaim`.
- The page action calls the command once, shows the verified MiB result, and refreshes resource snapshots only after completion.

- [x] **Step 1: Write a failing Tauri/page test** asserting the node action is present, is disabled while busy through the shared node-operation guard, and reports the backend result without pretending memory was reclaimed.
- [x] **Step 2: Run `npx vitest run src/pages/QemuCenter.test.tsx --maxWorkers=1 --minWorkers=1`** and observe the missing action failure.
- [x] **Step 3: Implement the service and command bridge** using the existing qemu-center argument builder patterns; preserve stdout/stderr command-log behavior and do not add a second memory policy in the UI.
- [x] **Step 4: Add the node-card action and Chinese/English copy** explaining that it asks the backend for safe guest-page reclaim and does not stop the node.
- [ ] **Step 5: Run the focused QEMU/i18n tests, `npx tsc --noEmit`, and the full `npx vitest run --maxWorkers=1 --minWorkers=1`** (focused page test passed; full gates remain in Task 4).

### Task 4: Evidence, documentation, and final verification

**Files:**
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-068-qemu-balloon-memory-reclaim.md`
- Test: full repository verification commands

**Interfaces:**
- Produces a reproducible evidence note that separates automated protocol proof from manual WHPX measurements.

- [x] **Step 1: Write the evidence template** with exact fields for node `mem_mib`, target/actual balloon MiB, guest cgroup current/peak/OOM, QEMU working/private set, host available memory, app readiness, and whether the VM remained running.
- [x] **Step 2: Record automated results** from Tasks 1–3 and explicitly mark live WHPX fields `待人工确认` until a real node is available.
- [x] **Step 3: Update the handoff document** with the new command, safety boundary, and the fact that P7-1/manual stability remains outstanding.
- [x] **Step 4: Run all gates**: TypeScript, Vitest, Tauri (301/0/2), qemu-center (224/21), formatting, and diff checks pass.
- [x] **Step 5: Review the diff** for accidental live-state commands, grant/token logging, force-kill paths, or claims of measured host savings without evidence.
