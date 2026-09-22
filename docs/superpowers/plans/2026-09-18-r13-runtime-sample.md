# r13 runtime memory sample plan

**Goal:** Capture a fresh, read-only runtime sample of the existing 4096 MiB
node and compare foreground XHS pressure with an app-only force-stop. This is
evidence for the memory recommendation, not a login/browse acceptance.

- [x] Start the existing node through the CLI host-memory guard and wait for
  guest provisioning readiness.
- [x] Start only the existing `r13` container; do not change node memory or
  delete data.
- [x] Capture guest cgroup current/peak/OOM, QEMU working/private memory, and
  host available memory before/after foregrounding XHS and after force-stop.
- [x] Stop the container and node through the normal stop path; confirm QEMU
  exits and no live process remains.
- [x] Record the result as evidence and keep login/continuous browsing marked
  as manual pending.
