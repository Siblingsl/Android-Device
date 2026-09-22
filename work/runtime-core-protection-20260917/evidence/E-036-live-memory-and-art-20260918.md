# E-036 — Live full-instance memory and ART comparison

Date: 2026-09-18

## Scope

Measurement of the existing `node1/r13` full instance after a safe QMP/CLI
start, including normal app foreground/force-stop operations and an explicit
ART `speed-profile` compile. No qcow2 resize, package removal, data wipe, or
container limit change was performed.

## Environment

- Node: `node1`, QEMU `-m 4096 -smp 4`, WHPX.
- Instance: `r13`, Android 13, full profile, `qc-r13`.
- Container limit: `3221225472` bytes (3 GiB).
- Target app: `com.xingin.xhs`.
- Guest readiness: `guest wait` reported SSH reachable and provisioning ready.

## Measurements

Immediately after the safe node start, with `r13` booted and before launching
the target app, three samples five seconds apart reported approximately:

| sample | host available | QEMU working set | QEMU private | guest current | guest peak | OOM |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1.10 GiB | 3.26 GiB | 4.25 GiB | 2.32 GiB | 2.36 GiB | 0 |
| 2 | 1.15 GiB | 3.27 GiB | 4.25 GiB | 2.32 GiB | 2.36 GiB | 0 |
| 3 | 1.13 GiB | 3.27 GiB | 4.25 GiB | 2.32 GiB | 2.36 GiB | 0 |

After bringing the installed XHS Activity to the foreground, three further
samples reported:

| sample | host available | QEMU working set | QEMU private | guest current | guest peak | XHS PSS | OOM |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.45 GiB | 3.47 GiB | 4.26 GiB | 3.00 GiB | 3.00 GiB | 671243 KiB | 0 |
| 2 | 0.53 GiB | 3.46 GiB | 4.26 GiB | 2.84 GiB | 3.00 GiB | 533339 KiB | 0 |
| 3 | 0.54 GiB | 3.46 GiB | 4.30 GiB | 3.00 GiB | 3.00 GiB | 509629 KiB | 0 |

The app reached `DeviceOfflineRemindActivity`; this is an app-state result,
not evidence of successful login or continuous browsing. The samples show
that the host pressure is dominated by the full guest/QEMU combination, while
XHS itself is a substantial but smaller part of the guest footprint.

## ART comparison

Three cold starts used `am force-stop` followed by
`am start -W -n com.xingin.xhs/.index.v2.IndexActivityV2`:

- Before: `2416 ms`, `2142 ms`, `1284 ms` (P50 `2142 ms`).
- After `cmd package compile -m speed-profile -f com.xingin.xhs`: `1710 ms`,
  `1143 ms`, `1544 ms` (P50 `1544 ms`).
- `dumpsys package dexopt` reported `x86_64: [status=speed-profile]
  [reason=cmdline]` for XHS.

This sample suggests a roughly 28% P50 cold-start improvement on this existing
full instance, but it is not a proof of login/browsing stability and does not
materially reduce the guest memory limit. It should be repeated on an isolated
lean/standard copy before becoming a default policy.

## Decision

The current evidence supports keeping ART optimization as an explicit,
measured action and prioritizing lean/standard profiles or app-level hibernation
for memory reduction. Lowering the existing 3 GiB cgroup limit in place is not
justified by this run.
