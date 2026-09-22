# E-041 — Release core scanner PowerShell compatibility

Date: 2026-09-18

## Finding

Running `scripts/verify-release-core.ps1` under the repository's Windows
PowerShell environment raised a non-terminating error because the script used
the two-argument `String.Contains` overload, which is unavailable there. The
script could still print `clean`, so the result was not sufficiently
trustworthy as a release gate.

## Fix and verification

- Replaced the overload with ordinal `String.IndexOf`, which is supported by
  Windows PowerShell 5.1 and preserves the intended case-sensitive scan.
- Re-ran the scanner against both current release binaries:
  `redroid-device-center.exe` and `redroid_device_center_lib.dll`.
- Both returned `clean` with no PowerShell method errors.

This closes a tooling false-positive path; it does not replace a real release
build or the separate manual copy/tamper acceptance of a rendered runner.
