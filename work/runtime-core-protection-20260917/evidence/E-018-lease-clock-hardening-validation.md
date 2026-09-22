# E-018 — Lease clock hardening validation

The Tauri authorization client now validates a newly received lease using the
later of local wall time and the response's `serverTime`. Once accepted, the
session tracks expiry from a monotonic process clock. This prevents a stale
unsigned response time or an in-process wall-clock rollback from extending the
client-side lease window. A process restart still requires a new lease.

TDD evidence:

- The stale-server-time regression test was added before the implementation;
  it failed because the lease clock type did not exist, then passed after the
  client was wired to the local/monotonic timing policy.
- The monotonic-clock test verifies that elapsed time advances the lease anchor
  and that sampling the same monotonic instant does not advance it.

Fresh automated validation:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 60 files / 453 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 260 passed / 1 ignored /
  0 failed.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 203 library tests + 6
  CLI tests passed / 0 failed.
- `cargo test --manifest-path authorization-service/Cargo.toml`: 14 unit + 2
  integration tests passed / 0 failed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo build --manifest-path src-tauri/Cargo.toml --release`: passed.
- Release binaries still contain no QEMU guest core body markers; only the
  expected fail-closed `qemu_guest.py` path/error strings remain.

This evidence does not replace production TLS, account, revocation, offline,
tamper, key-rotation, login/browsing, or full memory-matrix acceptance.
