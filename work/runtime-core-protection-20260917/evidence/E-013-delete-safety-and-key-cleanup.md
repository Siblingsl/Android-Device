# E-013 — Delete safety and key cleanup

## Finding

`vm delete --purge` previously removed the VM directory but left the node's
SSH private/public key files under `state/keys`. It also had no QMP liveness
guard, so a live node could theoretically be forgotten or have its directory
purged while QEMU still owned the disk.

## Fix

- `vm delete` now probes QMP before any registry or filesystem mutation.
- Running or unknown QMP state is rejected; only a proven stopped node can be
  forgotten or purged.
- `--purge` removes the exact VM directory plus the exact private/public key
  paths; missing files remain harmless.

## Verification

- Pure safety test: stopped is accepted, running and unknown are rejected.
- Filesystem test: a disposable node directory and both key files are removed,
  with no broad path traversal.
- The `matrix3072` test node was already stopped through QMP/ACPI before its
  directory was removed. Its three leftover test-only key files were then
  explicitly removed by exact path; `node1` remained running and unchanged.
