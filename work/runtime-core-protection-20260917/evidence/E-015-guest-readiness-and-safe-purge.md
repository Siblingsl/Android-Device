# E-015 — Guest readiness and safe disposable-node purge

## Fresh-node readiness

- Disposable node: `matrix3072app`, 3072 MiB / 4 vCPU / WHPX.
- Before the readiness fix, `guest wait` stopped after SSH became reachable;
  the immediate `redroid create` then failed because Docker was not yet
  available while cloud-init was still running.
- The fix keeps the SSH probe, then waits for all three conditions: cloud-init
  `status: done`, `binder` in `/proc/filesystems`, and a successful
  `sudo -n docker version` probe.
- TDD covered the generated readiness probe. A real post-fix run returned:
  `guest SSH reachable after 1 attempt(s).` followed by
  `guest provisioning ready after 1 readiness attempt(s).`

## Safe purge

The first stopped-node delete attempt was correctly fail-closed but reported
QMP state `unknown` because the local Windows network stack did not expose the
closed-port refusal. The delete path now has an independent proof for this
case: a PID recorded at `vm start` must be gone and the QMP port must be
bindable again. A live PID, missing PID evidence, or a busy port still rejects
the delete.

Live verification on the disposable node:

- New CLI start recorded QEMU PID `27920`.
- Shutdown used QMP ACPI and guest `systemctl poweroff`; no forced process
  termination was used.
- PID `27920` exited and port `23301` had no listener.
- `vm delete --purge` removed the exact VM directory and the exact private /
  public SSH key paths.
- Final registry contained only `node1`; `node1` remained running at 4096 MiB
  with `r1`/`r13` unchanged.

The new pure safety test and Windows `tasklist` PID parser test pass.
