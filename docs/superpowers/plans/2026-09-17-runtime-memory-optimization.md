# QEMU/Redroid Runtime Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce host memory pressure and avoid redroid OOMs by measuring the full QEMU/WSL/guest/container stack, adding explicit runtime profiles, and scheduling instances according to activity and available resources.

**Architecture:** Add a read-only resource snapshot contract at the Rust boundary, enrich QEMU/guest data with real cgroup and host measurements, and keep lifecycle decisions in one backend scheduler. The frontend renders the same snapshot and sends explicit activity signals; it does not invent memory numbers or run shell probes. Resource defaults change only after the baseline experiment selects a stable Pareto configuration.

**Tech Stack:** React + TypeScript, Tauri Rust services, standalone `qemu-center` Rust CLI, Docker/SSH/ADB, Vitest, Rust unit tests.

**Spec:** `docs/superpowers/specs/2026-09-17-runtime-memory-optimization-design.md`

## Global Constraints

- Preserve all unrelated dirty worktree changes; stage only files belonging to the current task.
- Do not hard-kill QEMU, modify a live qcow2 with offline tools, or delete the existing `r13` data volume.
- Keep Docker and QEMU track boundaries; reuse existing QEMU CLI JSON and runtime-metrics conventions.
- Missing metrics remain `null`/`unknown`; never map unavailable data to zero or green success.
- Real-device visual and browsing results are manual-confirmation evidence, not automated-test claims.
- Every production code change follows TDD: write one failing test, run it and observe the expected failure, implement the smallest passing behavior, then refactor while green.
- After each task run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path qemu-center/Cargo.toml` unless the task is explicitly documentation-only.
- Backend changes in `src-tauri` and `qemu-center` require the user's explicit authorization before implementation starts.

---

### Task 1: Add the resource snapshot domain contract

**Files:**
- Create: `src-tauri/src/services/resource_monitor.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models/mod.rs` only if the existing shared model module is the established serialization boundary
- Modify: `src/types/index.ts`
- Modify: `src/services/deviceService.ts`
- Test: `src-tauri/src/services/resource_monitor.rs` unit tests
- Test: `src/services/deviceService.test.ts` or a new `src/services/resourceMonitor.test.ts`

**Interfaces:**
- Produces Rust `RuntimeResourceSnapshot`, `MemoryPressure`, and `ResourceProbeError`.
- Produces Tauri command `read_runtime_resource_snapshot(vm: Option<String>, instance: Option<String>) -> Result<RuntimeResourceSnapshot, String>`.
- Produces TypeScript `RuntimeResourceSnapshot` with the exact camelCase fields from the spec: host totals, QEMU private/working-set bytes, WSL bytes, VM memory/vCPU, instance limit/current/peak/OOM count, boot/app readiness, and a `source` discriminator.

- [ ] **Step 1: Write the failing Rust tests**

```rust
#[test]
fn classifies_pressure_from_available_memory_without_treating_unknown_as_safe() {
    assert_eq!(classify_memory_pressure(Some(3 * 1024 * 1024 * 1024)), MemoryPressure::Normal);
    assert_eq!(classify_memory_pressure(Some(1500 * 1024 * 1024)), MemoryPressure::Caution);
    assert_eq!(classify_memory_pressure(Some(700 * 1024 * 1024)), MemoryPressure::Critical);
    assert_eq!(classify_memory_pressure(None), MemoryPressure::Unknown);
}

#[test]
fn serializes_missing_measurements_as_null() {
    let snapshot = RuntimeResourceSnapshot::empty_for_test();
    let json = serde_json::to_value(snapshot).unwrap();
    assert!(json["hostAvailableBytes"].is_null());
    assert!(json["instanceOomKills"].is_null());
}
```

- [ ] **Step 2: Run the focused Rust test and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests::classifies_pressure -- --exact`

Expected: FAIL because the resource-monitor types and classifier do not exist yet.

- [ ] **Step 3: Implement the pure contract and classifier**

Use `#[serde(rename_all = "camelCase")]` for the public Rust struct and `Option<u64>` for measurements. Keep thresholds in one `MemoryThresholds` value; do not scatter byte literals through the service. Implement `empty_for_test()` only behind `#[cfg(test)]`.

- [ ] **Step 4: Run focused Rust and TypeScript contract tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests -- --nocapture`

Run: `npx vitest run src/services/resourceMonitor.test.ts`

Expected: PASS, with no field-name drift between Rust JSON and TypeScript types.

- [ ] **Step 5: Expose the read-only command**

Register the module and command in the existing service and Tauri handler lists. The command must return a structured error for an unavailable probe and must not start, stop, or mutate a VM/container.

- [ ] **Step 6: Run the full four-suite gate and commit**

Run: `npx tsc --noEmit`; `npx vitest run`; `cargo test --manifest-path src-tauri/Cargo.toml`; `cargo test --manifest-path qemu-center/Cargo.toml`.

Commit: `feat: add runtime resource snapshot contract`

---

### Task 2: Implement Windows host and QEMU process probes

**Files:**
- Modify: `src-tauri/src/services/resource_monitor.rs`
- Modify: `src-tauri/Cargo.toml` only if the existing Windows process-query dependency is insufficient
- Test: `src-tauri/src/services/resource_monitor.rs` parser tests

**Interfaces:**
- Consumes `RuntimeResourceSnapshot` from Task 1.
- Produces `collect_host_snapshot(qemu_pid: Option<u32>) -> Result<RuntimeResourceSnapshot, ResourceProbeError>`.
- Produces pure parsers for total/available host memory and process private/working-set values so Windows command output is not tested through a live host.

- [ ] **Step 1: Write failing parser tests**

```rust
#[test]
fn parses_process_private_and_working_set_bytes() {
    let process = parse_process_memory("11704|4654596096|639070208").unwrap();
    assert_eq!(process.private_bytes, 4_654_596_096);
    assert_eq!(process.working_set_bytes, 639_070_208);
}

#[test]
fn rejects_malformed_or_negative_process_values() {
    assert!(parse_process_memory("11704|-1|10").is_err());
    assert!(parse_process_memory("not-a-process").is_err());
}
```

- [ ] **Step 2: Run focused tests and verify they fail for the missing parser**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests::parses_process -- --exact`

Expected: FAIL with the parser unavailable.

- [ ] **Step 3: Implement the platform probe with a bounded timeout**

Use the existing command utility and Windows-native process query available in the crate. Query only the target QEMU process and the `vmmemWSL` process; do not enumerate arbitrary user processes or log command output containing unrelated paths. Convert bytes exactly and return `None` when a process is absent.

- [ ] **Step 4: Add the host probe integration test seam**

Inject a `HostProbe` trait or equivalent function boundary so unit tests can provide fixture text. A missing QEMU PID must produce a valid snapshot with QEMU fields `null`, not a fabricated zero.

- [ ] **Step 5: Run all four suites and commit**

Commit: `feat: collect host and qemu memory measurements`

---

### Task 3: Add guest/container runtime statistics to `qemu-center`

**Files:**
- Modify: `qemu-center/src/redroid.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/exec.rs` only if the existing SSH execution helper cannot carry read-only commands
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/services/qemu_presets.rs` only for enrichment of the existing instance model
- Test: `qemu-center/src/redroid.rs` and `src-tauri/src/services/qemu.rs`

**Interfaces:**
- Produces CLI command `redroid stats <vm> [instance] --json`.
- Produces JSON `RedroidRuntimeStats { instance, container, status, memoryLimitBytes, memoryCurrentBytes, memoryPeakBytes, oomKills, cpuUsagePercent, bootCompleted }` with nullable measurements.
- Produces bridge function `qemu::redroid_stats(vm: &str, instance: Option<&str>) -> Result<Vec<QemuRedroidRuntimeStats>, String>`.

- [ ] **Step 1: Write failing argument and parser tests**

```rust
#[test]
fn stats_command_requests_cgroup_and_boot_state_without_mutation() {
    let args = redroid_stats_args("node1", Some("r13"));
    assert_eq!(args, vec!["redroid", "stats", "node1", "r13", "--json"]);
}

#[test]
fn stats_parser_preserves_missing_cgroup_values_as_none() {
    let rows = parse_redroid_stats_json(r#"[{"instance":"r13","memory_limit_bytes":null,"oom_kills":null}]"#).unwrap();
    assert_eq!(rows[0].memory_limit_bytes, None);
    assert_eq!(rows[0].oom_kills, None);
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path qemu-center/Cargo.toml redroid::tests::stats_command -- --exact`

Expected: FAIL because the CLI command and pure builder are missing.

- [ ] **Step 3: Implement read-only guest collection**

Inside the guest, read Docker cgroup files/`docker stats` and `getprop sys.boot_completed` through the existing SSH execution path. Use a machine-readable delimiter or JSON generated by the CLI; do not parse human table columns. A container that has exited must still report its last known status and nullable counters.

- [ ] **Step 4: Implement bridge parsing and model enrichment**

Add raw snake_case wire structs in `src-tauri/src/services/qemu.rs`, convert them to the existing camelCase public model, and keep the current `metrics` behavior intact. Do not overwrite existing runtime metrics with zero when stats fail.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: expose qemu guest runtime statistics`

---

### Task 4: Add explicit `lean`, `standard`, and `full` resource profiles

**Files:**
- Modify: `qemu-center/src/redroid.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src/types/index.ts`
- Modify: `src/services/deviceService.ts`
- Test: `qemu-center/src/redroid.rs`, `src-tauri/src/services/qemu.rs`, and a new `src/lib/runtimeProfile.test.ts`

**Interfaces:**
- Produces `ResourceProfile::{Lean, Standard, Full}` and `ResourceProfile::container_defaults(node_vcpus, node_mem_mib)`.
- Produces `validate_resource_budget(node_memory_mib, instance_memory_mib, running_instances) -> Result<(), ResourceBudgetError>`.
- Adds `profile` to the redroid create request and to the serialized instance/preset metadata.

- [ ] **Step 1: Write failing profile and budget tests**

```rust
#[test]
fn lean_profile_does_not_enable_optional_preloads() {
    let defaults = ResourceProfile::Lean.defaults_for_node(4, 4096);
    assert_eq!(defaults.memory_mib, 1536);
    assert!(!defaults.install_gapps);
    assert!(!defaults.install_magisk);
}

#[test]
fn budget_rejects_two_instances_that_leave_no_node_headroom() {
    let result = validate_resource_budget(4096, 2048, 2);
    assert!(matches!(result, Err(ResourceBudgetError::InsufficientHeadroom { .. })));
}
```

- [ ] **Step 2: Run the focused tests and confirm the failure**

Run: `cargo test --manifest-path qemu-center/Cargo.toml redroid::tests::lean_profile -- --exact`

Expected: FAIL because profiles and budget validation are not present.

- [ ] **Step 3: Implement pure profile mapping**

Keep optional component selection separate from memory sizing. The profile may suggest defaults, but the create request must retain explicit user overrides. Reject impossible combinations before invoking Docker and include the required headroom in the error.

- [ ] **Step 4: Thread profile through CLI/bridge/UI types**

Update the existing `QemuRedroidCreateRequest` without breaking omitted fields: deserialize an absent profile as `standard`, serialize only the selected profile, and keep the current GApps Android/ABI validation as the final gate.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: add explicit redroid resource profiles`

---

### Task 5: Add serialized start scheduling and safe idle reclamation

**Files:**
- Create: `src-tauri/src/services/runtime_scheduler.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/types/index.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/pages/Settings.tsx`
- Modify: the existing settings model/defaults in `src-tauri/src/models/mod.rs` and `src-tauri/src/services/settings.rs`
- Test: `src-tauri/src/services/runtime_scheduler.rs` and `src/pages/tracks/QemuTrackPanel.test.tsx`

**Interfaces:**
- Produces `LifecyclePolicy { idle_timeout_minutes, keep_vm_warm, max_parallel_starts, protected_instance_ids }`.
- Produces `RuntimeActivity { instance, kind, at }` where `kind` is `user_window | adb | stream | recording | transfer | automation`.
- Produces commands `runtime_mark_activity`, `runtime_request_start`, `runtime_release_idle`.
- Produces `StartDecision::{Starting, Ready, Queued, Blocked(ResourcePressure), Failed(String)}`.

- [ ] **Step 1: Write failing scheduler tests**

```rust
use std::time::{Duration, SystemTime};

#[test]
fn second_start_is_queued_while_the_same_vm_is_booting() {
    let mut scheduler = SchedulerState::default();
    assert_eq!(scheduler.request_start("node1", "r13"), StartDecision::Starting);
    assert_eq!(scheduler.request_start("node1", "r1"), StartDecision::Queued);
}

#[test]
fn active_stream_prevents_idle_reclamation() {
    let mut scheduler = SchedulerState::with_idle_minutes(30);
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_600);
    scheduler.mark_activity("r13", ActivityKind::Stream, now - Duration::from_secs(31 * 60));
    scheduler.mark_activity("r13", ActivityKind::UserWindow, now - Duration::from_secs(2 * 60));
    assert!(!scheduler.is_reclaimable("r13", now));
}
```

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml runtime_scheduler::tests::second_start -- --exact`

Expected: FAIL because the scheduler state and decisions do not exist.

- [ ] **Step 3: Implement the backend scheduler state machine**

Use one synchronized scheduler state for a VM. Permit at most one VM/container initialization at a time, preserve queue order, and release the next request after a terminal result. `runtime_release_idle` may stop only an instance that meets every idle condition and is not protected. It must call the existing graceful redroid/VM stop functions and never call `Stop-Process`.

- [ ] **Step 4: Add settings persistence and frontend activity signals**

Extend `AppSettings` with the policy fields and backward-compatible defaults. The QEMU panel marks activity when the device window, stream, transfer, automation, or ADB operation is active. Returning to a running instance only marks activity and refreshes the foreground state; it does not force-stop or restart the app.

- [ ] **Step 5: Add UI states for normal/caution/critical/unknown pressure**

Render the structured `StartDecision` and explain which idle instances can be stopped. Do not auto-stop an instance solely because a metric is missing; show the unknown state and require the explicit single-instance action defined by the policy.

- [ ] **Step 6: Run the four-suite gate and commit**

Commit: `feat: schedule qemu starts and reclaim idle instances safely`

---

### Task 6: Add ART compilation as an explicit, measured experiment

**Files:**
- Create: `src-tauri/src/services/art.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/types/index.ts`
- Test: `src-tauri/src/services/art.rs` and `src/pages/tracks/QemuTrackPanel.test.tsx`

**Interfaces:**
- Produces `optimize_app(serial: &str, package: &str, mode: ArtMode) -> Result<ArtOptimizationResult, String>`.
- Produces pure `art_args(package: &str, mode: ArtMode) -> Vec<String>` for command construction tests.
- `ArtMode` is limited to `VerifyOnly`, `SpeedProfile`, and `Reset`; reset requires explicit confirmation.
- The result includes package, mode, command exit status, elapsed time, and a warning that ART does not remove ARM64 translation cost.

- [ ] **Step 1: Write failing command-builder tests**

```rust
#[test]
fn speed_profile_uses_a_profile_guided_compile_command() {
    assert_eq!(art_args("com.xingin.xhs", ArtMode::SpeedProfile), vec![
        "cmd", "package", "compile", "-m", "speed-profile", "-f", "com.xingin.xhs"
    ]);
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml art::tests::speed_profile -- --exact`

Expected: FAIL because the ART command builder is missing.

- [ ] **Step 3: Implement the bounded ADB operation**

Validate the package name, execute through the existing ADB service with a timeout, and return the raw success/failure classification without claiming that the app is optimized when the device rejected the command.

- [ ] **Step 4: Add the UI action and experiment record**

Require a baseline resource snapshot and startup measurement before the action, store the post-action measurement in the experiment record, and show the comparison only when both samples exist.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: measure art profile guided compilation`

---

### Task 7: Baseline matrix, default selection, and manual acceptance

**Files:**
- Create: `docs/qa/2026-09-17-runtime-memory-optimization-matrix.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Modify: `docs/compatibility.md` only for verified results
- Test: existing full test suites plus the real-node checklist

**Interfaces:**
- Consumes the resource snapshot, profiles, scheduler, and ART result from Tasks 1–6.
- Produces an evidence table with node memory, vCPU, profile, container limit, optional components, ART mode, cold/warm start medians, steady-state memory, OOM count, and manual browsing result.

- [ ] **Step 1: Create disposable experiment instances**

Use a new instance or safe clone for each matrix cell. Keep `r13` intact and stop/start the node only through `qemu-center vm stop/start`; do not hard-kill QEMU or use offline snapshot tooling against the running disk.

- [ ] **Step 2: Execute the 3× repetition matrix**

Run the combinations specified by the design: 3072/4096 MiB VM, 2/4 vCPU, lean/standard/full, 1536/2048/3072 MiB container, optional preload variants, ART default/speed-profile, and warm/cold lifecycle. Record median, maximum, OOM and ADB failures.

- [ ] **Step 3: Select defaults using the evidence**

Choose the lowest-memory combination that passes 30 minutes of stability and does not regress cold/warm startup by more than 15%. If no lower-memory combination passes, keep 4096 MiB and document the limiting component instead of lowering the default.

- [ ] **Step 4: Perform manual acceptance**

Manually confirm login and continuous browsing for the selected lean and full paths. Mark visual/real-device results as `通过` only with human evidence; automated tests can verify state wiring but not browsing quality.

- [ ] **Step 5: Run the full four-suite gate, update the handoff, and commit**

Commit: `docs: record runtime memory optimization evidence`
