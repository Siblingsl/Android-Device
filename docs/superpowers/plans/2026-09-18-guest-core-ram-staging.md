# Guest-side protected core RAM staging

**Goal:** keep the server-delivered runner out of the guest's persistent home
volume while it is being uploaded and executed.

## Tasks

- [x] Add a failing renderer test requiring the managed `/run/rdc-presets`
  directory in both first-boot and recovery provisioning.
- [x] Add the smallest provisioning command and make protected preset uploads
  use `/run/rdc-presets/<job>` instead of `/home/rdc/.cache/rdc-presets/<job>`.
- [x] Ensure every upload path creates the directory with `rdc` ownership and
  mode `0700` before SCP, so existing nodes do not need to be recreated.
- [x] Keep existing per-operation cleanup and document that `/run` reduces
  persistent-disk residue but does not defeat a live guest root/debugger.
- [x] Run all required tests, release scan, and record evidence.

## Boundary

The runner still exists as plaintext briefly in the guest RAM filesystem because
Docker must execute it. Device-bound execution grants and server-side execution
of high-value algorithms remain mandatory.
