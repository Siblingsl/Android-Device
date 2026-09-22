# Guest readiness after provisioning/clone

## Problem

`guest wait` currently requires `cloud-init status: done`. The provisioning
flow may disable cloud-init after first boot, and a stopped-node CoW clone then
reports `status: disabled` even though SSH, binder, and Docker are ready. This
blocks real memory/balloon measurements without indicating a guest failure.

## Scope

- Keep `guest wait` fail-closed on the two operational prerequisites that the
  CLI actually needs: binder is mounted/registered and Docker responds through
  non-interactive sudo.
- Do not write to the guest, re-enable cloud-init, or change VM lifecycle.
- Keep the readiness report and verify checks unchanged; they already expose
  binder/Docker state separately.
- Add a pure command-contract test for the new readiness probe.

## Acceptance

1. A guest with `cloud-init status: disabled`, binder present, and Docker
   responding satisfies the bootstrap-ready probe.
2. Missing binder or Docker still fails the probe.
3. Existing qemu-center tests and full repository gates remain green except
   the already-recorded unrelated Windows PTY test.
4. Re-run `guest wait` on the isolated node2 clone before collecting balloon
   and redroid metrics; stop node2 gracefully after evidence collection.
