# E-076 — App route code-splitting (2026-09-20)

## Scope

The desktop shell previously loaded every top-level page statically. This
change keeps the router/layout/i18n shell synchronous and loads page modules
through React `lazy` + `Suspense fallback={null}`. It does not change Tauri
commands, Docker/QEMU behavior, runtime authorization, or the existing nested
Docker/QEMU panel lifecycle.

## Build comparison

Previous measured output after the first RuntimePage panel split (E-070):

```text
dist/assets/index-BauctRhW.js  944.01 kB │ gzip: 269.77 kB
```

Fresh output after app route splitting:

```text
dist/assets/index-D2FHoQsk.js                   485.19 kB │ gzip: 146.30 kB
dist/assets/react-CeeGGrc-.js                    49.83 kB │ gzip:  17.70 kB
dist/assets/DeviceDetail-DtxQjgfb.js            199.16 kB │ gzip: 52.94 kB
dist/assets/Devices-DkyrBME0.js                  71.99 kB │ gzip: 18.65 kB
dist/assets/Settings-B7-EZhLD.js                 45.36 kB │ gzip: 13.15 kB
dist/assets/Adb-DLrNOV6y.js                      43.34 kB │ gzip: 15.40 kB
dist/assets/DockerTrackPanel-DCQqWGUz.js         45.37 kB │ gzip: 11.84 kB
dist/assets/QemuTrackPanel-CcDuDc9l.js           41.25 kB │ gzip: 10.88 kB
dist/assets/RuntimePage-D-j0Gueh.js              21.19 kB │ gzip:  6.85 kB
dist/assets/MonitorAlerts-ClSHXfL3.js            14.73 kB │ gzip:  3.92 kB
dist/assets/Dashboard-tpdGcl0s.js                 8.09 kB │ gzip:  2.59 kB
dist/assets/Volumes-BO1M8QL1.js                   7.24 kB │ gzip:  2.51 kB
dist/assets/Logs-DGBiq-3S.js                      7.03 kB │ gzip:  2.65 kB
dist/assets/Apk-V5QbLRSs.js                       6.36 kB │ gzip:  2.53 kB
dist/assets/Terminal-DrIX1Ivi.js                  4.23 kB │ gzip:  1.74 kB
dist/assets/DeviceWindow-f63TCw2i.js              2.37 kB │ gzip:  1.33 kB
```

The initial JavaScript index is reduced by 458.82 kB (48.6%) and is below the
600 kB warning threshold. The heavier device/detail and runtime modules are
now fetched only when their route is opened.

## Verification

- `npx tsc --noEmit`: passed.
- `npx vitest run --maxWorkers=1 --minWorkers=1`: 61 files / 464 tests passed.
- Focused `signalDeskLayout` + `RuntimePage` tests: 50 tests passed.
- `npm run build`: passed; page chunks listed above were emitted.
- `git diff --check`: passed (existing LF/CRLF normalization warnings only).

## Boundary

This is a bundle-load optimization, not a claim about QEMU guest or host
working-set reduction. Real Tauri window, login, browsing, and long-running
device acceptance remain covered by P7-1 manual walkthrough.
