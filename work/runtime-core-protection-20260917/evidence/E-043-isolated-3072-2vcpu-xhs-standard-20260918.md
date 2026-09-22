# E-043 — Isolated 3072 MiB / 2 vCPU standard XHS sample

Date: 2026-09-18

## Scope

Compare the same disposable 3072 MiB / 2 vCPU WHPX setup and local XHS APK
with the `standard` profile and a 2048 MiB container limit.

## Measurements

- The first APK install attempt happened before Android StorageManager had
  finished initializing and returned a framework `NullPointerException`; after
  `sys.boot_completed=1` and framework readiness, the same install succeeded.
  This is recorded as a setup timing issue, not an OOM result.
- Three cold starts of `com.xingin.xhs/.index.v2.IndexActivityV2`:

  | sample | TotalTime | host available | QEMU working set | QEMU private | guest current | guest peak | OOM |
  |---:|---:|---:|---:|---:|---:|---:|---:|
  | 1 | 1839 ms | 1901.9 MiB | 3134.4 MiB | 3269.4 MiB | 1746.8 MiB | 2031.4 MiB | 0 |
  | 2 | 970 ms | 1895.0 MiB | 3134.7 MiB | 3271.0 MiB | 1748.2 MiB | 2031.4 MiB | 0 |
  | 3 | 1060 ms | 1856.8 MiB | 3134.9 MiB | 3271.2 MiB | 1750.4 MiB | 2031.4 MiB | 0 |

- After force-stopping XHS and waiting 10 seconds, guest current was
  `1681.5 MiB`; QEMU remained at `3134.6 MiB` working set /
  `3270.5 MiB` private memory; OOM remained zero.
- The disposable node was stopped through QMP/ACPI and purged. The final VM
  list contained only `node1`; no temporary process, disk, or key remained.

## Interpretation and boundary

The standard 2048 MiB limit provided about `0.5 GiB` more guest headroom than
the 1536 MiB lean sample without changing the approximately 3.13GB QEMU floor.
For a 3072 MiB node, standard/2048 is the current measured candidate for an
XHS business-flow trial; it still lacks login, continuous browsing, and
30-minute stability acceptance.
