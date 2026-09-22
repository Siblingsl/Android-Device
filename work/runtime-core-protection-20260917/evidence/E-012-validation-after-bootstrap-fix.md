# E-012 — Validation after guest bootstrap fix

Fresh post-fix validation on 2026-09-17:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 60 files / 453 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 258 passed / 1 ignored / 0 failed.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 199 library tests + 5 CLI tests passed / 0 failed.
- `cargo test --manifest-path authorization-service/Cargo.toml`: 14 unit + 2 integration tests passed / 0 failed.
- `cargo fmt` checks and `git diff --check`: passed; only existing LF/CRLF normalization warnings were reported.
