# Authorization entitlement revocation acceptance plan

**Goal:** Make server-side capability revocation effective immediately for existing
leases and in-progress artifact transfers, so a copied/reversed client cannot keep
using a protected capability until the original lease expires.

**Scope:** `authorization-service` store and route tests only. No QEMU or live
desktop state is changed.

## Task 1: Add an atomic entitlement revoke operation

- [x] Write a failing store test for revoking an enabled capability and for the
  already-disabled/not-present cases.
- [x] Run the focused store test and observe the missing-method failure.
- [x] Add the smallest `revoke_entitlement(account_id, capability)` operation;
  keep the row for auditability and set `enabled=0`.
- [x] Run the focused store test.

## Task 2: Prove existing sessions and transfers fail closed

- [x] Write a route test that creates a session and artifact transfer, revokes
  the entitlement, then verifies capabilities and chunk access are rejected.
- [x] Run the focused route test and observe the expected compile failure from
  the moved router, then fix the test fixture wiring.
- [x] Keep the existing session validation path authoritative; do not add a
  client-side grace period or offline fallback.
- [x] Run the focused route test.

- [x] Add `rdc-auth-admin entitlement revoke` for operator-driven capability
  withdrawal and verify the command's documented usage and a temporary-db
  grant/revoke smoke.

## Task 3: Verify and record evidence

- [x] Run all required project suites, authorization-service tests, formatting,
  diff checks, and release core scan.
- [x] Record the exact counts in an evidence file and update the handoff.
