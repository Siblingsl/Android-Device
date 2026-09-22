# Protected Create Grant Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the protected QEMU create grant request count with the four stages consumed by the create workflow.

**Architecture:** Introduce one named stage-count constant at the Tauri command boundary and use it for the create grant request. Keep the existing literal two-stage upgrade request unchanged, because its flow consumes only build and upgrade. A focused unit test pins the create count before the command can be exercised against a live authorization service.

**Tech Stack:** Rust, Tauri commands, existing execution-grant protocol, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-20-protected-create-grant-count.md`

## Global Constraints

- Keep each grant single-use and preserve server-side JTI replay protection.
- Do not reuse a grant across stages.
- Do not weaken host receipt verification or guest online authorization.
- Keep the change limited to the source of the stage-count request and its regression test.

## Review Focus

- The create and upgrade counts must remain distinct; test both values.
- The constant must be used by the actual Tauri create command, not only asserted in isolation.
- No additional grant may be consumed or silently ignored by the guest workflow.

---

### Task 1: Correct and pin the protected create stage count

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Create: `work/runtime-core-protection-20260917/evidence/E-077-protected-create-grant-count-20260920.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`

**Interfaces:**
- Consumes: `authorization_client::runtime_download_core_with_execution_grants` and `qemu::redroid_create_with_grants`.
- Produces: `QEMU_CREATE_EXECUTION_STAGE_COUNT == 4` at the create command boundary; upgrade remains `2`.

- [x] **Step 1: Add the failing regression test**

Add to `commands::tests`:

```rust
#[test]
fn protected_create_requests_all_four_execution_stages() {
    assert_eq!(QEMU_CREATE_EXECUTION_STAGE_COUNT, 4);
    assert_eq!(QEMU_UPGRADE_EXECUTION_STAGE_COUNT, 2);
}
```

Use the constants in the production command so this test observes the values
that the command passes to the authorization client.

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::tests::protected_create_requests_all_four_execution_stages -- --exact
```

Expected: compile failure because the stage-count constants do not yet exist.

- [x] **Step 3: Implement the minimal correction**

Define near the protected QEMU commands:

```rust
const QEMU_CREATE_EXECUTION_STAGE_COUNT: usize = 4;
const QEMU_UPGRADE_EXECUTION_STAGE_COUNT: usize = 2;
```

Replace the create call's literal `3` with
`QEMU_CREATE_EXECUTION_STAGE_COUNT` and the upgrade call's literal `2` with
`QEMU_UPGRADE_EXECUTION_STAGE_COUNT`. Do not alter grant validation or stage
ordering.

- [x] **Step 4: Run the focused test and full required gates**

Run the focused test again, then:

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
git diff --check
```

Expected: all exit 0; the focused test and Tauri suite include the corrected
four/two stage contract.

- [x] **Step 5: Record evidence and update the handoff**

Write the root cause, RED/GREEN results, exact test counts, and the remaining
manual live-authorization boundary into E-077. Add E-077 to the handoff
evidence list and the runtime authorization item without claiming production
TLS or live guest acceptance.
