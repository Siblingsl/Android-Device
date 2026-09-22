# E-016 — XHS lean-instance and ART comparison

## Scope

Read-only target APK was pulled from the existing `node1` `r13` instance and
installed into a disposable `matrix3072app` instance. The test instance used
3072 MiB / 4 vCPU / WHPX, the `lean` profile, a 1536 MiB container limit, no
optional GApps/Magisk preload, and `redroid/redroid:13.0.0-latest`.

The APK was used only as a local test asset under `work/`; it was not added to
the release artifact or the server core-delivery path.

## Measurements

| phase | cold-launch `TotalTime` samples | P50 | post-launch container current | OOM |
|---|---:|---:|---:|---:|
| before speed-profile | 909 / 957 / 914 ms | 914 ms | 1378.7 / 1381.0 / 1385.6 MiB | 0 |
| after speed-profile | 1219 / 917 / 932 ms | 932 ms | 1118.3 / 1122.8 / 1125.2 MiB | 0 |

`speed-profile` compilation completed successfully; observed compile time was
about 14.7 s on the first run and 19.1 s on the repeat. The corrected
verify-only command is `cmd package compile -m verify --check-prof true
com.xingin.xhs` and returned success. The prior command without the boolean
argument was rejected by Android 13 and is now fixed in `src-tauri`.

The samples do not prove a speed improvement: the median moved from 914 ms to
932 ms, and the first-launch/cache state is a meaningful confounder. The lower
post-phase memory samples are also not a controlled memory reduction result.
The container stayed below its 1536 MiB cap and recorded no OOM kill.

`cmd package compile --reset` was rejected for the ordinary ADB shell with an
Android `SecurityException`; reset therefore remains an explicit privileged
operator action, not a silently assumed part of the experiment.

## Boundary

No credentials were available, so login, continuous browsing, 30-minute
stability, notification/background behavior, and the full 3072/4096 ×
lean/standard/full matrix remain manual acceptance items.
