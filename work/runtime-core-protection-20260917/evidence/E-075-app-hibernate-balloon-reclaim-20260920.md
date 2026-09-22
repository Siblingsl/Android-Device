# E-075 — App hibernate triggers one safe guest reclaim attempt (2026-09-20)

## Implementation

After a validated Android `force-stop` succeeds, the Tauri runtime command now
calls the existing `qemu-center vm memory-reclaim` path once. qemu-center still
owns liveness, cgroup metrics, the reclaim floor, target calculation, and QMP
`actual` verification. A failed reclaim leaves the successful app hibernation
result intact and reports the existing `idle_app` reason; a successful reclaim
uses `idle_app_reclaimed` for diagnostics.

The path is not used when package validation, QEMU mapping, or `force-stop`
fails. The UI keeps its existing behavior and refreshes the resource snapshot
after a successful app pause.

## Tests

- TDD RED: the focused test failed because the policy helper was absent.
- TDD GREEN: `app_hibernate_reclaims_only_after_force_stop_succeeds` passed.
- Full project gate:
  - `npx tsc --noEmit`: passed
  - `npx vitest run`: 61 files / 464 tests passed
  - `cargo test --manifest-path src-tauri/Cargo.toml`: 303 passed / 2 ignored
  - `cargo test --manifest-path qemu-center/Cargo.toml`: 224 library + 21 CLI passed

## Boundary

This proves the safe call chain and failure behavior only. It does not prove a
fixed host working-set reduction; that requires a running WHPX node, before and
after process snapshots, and manual login/browsing stability confirmation.
