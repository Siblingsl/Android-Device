# E-077 — Protected create grant count (2026-09-20)

## Root cause

The protected Tauri QEMU create command requested three execution grants, but
the create preset workflow consumes four distinct single-use stages:

1. `build`
2. `seed`
3. `authorize` (guest online authorization)
4. `activate` (host Docker creation and protected runner activation)

The mismatch could allow authorization/download to succeed and then leave the
create flow without the grant required by its final activation stage. Upgrade
continues to consume two stages (`build` and `upgrade`).

## Change

`src-tauri/src/commands/mod.rs` now defines named stage-count constants and
passes `QEMU_CREATE_EXECUTION_STAGE_COUNT == 4` to the create authorization
client. The upgrade path uses the separate
`QEMU_UPGRADE_EXECUTION_STAGE_COUNT == 2` constant. Grant ordering, per-stage
JTI semantics, host receipt verification, and guest online authorization were
not weakened or combined.

## TDD and verification

- RED: the focused regression test failed to compile because the stage-count
  constants did not exist.
- GREEN: `protected_create_requests_all_four_execution_stages` passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `npx tsc --noEmit`: passed.
- `npx vitest run`: 61 files / 464 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 302 passed / 0 failed /
  2 ignored.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 224 library tests + 21
  CLI tests passed.
- `git diff --check`: passed; only existing LF/CRLF normalization warnings
  were reported.

The full Tauri run initially observed one Windows local-PTY startup failure
while the TypeScript and Vitest gates were running in parallel. The focused
PTY test and a fresh serial Tauri run both passed, so no unrelated terminal
change was made.

## Boundary

This proves the client-side stage-count contract and keeps all protected
operations fail-closed around the existing server grants. It does not claim
production TLS/secret deployment, cross-device copy resistance, offline,
tamper, or replay drills, nor live guest plaintext protection from a
guest-root/host-admin debugger. Those remain in the runtime authorization
acceptance item and P7-1 manual walkthrough.
