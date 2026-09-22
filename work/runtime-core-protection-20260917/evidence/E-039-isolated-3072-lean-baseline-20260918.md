# E-039 — Isolated 3072 MiB lean baseline

Date: 2026-09-18

## Scope

Measure the memory floor of a fresh isolated 3072 MiB WHPX node with one
`lean` Redroid instance, without modifying the existing `node1` disk or
runtime state.

## Procedure and observations

- Created a temporary `matrix3072` node from the existing local Ubuntu cloud
  image, with `2 vCPU`, `3072 MiB` guest memory, and distinct SSH/QMP/ADB
  ports. The node passed guest SSH and provisioning readiness.
- Created `lean1` with `--profile lean --memory 1536 --cpus 1` using the local
  `redroid/redroid:14.0.0-latest` image. The container reached
  `boot_completed=yes` with `oom_kills=0`.
- Initial read-only sample: guest current `1223.0 MiB`, guest peak
  `1259.0 MiB`; QEMU working set `3134.9 MiB`, private memory `3245.5 MiB`;
  Windows available physical memory `2107.1 MiB`.
- Three samples over approximately 25 seconds were stable:

  | sample | host available | QEMU working set | QEMU private | guest current | guest peak | OOM kills |
  |---:|---:|---:|---:|---:|---:|---:|
  | 1 | 2153.0 MiB | 3135.2 MiB | 3245.4 MiB | 1207.4 MiB | 1259.0 MiB | 0 |
  | 2 | 2141.9 MiB | 3135.1 MiB | 3245.5 MiB | 1206.8 MiB | 1259.0 MiB | 0 |
  | 3 | 2149.2 MiB | 3135.3 MiB | 3245.5 MiB | 1206.7 MiB | 1259.0 MiB | 0 |

- Stopped the temporary node through `qemu-center vm stop` (QMP/ACPI), waited
  for the QEMU process to exit, then used `vm delete --purge`. A final list
  showed only `node1`; no temporary process, VM directory, or key remained.

## Interpretation

The isolated 3 GiB baseline confirms that the QEMU/Android node itself is the
dominant host-memory floor: the QEMU working set stayed close to the configured
guest size, while the lean container was about `1.21 GiB` after boot. Lowering
the container limit alone cannot remove the QEMU floor and may cause OOM.
Keeping a VM warm therefore trades roughly the node's resident memory for
faster next-start latency; memory-first operation must release the instance
and, when appropriate, the VM.

This is an infrastructure baseline only. No XHS APK, login, browsing, or
long-running workload was exercised, so it does not establish an application
minimum or a production concurrency limit.
