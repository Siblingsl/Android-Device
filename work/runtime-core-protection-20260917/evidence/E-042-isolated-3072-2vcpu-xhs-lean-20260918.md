# E-042 — Isolated 3072 MiB / 2 vCPU lean XHS sample

Date: 2026-09-18

## Scope

Measure a real local XHS APK on a disposable 3072 MiB / 2 vCPU WHPX node with
the `lean` profile and a 1536 MiB container limit. The existing `node1` and
its data volumes were not used or changed.

## Procedure and observations

- Created `matrix3072xhs` from the local Ubuntu image, started it through the
  supported VM commands, and waited for SSH/cloud-init/binder/Docker
  readiness.
- Created `lean2` with `redroid/redroid:13.0.0-latest`, one container CPU,
  1536 MiB memory, 720x1280 at 320 DPI, and no GApps/Magisk/modules.
- Installed the existing local `work/.../matrix-assets/xhs-base.apk` and used
  `com.xingin.xhs/.index.v2.IndexActivityV2` for cold-start sampling.
- Three `am force-stop` + `am start -W` samples:

  | sample | TotalTime | host available | QEMU working set | QEMU private | guest current | guest peak | OOM |
  |---:|---:|---:|---:|---:|---:|---:|---:|
  | 1 | 2082 ms | 1515.3 MiB | 3138.0 MiB | 3416.2 MiB | 1329.0 MiB | 1536.0 MiB | 0 |
  | 2 | 1089 ms | 1525.3 MiB | 3138.3 MiB | 3417.3 MiB | 1330.5 MiB | 1536.0 MiB | 0 |
  | 3 | 1101 ms | 1593.8 MiB | 3137.0 MiB | 3414.9 MiB | 1331.2 MiB | 1536.0 MiB | 0 |

- After force-stopping XHS and waiting 10 seconds, guest current was
  `1273.9 MiB`, while QEMU stayed at `3137.7 MiB` working set /
  `3415.8 MiB` private memory; OOM remained zero.
- The test node was stopped through QMP/ACPI and purged. A final list showed
  only `node1`; no temporary QEMU process, VM directory, or SSH key remained.

## Interpretation and boundary

This 2-vCPU lean sample confirms that the node's QEMU floor is about 3.14GB
and that the 1536 MiB lean cgroup limit is a tight XHS baseline: peak reached
the limit even though no OOM kill occurred. It is suitable for a low-footprint
comparison, not yet a recommended login/browsing profile. A 2048 MiB standard
sample should be the next candidate for business-flow acceptance.

Cold-start samples are not login, browsing, notification, or 30-minute
stability proof. No credentials were entered.
