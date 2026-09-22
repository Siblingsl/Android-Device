# E-021 — Critical-pressure reclaim and lean profile floor

This evidence records the follow-up implementation that closes the gap between
the existing manual idle-release command and the runtime start guard.

## Implemented behavior

- When host pressure is `critical`, the start path can first select one
  reclaimable instance on the target VM.
- The candidate must be recorded idle beyond the configured timeout, must not
  be protected, must be present in the fresh basic QEMU list, and must have a
  Docker status proving `Up …` or `running`.
- The target instance, protected instances, exited instances, unknown-status
  instances, and a concurrent reclaim are skipped.
- Only the container is stopped. The node remains running, no data volume is
  deleted, and pressure is read again before the target start continues.
- A failed stop or a still-critical re-probe returns the existing `Blocked`
  decision. The setting defaults to enabled for old settings files and is
  exposed as an explicit advanced-setting opt-out.

The pressure path uses `redroid_list_basic`, not the metadata-enriched list, so
it does not download or execute the protected guest core merely to classify a
container status.

## Profile correction

The TypeScript and qemu-center profile ladders now agree: on nodes with at
least 3072 MiB, lean offers a 1536 MiB starting ceiling, matching the isolated
XHS baseline. Smaller nodes keep a 1024 MiB fallback. This remains a starting
default, not a stability guarantee.

## Automated evidence

- `npx vitest run`: 60 files / 455 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 267 passed / 1 ignored.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 206 library + 6 CLI
  tests passed.
- `cargo test --manifest-path authorization-service/Cargo.toml`: 14 unit + 2
  integration tests passed.
- `cargo build --manifest-path src-tauri/Cargo.toml --release` and
  `cargo build --manifest-path qemu-center/Cargo.toml --release`: passed;
  the release core-body scan found no embedded runner markers.
- Focused tests cover candidate exclusion, reclaim-slot serialization, old
  policy deserialization, Docker status classification, settings opt-out, and
  3 GiB lean profile defaults.

## Read-only live-state check

- Existing `node1` remained at 4096 MiB / 4 vCPU with `r1 -> 24500` and
  `r13 -> 24501`; its QEMU process was still present with an observed working
  set of approximately 832 MiB.
- No `matrix3072app` VM directory or private key was present in the registry
  state after the disposable-node work.
- This check performed no stop, restart, disk, snapshot, or state mutation.

## Manual boundary

No live `node1` instance was stopped for this evidence. A human must exercise
the behavior on a disposable node with one genuinely idle instance, verify the
container stop and target restart, then repeat with a protected/active/unknown
candidate. Login, browsing, and the full memory matrix remain separate manual
acceptance items.
