# E-073 — Current live-validation boundary (2026-09-20)

## Purpose

Record the current external state before the next manual Tauri/QEMU walkthrough.
This evidence is diagnostic only; it does not mark the real-device acceptance
items complete.

## Observed state

- Computer-use discovery returned no controllable Windows application windows;
  only the Codex in-app browser surface was present. Therefore the Tauri
  walkthrough cannot be truthfully automated in this environment.
- `qemu-center doctor --json --state-dir qemu-center\state` returned **8 ok / 0
  fail / 0 unknown**.
- `vm list` showed only the existing `node1` (WHPX, 4 vCPU, 4096 MiB); no
  experimental node was created.
- The host had about **2.20 GiB** free physical memory at the time of the
  check. A 4096 MiB node is therefore intentionally not started from this
  turn; the existing start guard should fail closed rather than add another
  QEMU process under critical host pressure.

## Boundary

Still pending human confirmation:

1. Real Tauri C/D/E walkthrough with Docker Desktop and node1 running.
2. Lean/standard/full login, continuous browsing, and 30-minute memory matrix.
3. Production HTTPS/account deployment, cross-device copy, offline, tamper,
   replay, revocation, and signing-key rotation rehearsal.

No fixed host-memory saving or absolute anti-reverse guarantee is inferred from
this diagnostic snapshot.
