# Critical-pressure warm-node override

## Goal

Protect the host when an existing installation has explicitly chosen to keep
QEMU warm: once host available memory is `critical`, an idle release may stop
the QEMU node after the existing fresh empty-node proof succeeds.

## Scope

- Keep explicit warm behavior under normal, caution, and unknown pressure.
- Override it only for critical pressure and only for an empty node.
- Preserve fail-closed behavior for unknown instance status and probe failures.
- Explain the override in the settings UI.

## Verification

- [x] Add a failing unit test for critical versus normal/unknown pressure.
- [x] Implement the smallest pressure-aware preference helper and idle-release integration.
- [x] Update bilingual settings copy and evidence.
- [x] Run focused and full validation gates.
