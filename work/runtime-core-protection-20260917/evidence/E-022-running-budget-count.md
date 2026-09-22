# E-022 — Running-container budget count

## Problem

The redroid create budget previously used the number of registered ADB
assignments as `running_instances`. An exited container retained its
assignment and data volume, so it could continue consuming the memory budget
even after an idle release.

## Change

The guest-side create path now performs a read-only `docker ps -a` query and
counts unique `qc-*` rows whose status is explicitly `Up` or `running`. Exited
and explicit unknown rows do not count as runtime competitors. If the guest
query fails or a `qc-*` row has no status, the path falls back to the full
registered-assignment count; it never treats an incomplete observation as
proof that a container is stopped.

The new instance is still added to the requested count, and the existing
headroom calculation is unchanged.

## Current read-only observation

On `node1`, the existing CLI observation returned:

- `r1`: `Exited (137)`
- `r13`: `Up 11 hours`
- `r13` current: about 2.93 GiB of a 3 GiB container limit, peak about 3 GiB,
  OOM kill count 0

This means a fresh budget calculation can charge one confirmed-running
instance instead of two registered assignments, while preserving the stopped
instance's registration and data volume.

## Verification

- TDD parser test first failed because the parser did not exist, then passed
  after implementation.
- Focused tests cover exited/unknown exclusion and incomplete-row rejection.
- TDD profile-resolution test first failed because the resolver did not exist,
  then passed after the CLI began treating CPU/memory as optional overrides.
  `--profile lean`, `--profile standard`, and `--profile full` now use their
  node-derived defaults when overrides are omitted; explicit overrides remain
  authoritative.
- `cargo test --manifest-path qemu-center/Cargo.toml`: 207 library + 6 CLI
  tests passed.
- No container was created, stopped, deleted, or modified for this evidence.
