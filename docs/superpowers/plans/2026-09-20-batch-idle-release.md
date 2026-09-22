# Batch idle-instance release

## Goal

Make memory-first operation practical when a QEMU node contains several instances:
one explicit user action should ask the existing backend idle-policy gate about every
currently running instance, stop only instances confirmed idle, and leave active,
unknown, protected, or exited instances untouched.

## Scope

- Add a pure frontend selector for currently running rows; the backend remains the
  authority for activity, protected-instance, and status checks.
- Add a single confirmation action to the QEMU instances card.
- Reuse `runtime_release_idle` sequentially so existing VM-stop safety and per-instance
  result reasons remain authoritative.
- Add Chinese/English copy and focused tests.

## Safety invariants

- No automatic timer and no new force-stop path.
- No instance is sent to the backend unless its row proves a running state.
- The backend may still reject every candidate as active, unknown, or protected.
- The UI reports released and skipped counts and refreshes only after a release.

## Verification

- RED: the new selector test fails because the module does not exist.
- GREEN: selector tests pass, TypeScript passes, focused QEMU/i18n tests pass, then the
  full Vitest suite passes.
- No Docker, QEMU, node1, or qcow2 state is touched.
