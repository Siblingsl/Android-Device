# E-020 — Final validation after protected-download session handoff

Fresh validation after the protected artifact download client was fixed to
adopt the shared, already-verified authorization session:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 60 files / 453 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 262 passed / 1 ignored /
  0 failed.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 203 library tests + 6
  CLI tests passed / 0 failed.
- `cargo test --manifest-path authorization-service/Cargo.toml`: 14 unit + 2
  integration tests passed / 0 failed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo build --manifest-path src-tauri/Cargo.toml --release`: passed.
- `git diff --check`: passed; only existing LF/CRLF normalization warnings
  were reported.

The release binaries contain no QEMU guest core body markers. The expected
fail-closed `qemu_guest.py` path/error strings remain. No live `node1` state or
qcow2 disk was modified by this validation. The final read-only check found
`node1` registered at 4096 MiB / 4 vCPU with `r1=24500` and `r13=24501`; the
disposable `matrix3072app` VM directory and key are absent.

Manual production authorization, tamper/copy, key-rotation, login/browsing,
and complete memory-matrix acceptance remain outstanding.
