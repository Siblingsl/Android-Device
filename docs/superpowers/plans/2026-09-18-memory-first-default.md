# Memory-first QEMU lifecycle default

## Goal

Make new or partially migrated installations release the QEMU VM after an idle
instance is reclaimed by default. This matches the measured behavior that
stopping only the redroid container does not materially release the QEMU host
memory reservation, while preserving an explicit user choice to keep the VM
warm for faster reopening.

## Scope

- Change only the default for missing/implicit `runtimeKeepVmWarm` values.
- Preserve an explicitly stored `true` or `false` setting.
- Keep the existing fresh-list safety proof before stopping a shared VM.
- Update the web-preview fallback and the visible setting hint.
- Add regression tests for Rust defaults and legacy JSON deserialization.

## Steps

- [x] Add failing tests for memory-first defaults and explicit-value preservation.
- [x] Change the minimal defaults and UI fallback.
- [x] Update copy and handoff evidence.
- [x] Run focused tests, then all mandatory gates.

## Non-goals

- Do not change the existing user's explicit lifecycle preference.
- Do not change the full/standard/lean memory budgets.
- Do not stop a running VM without the existing fresh read-only instance-list proof.
