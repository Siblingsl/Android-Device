# E-011 — Guest bootstrap permission window

## Scope

Validate that a fresh QEMU node remains usable during the interval where SSH is
already reachable but cloud-init has not refreshed the `rdc` user's Docker group.
Also validate the documented recovery command's privilege boundary.

## Reproduction

- Test node: `matrix3072`, 3072 MiB / 4 vCPU / WHPX, separate qcow2 overlay.
- The first `redroid create` attempt after `guest wait` failed with Docker
  socket permission denied while `rdc` was not yet in the `docker` group.
- Read-only SSH inspection showed Docker active, `sudo -n docker version` =
  `29.1.3`, and cloud-init still running; the failure was the login group's
  refresh timing, not a missing daemon.

## Fix and evidence

- Added a single guest command prefix: `sudo -n docker`.
- Applied it to create, lifecycle, list, stats, readiness, and verify probes.
- Wrapped `guest provision`'s recovery body in `sudo -n bash -s` so apt,
  binder module loading, systemd drop-ins, and group repair actually run as root.
- TDD red: the new command-shape test failed because `docker_command` did not
  exist; green: the focused test and full qemu-center suite pass.
- Real retry: `redroid create matrix3072 lean1 --profile lean --memory 1536`
  succeeded after the fix.
- Real recovery: `guest provision matrix3072` returned
  `QC_PROVISION_DONE`, `binderfs=Ok`, and `docker=Ok`.

## Measurement boundary

The lean container reached `boot_completed=true` with:

- `memory_limit_bytes=1610612736`
- `memory_current_bytes=1514569728`
- `memory_peak_bytes=1610612736`
- `oom_kills=0`
- `cpu_usage_percent=0.76`

This is a base redroid runtime sample; the target app was not installed on the
test node, so it is not a Xiaohongshu login/browsing result and does not close
the three-repeat memory matrix.

After collecting the evidence, `matrix3072` was stopped through QMP/ACPI and
purged by its exact VM name. `node1` remained running at 4096 MiB with its
existing `r1`/`r13` assignments; the host's free memory recovered to about
5576 MiB in the follow-up sample.
