# Critical-pressure guest balloon reclaim

## Goal

Use the already verified virtio-balloon path as the first response when a QEMU
runtime start sees critical host memory pressure. If the guest cannot provide
complete metrics, the node is stopped, or the reclaim does not resolve the
pressure, preserve the existing idle-instance release and fail-closed guards.

## Scope and safety

- Trigger only inside the existing explicit QEMU runtime-start critical path;
  no timer or periodic background polling is added.
- Reuse `qemu-center vm memory-reclaim`; do not duplicate target calculations
  in Tauri and do not touch qcow2 or kill QEMU.
- Respect the existing `runtime_auto_release_idle_on_critical` opt-in. When it
  is false, keep the current behavior and do not issue an automatic balloon.
- Refresh host pressure after a successful CLI result. Only if pressure remains
  critical may the existing one-idle-instance release run.
- Unknown pressure, missing metrics, stopped/unknown nodes, and CLI failures
  remain fail-closed and fall through to the existing behavior.

## Acceptance

1. A critical QEMU start attempts at most one guest reclaim before idle release.
2. A successful reclaim that brings pressure below critical proceeds without
   stopping an idle instance.
3. A failed/no-op reclaim preserves the current idle-release path.
4. The setting disabled path makes no qemu-center reclaim call.
5. Rust tests and all repository gates pass.

## Implementation status

- [x] Added a pure decision test for the existing critical-pressure start path.
- [x] Reused `qemu-center vm memory-reclaim` for at most one fail-closed
  reclaim attempt before the existing idle-release fallback.
- [x] Preserved the existing opt-in setting, concurrent-start guard, pressure
  refresh, and no-op/failure fallback behavior.
- [x] Re-run the full repository gates after the final documentation and source
  cleanup: TypeScript passed; Vitest passed with 61 files / 464 tests; Tauri
  passed with 301 tests / 0 failures / 2 ignored; qemu-center passed with
  224 library tests + 21 CLI tests; both Rust format checks and `git diff
  --check` passed.
