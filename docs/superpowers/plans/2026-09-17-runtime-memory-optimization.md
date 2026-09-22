# QEMU/Redroid Runtime Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce host memory pressure and avoid redroid OOMs by measuring the full QEMU/WSL/guest/container stack, adding explicit runtime profiles, and scheduling instances according to activity and available resources.

**Architecture:** Add a read-only resource snapshot contract at the Rust boundary, enrich QEMU/guest data with real cgroup and host measurements, and keep lifecycle decisions in one backend scheduler. The frontend renders the same snapshot and sends explicit activity signals; it does not invent memory numbers or run shell probes. Resource defaults change only after the baseline experiment selects a stable Pareto configuration.

**Tech Stack:** React + TypeScript, Tauri Rust services, standalone `qemu-center` Rust CLI, Docker/SSH/ADB, Vitest, Rust unit tests.

**Spec:** `docs/superpowers/specs/2026-09-17-runtime-memory-optimization-design.md`

## Implementation status (2026-09-17)

- Tasks 1–6 are implemented: read-only resource probes, QEMU/guest stats,
  explicit profiles, bounded scheduler/idle release, ART experiment commands,
  and frontend status rendering.
- The Task 5 queue-correctness follow-up is implemented: queued starts are
  retained in backend FIFO state, duplicate requests are rejected, each
  waiter has a bounded timeout, and the next request is promoted after both
  successful and failed starts.
- Task 7 is intentionally split: new-node default is now 3072 MiB, while the
  existing 4096 MiB node is not rewritten. The 3×3 performance matrix and
  real-device acceptance remain manual work tracked in
  `docs/2026-09-17-runtime-memory-authorization-acceptance.md` and
  `docs/qa/2026-09-17-runtime-memory-optimization-matrix.md`.
- Do not claim a fixed memory saving until that matrix records cold start,
  warm switch, stable usage, peak usage, OOM count, and browsing stability.
- Task 8 is implemented as a manual, app-level hibernation path. It preserves the VM and
  redroid container and only force-stops a validated package after an exact
  QEMU ADB mapping and idle-policy check. This is an optimization control, not
  a replacement for the pending real-device matrix.
- The authorization audit found that an existing client's registration version was being
  changed before proof-of-possession. Task 9 hardens registration so the requested version
  is staged with the challenge and applied only after a valid device signature; invalid or
  unsolicited registration requests cannot revoke active sessions.
- Follow-up Task 12 completes critical-pressure reclaim: when enabled, the backend attempts
  one safe idle-container reclaim on the target node, re-probes host pressure, and only then
  blocks a start. It never reclaims the target/protected/unknown-status instance, never stops
  the node during this path, and serializes reclaim attempts.
- Follow-up Task 13 aligns the lean profile floor with the measured 3 GiB/4 GiB starting point:
  a node with enough headroom offers at least 1536 MiB instead of an unsafe 1152 MiB default.
  The user can still override the explicit container limit.
- Follow-up Task 17 closes the VM-level start gap found during an isolated 3072 MiB test:
  the desktop start command now checks the requested node memory plus 1 GiB headroom before
  invoking QEMU, so a second large node cannot silently drive host available memory critical.
- Follow-up Task 18 extends the same invariant into the standalone `qemu-center vm start`
  command: it performs a host-available-memory probe and QMP stopped-state check before
  spawning QEMU, so direct CLI use cannot bypass the desktop guard.
- Follow-up Task 20 fixes the documented idle-timeout floor: a configured value of 0 is
  treated as 1 minute at the scheduler boundary instead of making an instance immediately
  reclaimable.

## Global Constraints

- Preserve all unrelated dirty worktree changes; stage only files belonging to the current task.
- Do not hard-kill QEMU, modify a live qcow2 with offline tools, or delete the existing `r13` data volume.
- Keep Docker and QEMU track boundaries; reuse existing QEMU CLI JSON and runtime-metrics conventions.
- Missing metrics remain `null`/`unknown`; never map unavailable data to zero or green success.
- Real-device visual and browsing results are manual-confirmation evidence, not automated-test claims.
- Every production code change follows TDD: write one failing test, run it and observe the expected failure, implement the smallest passing behavior, then refactor while green.
- After each task run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path qemu-center/Cargo.toml` unless the task is explicitly documentation-only.
- Backend changes in `src-tauri` and `qemu-center` require the user's explicit authorization before implementation starts.
- A known host-memory shortage must be rejected before a new QEMU process is spawned; unknown probe data preserves the existing explicit-single-start compatibility behavior.

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

Use one synchronized scheduler state for a VM. Permit at most one VM/container initialization at a time, preserve queue order, and release the next request after a terminal result. A queued request must remain in a backend FIFO queue and be automatically promoted; duplicate requests for the same `(vm, instance)` must not start twice. `runtime_release_idle` may stop only an instance that meets every idle condition and is not protected. It must call the existing graceful redroid/VM stop functions and never call `Stop-Process`.

#### Queue correctness follow-up

- [x] Add a backend condition-variable/notification path so a queued Tauri command waits for its own turn (with a bounded timeout), instead of returning a terminal-looking `Queued` state that has no owner.
- [x] Add pure tests for FIFO promotion, duplicate suppression, queue timeout/cancellation, and promotion after both success and failure.
- [x] Keep the existing memory-pressure check immediately before the promoted start; a newly critical host returns `Blocked` without invoking QEMU.

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

---

### Task 8: Add safe manual app-level hibernation

**Files:**
- Modify: `src-tauri/src/services/runtime_scheduler.rs`
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/index.ts`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/i18n/pages/qemu.ts`
- Test: scheduler package validation and QEMU mapping tests

The action is deliberately explicit and manual. It must not introduce an
automatic timer, clear app data, stop a container, or stop a VM.

- [x] **Step 1: Write failing pure tests**

  Add tests for strict Android package validation and exact
  `(vm, instance, serial)` matching against `QemuAdbMapping` rows. Run the
  focused tests and observe the expected failure before implementation.

- [x] **Step 2: Implement the smallest backend path**

  Add a serializable `AppHibernateResult`, validate inputs, check the current
  scheduler policy/activity, verify the QEMU mapping through `qemu::adb_list`,
  and call the existing validated `device::stop_app`. Any failed precondition
  returns a structured non-release result and never contacts the guest.

- [x] **Step 3: Expose the command and UI control**

  Register `runtime_hibernate_app`, add a service wrapper and a translated
  confirmation button defaulting to `com.xingin.xhs`. Keep the existing
  DeviceDetail start-app action as the wake path and explain that the VM and
  container remain running.

- [x] **Step 4: Run the full gate and update evidence**

  Run all four project suites plus TypeScript checking, update the acceptance
  matrix with the app-level A/B procedure, and leave the real cold/warm/login/
  browsing comparison marked for manual confirmation.

---

### Task 10: Allow safe offline node-memory reconfiguration

**Files:**
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/vm.rs` only if a pure validation helper is needed
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/types/index.ts`
- Modify: `src/i18n/pages/qemu.ts`
- Test: CLI argument/state tests, Tauri bridge tests, and QEMU panel tests

- [x] **Step 1: Write a failing test for the stopped-only memory update**

  The pure policy must accept 3072 MiB, reject values outside 1536–16384 MiB,
  and refuse the mutation whenever QMP reports running or unknown.

- [x] **Step 2: Implement the CLI mutation with QMP liveness protection**

  Add `vm set-memory <name> <mem>`; update only `state.json` after a refused
  QMP probe. Do not edit a disk, restart a VM, or kill a process.

- [x] **Step 3: Expose the action in the Rust bridge and UI**

  Add a node-row action that asks for the new MiB value, explains that it takes
  effect on the next start, and refreshes the node list after success.

- [x] **Step 4: Run the full gate and update evidence**

  Keep the existing node unchanged during automated tests; record the command
  as an available control for the manual memory matrix.

---

### Task 9: Harden proof-of-possession before registration mutation

**Files:**
- Modify: `authorization-service/src/store.rs`
- Modify: `authorization-service/src/routes.rs`
- Modify: `docs/SECURITY.md`
- Test: `authorization-service/src/routes.rs` and `authorization-service/src/store.rs`

- [x] **Step 1: Add a failing route test**

  Verify that an existing client's requested version does not change and its
  active session is not revoked merely after `/register`; only a valid signed
  `/register/complete` applies the version update and revokes the old session.

- [x] **Step 2: Stage the requested version with the challenge**

  Persist the requested client version with the one-time challenge. Complete
  registration first verifies the device signature, then applies the staged
  version update and session revocation.

- [x] **Step 3: Run the full four-suite gate and record the security audit**

  Run the authorization-service tests and the project-mandated four-suite gate,
  then record the threat model, audit scope, residual runtime-plaintext limit,
  and evidence in the handoff/evidence log.

---

### Task 11: Refuse inconsistent live-node clones before the memory matrix

**Files:**
- Modify: `qemu-center/src/main.rs`
- Modify: `qemu-center/src/vm.rs`
- Modify: `qemu-center/README.md`
- Test: `qemu-center/src/vm.rs`

**Acceptance:**

- [x] A source VM must be QMP-proven stopped before `qemu-img create -b` is
  invoked for a clone.
- [x] Running or unknown source liveness returns a clear refusal and performs
  no disk command.
- [x] The existing node remains untouched; rerun the qemu-center test suite.

---

### Task 12: Reclaim one safe idle instance before a critical-pressure start

**Files:**
- Modify: `src-tauri/src/services/runtime_scheduler.rs`
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/deviceService.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/stores/appStore.ts`
- Modify: `src/types/index.ts`
- Modify: `src/i18n/pages/qemu.ts`
- Test: scheduler, QEMU status classification, settings serialization, and UI wiring

**Acceptance:**

- [x] A critical-pressure start tries at most one reclaim at a time, only on the
  target VM, and only for a known-running instance that is idle past the policy
  timeout and not protected.
- [x] The target instance, protected instances, exited instances, unknown-status
  instances, and instances with a concurrent reclaim are never stopped.
- [x] The node remains running during automatic reclaim; data volumes are never
  deleted; a failed reclaim or still-critical re-probe returns `Blocked`.
- [x] The setting defaults to enabled for older settings files but can be disabled
  explicitly; manual idle release keeps its existing behavior.

---

### Task 13: Keep the lean profile at a usable measured floor

**Files:**
- Modify: `src/lib/runtimeProfile.ts`
- Modify: `src/lib/runtimeProfile.test.ts`
- Modify: `qemu-center/src/redroid.rs`
- Test: 3 GiB and 4 GiB lean profile defaults

**Acceptance:**

- [x] A node with at least 3 GiB offers a 1536 MiB lean starting limit,
  matching the measured XHS baseline; smaller nodes retain a conservative
  lower floor instead of exceeding the node budget.
- [x] TypeScript and qemu-center profile mappings remain consistent.

### Task 14: Count only confirmed-running containers in create budget

**Files:**

- Modify: `qemu-center/src/guest.rs`
- Modify: `qemu-center/src/main.rs`
- Test: `qemu-center/src/guest.rs`

The create path currently uses the number of registered ADB assignments as the
running-instance count. That makes an exited container continue consuming
memory budget and can reject a valid second instance after idle release. Add a
pure status parser that counts only `Up`/`running` `qc-*` rows. Query the guest
with the existing read-only `docker ps -a` command before budget validation;
when the guest or output is unavailable, retain the registered-count fallback.

- [x] Write the failing parser test for exited/unknown rows being excluded.
- [x] Add the pure parser and use it in `cmd_redroid_create` with conservative
  fallback on failed/incomplete status collection.
- [x] Verify the qemu-center test suite and document the new budget evidence in
  `work/runtime-core-protection-20260917/evidence/E-022-running-budget-count.md`.

### Task 15: Make CLI profile defaults match the memory ladder

**Files:**

- Modify: `qemu-center/src/main.rs`
- Test: `qemu-center/src/redroid.rs`

The CLI currently gives `--profile lean` the standard profile's implicit
`--memory 2048` unless the operator also supplies an explicit memory value.
Use optional CLI overrides and resolve omitted CPU/memory values from the
selected profile and the registered node. Explicit overrides remain unchanged.

- [x] Write the failing profile-resolution test.
- [x] Implement optional overrides and profile-derived defaults.
- [x] Run the qemu-center suite; 211 library tests + 6 CLI tests pass.

### Task 16: Expose per-instance memory saturation separately from host pressure

**Files:**

- Modify: `src/lib/runtimeProfile.ts`
- Test: `src/lib/runtimeProfile.test.ts`
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/i18n/pages/qemu.ts`

The panel already shows host pressure and raw instance current/limit values, but
it does not tell the operator when an individual container is near its own cgroup
ceiling. Add a pure ratio classifier and a read-only badge/message. Missing or
invalid measurements must remain `unknown`; the UI must not change a live limit.

- [x] Write the failing saturation-classification tests.
- [x] Implement the classifier, translations, and per-instance UI indicator.
- [x] Run the frontend gate and record the result.

---

### Task 17: Guard VM-level starts with requested-memory headroom

**Files:**

- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `docs/superpowers/specs/2026-09-17-runtime-memory-optimization-design.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-028-vm-start-memory-guard.md`
- Test: `src-tauri/src/commands/mod.rs` pure resource-policy tests

The existing instance scheduler checks host pressure, but the QEMU node start
button calls `qemu_vm_start` directly. A second 3072 MiB node was therefore
allowed while the first 4096 MiB node was running, dropping host available
memory to about 0.25 GiB during an isolated trial. Add a preflight that reads
the registered node's `mem_mib` and blocks only when known host available
memory is below `mem_mib + 1024 MiB`. Do not alter QEMU arguments or stop a
running node; unknown probe data keeps the existing explicit-single-start
compatibility behavior.

- [x] **Step 1: Write the failing pure policy test**

Add one test showing the requested-memory rule:

```rust
assert!(should_block_qemu_vm_start(Some(3 * GIB), Some(3072)));
assert!(!should_block_qemu_vm_start(Some(5 * GIB), Some(3072)));
assert!(!should_block_qemu_vm_start(None, Some(3072)));
```

- [x] **Step 2: Run the focused test and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::qemu_vm_start_requires_requested_memory_headroom -- --exact`

Expected: FAIL because the VM-level capacity helper does not exist yet.

- [x] **Step 3: Implement the minimal guard**

Add a pure helper with one `1024 MiB` headroom constant. In `qemu_vm_start`, serialize the read-only preflight with a process-local mutex, read the node entry and host snapshot, return a user-readable error for known insufficient memory, and call the existing `qemu::vm_start` only after the check. Preserve the existing behavior when the host probe is unavailable.

- [x] **Step 4: Run the focused test and full project gate**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::tests::qemu_vm_start_requires_requested_memory_headroom -- --exact
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
```

Expected: the focused test and all project suites pass; no live QEMU is started by the test.

- [x] **Step 5: Record the isolated-trial evidence and update the handoff**

Record the 2 vCPU trial's observed critical pressure, graceful stop, purge, and unchanged
`node1/r13` state in E-028. Keep the manual 3072/4096 profile matrix and production authorization
deployment marked incomplete.

---

### Task 18: Add defense-in-depth memory guard to standalone VM starts

**Files:**

- Modify: `qemu-center/src/doctor.rs`
- Modify: `qemu-center/src/vm.rs`
- Modify: `qemu-center/src/main.rs`
- Modify: `docs/superpowers/specs/2026-09-17-runtime-memory-optimization-design.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-029-cli-vm-start-memory-guard.md`
- Test: `qemu-center/src/doctor.rs` and `qemu-center/src/vm.rs` pure policy tests

The desktop Tauri command already checks the requested node memory plus 1 GiB headroom,
but a direct `qemu-center vm start` can currently spawn QEMU without that check. Add a
read-only host probe (Windows CIM `FreePhysicalMemory`; Linux `/proc/meminfo`), a pure
requested-memory policy helper, and a QMP liveness gate. A known shortage or unknown
QMP state must refuse before spawn; an unavailable host-memory probe keeps the existing
explicit single-start compatibility path with a warning. No process is killed and no
disk is modified.

- [x] **Step 1: Write failing parser and policy tests**

  Cover Windows KiB parsing, Linux `MemAvailable` parsing, the `mem_mib + 1024 MiB`
  threshold, and the unknown-memory compatibility path.

- [x] **Step 2: Run focused tests and observe the expected failure**

  Run the focused qemu-center tests before adding the helpers; compilation must fail
  because the new probe/policy functions do not exist.

- [x] **Step 3: Implement the smallest CLI guard**

  Add the platform-specific read-only probe, shared pure policy, and `cmd_vm_start`
  preflight. Refuse QMP `Unknown`, refuse known insufficient host memory, warn but allow
  a single explicit start when only the host memory probe is unavailable, then call the
  existing detached spawn path.

- [x] **Step 4: Run all required gates and record E-029**

  Run the four project gates, qemu-center focused tests, formatting and diff checks. Do
  not start a live VM as part of the test; verify the existing node registry is unchanged.

---

### Task 19: Gate new full profiles on the measured node-memory boundary

The live E-033 sample shows that a full instance nearly consumes the 3 GiB
container limit on a 4 GiB node and leaves the Windows host in critical
pressure. Prevent new full-profile instances on nodes below 6144 MiB while
leaving existing instances untouched. Keep lean/standard available and make
the same rule visible in the desktop create form.

- [x] **Step 1: Write failing backend and form-policy tests**

  Cover full rejection below 6144 MiB, full acceptance at 6144 MiB, and the
  unchanged lean/standard mappings on a 4096 MiB node.

- [x] **Step 2: Run the focused tests and observe the expected failure**

  Run the qemu-center resource-profile tests and the frontend runtime-profile
  tests before adding the admission helper.

- [x] **Step 3: Implement the authoritative backend guard and form hint**

  Reject `full` in the shared resource resolver before Docker create; expose a
  pure frontend availability helper and disable the unsafe form option with a
  concise explanation. Do not modify or stop existing containers.

- [x] **Step 4: Run all required gates and record the evidence**

  Run `npx tsc --noEmit`, `npx vitest run`, both project cargo suites, format
  checks, and `git diff --check`. Update the acceptance and handoff records
  with the exact policy and note that the 3072/4096 real-use matrix remains
  manual.

---

### Task 20: Enforce the documented one-minute idle-timeout floor

The settings UI says that an idle timeout of `0` is treated as one minute, but
the scheduler currently turns it into a zero-duration timeout and can reclaim a
just-idled instance immediately. Preserve the user-visible contract and avoid
surprising performance regressions.

- [x] **Step 1: Write the failing scheduler test**

  Assert that an instance idle for 59 seconds is not reclaimable when the
  configured timeout is 0, while an instance idle for 60 seconds is.

- [x] **Step 2: Run the focused test and observe the expected failure**

  Run `cargo test --manifest-path src-tauri/Cargo.toml services::runtime_scheduler::tests::zero_idle_timeout_uses_one_minute_floor -- --exact`.

- [x] **Step 3: Implement the boundary normalization**

  Apply a one-minute minimum only when evaluating elapsed idle time; retain the
  stored setting value so the UI can continue to show the operator's choice.

- [x] **Step 4: Run the four project gates and update the handoff**

  Run the required TypeScript, Vitest, Tauri, qemu-center, formatting and diff
  checks. The gate passed with 458 Vitest tests, 277 Tauri tests plus one
  ignored test, and 213 qemu-center library tests plus six CLI tests; no live VM
  or container was touched.

---

### Task 21: Never stop a warm QEMU node while another instance is running

The memory-first setting `keepVmWarm=false` lets idle release stop the node after
the released container is stopped. That node-level stop is safe only when a
fresh read-only listing proves that no other instance is running. Otherwise the
release must stop only the idle container and keep the node alive. If the listing
is unavailable or contains an unknown status, fail closed and do not stop the
node.

- [x] **Step 1: Write the failing pure policy tests**

  Cover: memory-first with no remaining running instances allows node stop;
  another `Up`/`running` instance blocks node stop; an unknown or unavailable
  listing also blocks node stop; `keepVmWarm=true` never stops the node.

- [x] **Step 2: Run the focused tests and observe the expected failure**

  Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::idle_release_only_stops_an_empty_node -- --exact`
  The first run failed to compile because the policy helper did not exist yet;
  after implementation the same focused test passed.

- [x] **Step 3: Add the read-only guard before `vm_stop`**

  Query the existing `redroid_list_basic` bridge after stopping the target
  container, use the pure policy helper, and treat probe errors/unknown rows as
  “keep the node running”. Never stop or restart another instance implicitly.

- [x] **Step 4: Run the full gate and record the safety evidence**

  Run the four project suites, authorization-service tests, formatting and
  diff checks. No live VM is required for the policy tests. Evidence:
  `work/runtime-core-protection-20260917/evidence/E-045-idle-release-node-stop-guard-20260918.md`.
