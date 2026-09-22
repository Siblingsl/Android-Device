# E-017 — Final validation after ART, guest-wait, and safe-purge fixes

Fresh validation on 2026-09-17 after the final source changes:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 60 files / 453 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 258 passed / 1 ignored /
  0 failed.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 203 library tests + 6
  CLI tests passed / 0 failed.
- `cargo test --manifest-path authorization-service/Cargo.toml`: 14 unit + 2
  integration tests passed / 0 failed.
- `git diff --check`: passed; only existing LF/CRLF normalization warnings
  were reported.
- `cargo build --manifest-path qemu-center/Cargo.toml --release`: passed.
- `cargo build --manifest-path src-tauri/Cargo.toml --release`: passed.

Release binary scans found no embedded QEMU guest core body markers, including
the Python runner body and shebang. The expected `qemu_guest.py` path/error
string remains, so an unconfigured release still fails closed rather than
silently falling back to a local core.

The disposable `matrix3072app` node was stopped gracefully and purged. Its VM
directory and SSH keys are absent; `node1` is still registered and running
with its original 4096 MiB setting and `r1`/`r13` assignments.
