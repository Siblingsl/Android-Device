# E-037 — Live app-pause memory sample

Date: 2026-09-18

## Scope

Measure the difference between pausing the target app and stopping the
redroid instance, without changing the existing node disk or container limit.

## Procedure and observations

- `node1` was started through `qemu-center vm start`; the existing node stayed
  at 4096 MiB. Guest readiness passed and `r1` remained stopped with its
  historical `Exited (137)` status.
- After boot settled, `r13` reported `2377.5 MiB` current, `2448.3 MiB` peak,
  and `oom_kills=0`.
- The installed XHS launcher was started without clearing data or changing
  configuration. The foreground activity was
  `com.xingin.xhs/com.xingin.login.activity.WelcomeActivity`. The guest then
  reported `3071.7 / 3072.0 MiB`, `oom_kills=0`, and `boot=yes`.
- At that same sample the QEMU process was approximately `3779.5 MiB`
  working set / `4448.7 MiB` private memory, while Windows reported about
  `565.4 MiB` free physical memory.
- `adb shell am force-stop com.xingin.xhs` was used as the app-pause proxy.
  Ten seconds later the guest current dropped to `2119.0 MiB` while peak
  remained `3072.0 MiB` and OOM kills remained zero. QEMU stayed approximately
  `3780.4 MiB` working set / `4442.4 MiB` private memory; host free memory was
  `509.2 MiB` in that sample.
- The instance was then stopped through the supported CLI and the node was
  stopped through QMP/ACPI. The recorded QEMU PID was no longer running.

## Interpretation

App pause releases roughly `953 MiB` of guest current memory in this sample,
but it does not immediately return the same amount to the Windows/QEMU working
set. Stopping the redroid instance is still the reliable host-memory release
operation. This supports keeping a VM warm only for short handoffs and using
explicit instance stop/release for longer idle periods.

This is a single live sample. It does not prove login, browsing, long-run
stability, or a fixed minimum memory requirement.
