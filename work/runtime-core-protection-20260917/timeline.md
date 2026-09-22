# Timeline (append-only)

## 2026-09-17T14:08:28.0683500+08:00 | lead | init
- action: case-init
- command_or_ref: skills/scripts/case-init.ps1
- result_summary: case directory created; scope pending auth
- artifacts: [scope.md, workitems.md]
- evidence_ids: []
- next: fill scope auth + in_scope; set ready_for_act

## 2026-09-17 | lead | design-and-implementation
- action: implemented-runtime-and-server-authoritative-core
- command_or_ref: docs/superpowers/specs/2026-09-17-runtime-memory-optimization-design.md; docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md
- result_summary: added resource snapshots, explicit profiles, safe scheduler/ART controls, DPAPI device identity, signed leases, Rust authorization gate, and encrypted artifact chunk delivery
- artifacts: [src-tauri/src/services/resource_monitor.rs, src-tauri/src/services/runtime_scheduler.rs, src-tauri/src/services/authorization.rs, src-tauri/src/services/authorization_client.rs, src-tauri/src/services/secure_store.rs, authorization-service/]
- evidence_ids: [E-001, E-002, E-003]
- next: run final automated gate and perform manual matrix/deployment acceptance

## 2026-09-17 | lead | documentation
- action: report-and-acceptance-pack
- command_or_ref: docs/2026-09-17-runtime-memory-and-core-delivery-report.md; docs/2026-09-17-runtime-memory-authorization-acceptance.md
- result_summary: documented memory accounting, security boundaries, Mermaid paths, evidence chain, residual risk, and manual acceptance conditions
- artifacts: [docs/2026-09-17-runtime-memory-and-core-delivery-report.md, docs/2026-09-17-runtime-memory-authorization-acceptance.md, work/runtime-core-protection-20260917/evidence/]
- evidence_ids: [E-001, E-002, E-003, E-004]

## 2026-09-17 | lead | validation-and-observability-fix
- action: fixed-redroid-stats-join-and-reran-gates
- command_or_ref: qemu-center/src/guest.rs; qemu-center/src/main.rs; cargo test; cargo run redroid stats; npx tsc --noEmit; npx vitest run; git diff --check
- result_summary: joined Docker short IDs with full inspect IDs, replaced fragile nested awk quoting, and verified the product CLI returns current/peak/OOM/CPU/boot metrics; full automated gates are green after one reproducible standalone PTY rerun
- artifacts: [qemu-center/src/guest.rs, qemu-center/src/main.rs, work/runtime-core-protection-20260917/evidence/E-001-runtime-baseline.md, work/runtime-core-protection-20260917/evidence/E-004-validation.md]
- evidence_ids: [E-001, E-004]
- next: perform manual memory matrix, production authorization deployment, tamper/revocation drill, and real-device acceptance

## 2026-09-17 | lead | component-observation
- action: collected-android-process-memory-breakdown
- command_or_ref: adb -s 127.0.0.1:24501 shell ps -A -o PID,PPID,RSS,NAME; adb -s 127.0.0.1:24501 shell dumpsys meminfo com.xingin.xhs
- result_summary: observed 13 Xiaohongshu processes and approximately 1.04 GiB aggregate RSS across selected GApps/Play/Quick Search/LSPosed processes; shared RSS is explicitly not summed with cgroup current
- artifacts: [work/runtime-core-protection-20260917/evidence/E-005-app-process-breakdown.md]
- evidence_ids: [E-005]
- next: implement or expose a safe VM-warm/app-hibernation A/B path before changing full memory limits

## 2026-09-17 | lead | acceptance-preparation
- action: added-repeatable-memory-matrix
- command_or_ref: docs/qa/2026-09-17-runtime-memory-optimization-matrix.md
- result_summary: recorded the current full baseline separately from pending 3-repetition lean/standard/full and VM-warm/app-hibernation A/B cells; no manual pass was asserted
- artifacts: [docs/qa/2026-09-17-runtime-memory-optimization-matrix.md]
- evidence_ids: [E-001, E-005]
- next: execute the disposable-instance matrix with operator-controlled login/browse confirmation

## 2026-09-17 | lead | app-hibernation-control
- action: added-safe-manual-app-hibernation
- command_or_ref: src-tauri/src/services/runtime_scheduler.rs; src-tauri/src/services/qemu.rs; src-tauri/src/commands/mod.rs; src/pages/tracks/QemuTrackPanel.tsx; docs/qa/2026-09-17-runtime-memory-optimization-matrix.md
- result_summary: added an explicit app-only hibernation action with package validation, exact QEMU mapping, idle/protected checks, structured result scope=app, and an existing-app start activity mark; VM/container remain warm
- artifacts: [src-tauri/src/services/runtime_scheduler.rs, src-tauri/src/services/qemu.rs, src-tauri/src/commands/mod.rs, src/pages/tracks/QemuTrackPanel.tsx, src/pages/QemuCenter.test.tsx]
- evidence_ids: [E-001, E-004, E-005]
- next: execute manual app-vs-container A/B and complete production authorization acceptance

## 2026-09-17 | lead | release-artifact-audit
- action: built-and-inspected-release-artifact
- command_or_ref: cargo build --manifest-path src-tauri/Cargo.toml --release; binary string scan
- result_summary: release desktop binary built successfully; qemu_guest.py script-body markers were absent, while runtime path/error strings remained as expected; current node1 was not touched
- artifacts: [src-tauri/target/release/redroid-device-center.exe, work/runtime-core-protection-20260917/evidence/E-004-validation.md]
- evidence_ids: [E-004]
- next: manual memory matrix and production authorization deployment/revocation acceptance remain outstanding

## 2026-09-17 | lead | scheduler-queue-correction
- action: replaced-discarded-queued-starts-with-backend-fifo-waiters
- command_or_ref: src-tauri/src/services/runtime_scheduler.rs; src-tauri/src/commands/mod.rs; cargo test runtime_scheduler::tests
- result_summary: queued start requests now remain owned by backend state, duplicate submissions are rejected, waiters have a bounded timeout, and the next request is promoted after success/failure with a fresh critical-pressure check
- artifacts: [src-tauri/src/services/runtime_scheduler.rs, src-tauri/src/commands/mod.rs, docs/superpowers/plans/2026-09-17-runtime-memory-optimization.md]
- evidence_ids: [E-004]
- next: rerun the full validation gate; manual runtime matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | authorization-code-audit
- action: fixed-registration-mutation-before-proof
- command_or_ref: authorization-service/src/routes.rs; authorization-service/src/store.rs; cargo test; scoped source audit
- result_summary: existing-client version changes and session revocation now occur only after a valid device signature; semgrep was unavailable, so the audit used scoped search, manual data-flow review, and a regression test
- artifacts: [authorization-service/src/routes.rs, authorization-service/src/store.rs, work/runtime-core-protection-20260917/evidence/E-006-authorization-code-audit.md]
- evidence_ids: [E-004, E-006]
- next: rerun the full validation gate; production TLS/identity/revocation drill and manual runtime matrix remain outstanding

## 2026-09-17 | lead | clone-and-protocol-guards
- action: added-live-clone-guard-and-authorization-protocol-integration
- command_or_ref: qemu-center/src/vm.rs; qemu-center/src/main.rs; authorization-service/tests/protocol.rs; work/runtime-core-protection-20260917/evidence/E-007-clone-safety.md; work/runtime-core-protection-20260917/evidence/E-008-protocol-integration.md
- result_summary: running or unknown QMP liveness now refuses VM cloning before qemu-img writes; authorization integration covers revoked-session chunk rejection and signing-key rotation response identity
- evidence_ids: [E-007, E-008]
- next: complete the disposable-instance memory matrix and production authorization deployment/revocation/offline/tamper rehearsal

## 2026-09-17 | lead | final-automated-validation
- action: reran-full-automated-gate
- command_or_ref: npx tsc --noEmit; npx vitest run; cargo test --manifest-path src-tauri/Cargo.toml; cargo test --manifest-path qemu-center/Cargo.toml; cargo test --manifest-path authorization-service/Cargo.toml; git diff --check
- result_summary: all automated checks passed; 453 frontend tests, 258 Tauri tests plus 1 ignored, 197 qemu-center library tests plus 5 CLI tests, and 14 authorization unit tests plus 2 integration tests
- evidence_ids: [E-004]
- next: manual runtime and production authorization acceptance remain outstanding; do not claim a fixed GB saving or absolute anti-reverse guarantee

## 2026-09-17 | lead | guest-bootstrap-permission-window
- action: fixed fresh-node Docker group-refresh race and elevated recovery provisioning
- command_or_ref: qemu-center/src/guest.rs; qemu-center/src/main.rs; work/runtime-core-protection-20260917/evidence/E-011-guest-bootstrap-permission-window.md
- result_summary: guest Docker operations now use `sudo -n docker`; a real 3072 MiB test node created `lean1`, reached boot_completed, and `guest provision` returned binderfs/docker OK
- evidence_ids: [E-011]
- next: complete the disposable-instance memory matrix and production authorization deployment/revocation/offline/tamper rehearsal

## 2026-09-17 | lead | validation-after-bootstrap-fix
- action: reran-full-automated-gate
- command_or_ref: work/runtime-core-protection-20260917/evidence/E-012-validation-after-bootstrap-fix.md
- result_summary: tsc, 453 frontend tests, 258 Tauri tests plus 1 ignored, 199 qemu-center library tests plus 5 CLI tests, 14 authorization unit tests plus 2 integration tests, formatting checks, and diff check passed; the disposable matrix3072 node was then gracefully stopped through QMP/ACPI and purged by exact name while node1 stayed running with unchanged assignments
- evidence_ids: [E-012]
- next: manual memory matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | delete-safety-and-key-cleanup
- action: guarded VM deletion by QMP liveness and removed orphan node keys during purge
- command_or_ref: qemu-center/src/vm.rs; qemu-center/src/main.rs; work/runtime-core-protection-20260917/evidence/E-013-delete-safety-and-key-cleanup.md
- result_summary: running/unknown delete states are rejected; exact VM/key artifact cleanup is covered by focused tests; the disposable test node's stale keys were removed without touching node1
- evidence_ids: [E-013]
- next: full project validation rerun is recorded in E-014; manual memory matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | final-validation-after-delete-guard
- action: reran-full-automated-gate
- command_or_ref: work/runtime-core-protection-20260917/evidence/E-014-final-validation-after-delete-guard.md
- result_summary: tsc, 453 frontend tests, 258 Tauri tests plus 1 ignored, 200 qemu-center library tests plus 6 CLI tests, 14 authorization unit tests plus 2 integration tests, formatting checks, and diff check passed
- evidence_ids: [E-014]
- next: manual memory matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | protected-core-lifecycle-fix
- action: fixed-temporary-core-leak-in-metadata-path
- command_or_ref: src-tauri/src/commands/mod.rs; docs/superpowers/plans/2026-09-17-server-authoritative-core-delivery.md; work/runtime-core-protection-20260917/evidence/E-009-core-cleanup.md
- result_summary: all four server-delivered core entry points now use worker-owned cleanup; focused TDD test passed after reproducing the missing cleanup type
- evidence_ids: [E-009]

---

- timestamp: 2026-09-17
- command_or_ref: src-tauri/src/commands/mod.rs; src-tauri/src/services/runtime_scheduler.rs; work/runtime-core-protection-20260917/evidence/E-010-unknown-pressure-start-guard.md
- result_summary: unknown resource pressure now permits one explicit start but blocks additional concurrent or queued starts; critical pressure remains blocked
- evidence_ids: [E-010]
- next: rerun the full project validation gate; manual runtime matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | guest-readiness-and-safe-purge
- action: waited-for-provisioning-readiness-and-proved-safe-disposable-purge
- command_or_ref: qemu-center/src/guest.rs; qemu-center/src/exec.rs; qemu-center/src/vm.rs; qemu-center/src/main.rs; work/runtime-core-protection-20260917/evidence/E-015-guest-readiness-and-safe-purge.md
- result_summary: guest wait now waits for cloud-init/binder/Docker readiness after SSH; Windows graceful-stop evidence records the QEMU PID and requires a dead PID plus a free QMP port when the normal probe is hidden by a local proxy; disposable matrix3072app was purged without touching node1
- evidence_ids: [E-015]
- next: finish release artifact scan and rerun the full project validation gate; manual runtime matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | final-validation-after-art-and-pid-fixes
- action: reran-final-project-gate-and-release-scans
- command_or_ref: work/runtime-core-protection-20260917/evidence/E-017-final-validation-after-art-and-pid-fixes.md
- result_summary: tsc, 453 frontend tests, 258 Tauri tests plus 1 ignored, 203 qemu-center library tests plus 6 CLI tests, 14 authorization unit tests plus 2 integration tests, both release builds, and release core-body scans passed; disposable node was purged safely and node1 remained running
- evidence_ids: [E-017]
- next: user manual acceptance remains for login/continuous browsing, complete memory matrix, app-hibernation A/B, production TLS/account/revocation/offline/tamper drills, and final visual walkthrough

## 2026-09-17 | lead | xhs-lean-art-observation
- action: measured-disposable-xhs-lean-cold-start-and-art-ab
- command_or_ref: adb -s 127.0.0.1:24532; qemu-center redroid stats matrix3072app leanbase --json; work/runtime-core-protection-20260917/evidence/E-016-xhs-lean-art-matrix.md
- result_summary: 3072 MiB/4 vCPU lean with a 1536 MiB container launched XHS without OOM; speed-profile P50 was 914 ms before and 932 ms after, so ART was not promoted to the default; login/browsing and long-run stability remain unverified
- evidence_ids: [E-016]
- next: finish release artifact scan and rerun the full project validation gate; manual runtime matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | art-command-correction
- action: corrected-android-13-art-verify-command
- command_or_ref: src-tauri/src/services/art.rs; adb shell cmd package help compile; focused cargo test
- result_summary: verify-only now emits `cmd package compile -m verify --check-prof true <package>`; the previous missing boolean and missing compilation mode were reproduced as Android shell failures, then fixed with a red/green command-construction test
- evidence_ids: [E-016]
- next: finish release artifact scan and rerun the full project validation gate; manual runtime matrix and production authorization acceptance remain outstanding

## 2026-09-17 | lead | lease-clock-hardening
- action: bound-client-lease-expiry-to-local-and-monotonic-time
- command_or_ref: src-tauri/src/services/authorization_client.rs; docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md; work/runtime-core-protection-20260917/evidence/E-018-lease-clock-hardening-validation.md
- result_summary: stale unsigned `serverTime` can no longer extend an expired signed lease; accepted sessions use a monotonic process clock, and all automated suites passed again
- evidence_ids: [E-018]
- next: manual memory matrix and production authorization/revocation/offline/tamper/key-rotation acceptance remain outstanding

## 2026-09-17 | lead | protected-download-session-handoff
- action: preserved-validated-session-for-artifact-download
- command_or_ref: src-tauri/src/services/authorization_client.rs; docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md; work/runtime-core-protection-20260917/evidence/E-019-protected-download-session-handoff.md
- result_summary: the actual artifact-download client now adopts the session returned by shared runtime authorization before requesting the manifest; focused regression passed
- evidence_ids: [E-019]
- next: rerun the full project validation gate; manual memory matrix and production authorization/revocation/offline/tamper/key-rotation acceptance remain outstanding

## 2026-09-17 | lead | final-validation-after-session-handoff
- action: reran-full-project-gate-and-release-build-after-session-fix
- command_or_ref: work/runtime-core-protection-20260917/evidence/E-020-final-validation-after-session-handoff.md
- result_summary: all frontend, Tauri, qemu-center, and authorization-service suites passed; release build and no-embedded-core scan remained clean
- evidence_ids: [E-020]
- next: manual memory matrix and production authorization/revocation/offline/tamper/key-rotation acceptance remain outstanding
