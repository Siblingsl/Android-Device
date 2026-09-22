# Signed Authorization Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the guest preauthorization JTI marker with a server-signed, operation-bound authorization receipt so qemu-center can prove that the grant was consumed online before creating Docker resources.

**Architecture:** The authorization service returns a short-lived Ed25519-signed receipt after atomically consuming an execution grant. The guest runner verifies the receipt and stores its canonical JSON in the per-operation marker file. qemu-center reads that JSON over SSH and verifies the receipt with the compiled public-key ring, then compares every receipt binding with the already verified grant before issuing any Docker command.

**Tech Stack:** Rust (`authorization-service`, `qemu-center`, Tauri), Python 3 standard library guest runner, Ed25519 signatures, serde JSON, existing qemu-center SSH command execution.

**Spec:** `docs/superpowers/plans/2026-09-20-activation-authorization-preflight.md`

## Global Constraints

- The guest runner remains a protected server-delivered artifact; release builds must not embed the local runner source.
- `qemu-center redroid create` must verify the grant and online receipt before `docker volume create`, `docker run`, or any other Docker command.
- The activation JTI remains one-time; the receipt must not introduce a second consumption.
- Existing upgrade, restore, details, and debug-only paths retain their current authorization behavior.
- The receipt file remains below `/run/rdc-presets/<job>`, owned by `rdc:rdc`, mode `0600`, and is removed on activation or cleanup.
- Production changes require the repository’s full TypeScript, Vitest, Tauri, qemu-center, authorization-service, guest-runner, release-build, release-scan, and diff checks.

## Review Focus

- A valid-looking JTI-only marker must fail because it is not a signed receipt.
- A receipt signed by an untrusted key must fail before Docker is touched.
- A receipt for another grant, VM, instance, action, artifact, device, or expired time window must fail closed.
- The server must not consume a JTI until all existing grant, device-proof, entitlement, and artifact checks pass.
- A valid receipt must be consumed exactly once and must not break the subsequent activation runner.

### Task 1: Add the signed receipt protocol to authorization-service

**Files:**
- Modify: `authorization-service/src/crypto.rs`
- Modify: `authorization-service/src/routes.rs`
- Test: Rust unit and route tests in those files

**Interfaces:**
- Produces `ExecutionAuthorizationReceiptClaims` with the exact bindings `grant_jti`, `client_id`, `device_id`, `session_id`, `client_version`, `artifact_id`, `artifact_sha256`, `action`, `vm`, `instance`, `iat`, and `exp`.
- Produces `SignedExecutionAuthorizationReceipt { key_id, payload, signature }`.
- Changes `POST /v1/execution-grants/consume` from `204 No Content` to `200 OK` with the signed receipt JSON after successful one-time reservation.

- [ ] **Step 1: Write failing tests**

  Add a route assertion that a valid grant with the registered device proof returns `200 OK`, decodes as `SignedExecutionAuthorizationReceipt`, verifies with the authority public key, and has `grant_jti` equal to the consumed grant JTI. Add assertions that the replay still returns `409` and invalid device proof still returns `403` without creating a receipt.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

  Run `cargo test --manifest-path authorization-service/Cargo.toml execution_grant_is_signed_and_bound_to_the_published_artifact_and_workflow`. Expected: compilation or assertion failure because the response is currently `204` and the receipt types do not exist.

- [ ] **Step 3: Implement the minimal signed receipt types and response**

  Add serde types and a `SigningAuthority::sign_execution_authorization_receipt` method. After `consume_nonce("execution-grant-jti:<jti>")` succeeds, sign the receipt claims with the same rotating authority key and return `Json(receipt)`. Do not move the reservation earlier or later in the existing validation sequence.

- [ ] **Step 4: Run focused and full authorization-service tests**

  Run `cargo test --manifest-path authorization-service/Cargo.toml`. Expected: all library, admin, main, and integration tests pass, including the new receipt assertions.

### Task 2: Make the guest marker carry and verify the receipt

**Files:**
- Modify: `src-tauri/src/services/qemu_guest.py`
- Modify: `src-tauri/src/services/test_qemu_guest.py`

**Interfaces:**
- `consume_execution_grant(grant)` returns the decoded signed receipt object instead of `None` on HTTP 200.
- `write_execution_authorization_marker(request, claims, receipt)` writes canonical JSON for that receipt.
- `require_execution_authorization_marker(request, claims)` validates that the marker is a signed receipt bound to `claims`, not a JTI string.

- [ ] **Step 1: Write failing Python tests**

  Add tests for a `200` JSON response, a marker containing the receipt JSON, rejection of a legacy JTI-only marker, and rejection of a receipt whose `grant_jti` differs from the grant. Keep the existing “no Docker before consume” test and make it assert the receipt is passed to the marker writer.

- [ ] **Step 2: Run the guest tests and verify the expected failure**

  Run `python -m unittest src-tauri/src/services/test_qemu_guest.py`. Expected: failures because consume currently accepts only `204` and marker validation currently compares plain text JTI.

- [ ] **Step 3: Implement receipt parsing and signature verification**

  Add the `rdc-qemu-center` receipt audience constant, verify the receipt’s key ID, Ed25519 signature, JSON claims, time bounds, grant JTI, VM, instance, action, artifact hash, device, client, session, and version. Use the same embedded public key as the grant and reject malformed or legacy markers before Docker construction.

- [ ] **Step 4: Run the guest tests and the full Tauri test suite**

  Run `python -m unittest src-tauri/src/services/test_qemu_guest.py` and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: guest tests and all Tauri tests pass.

### Task 3: Verify the receipt in qemu-center before Docker

**Files:**
- Modify: `qemu-center/src/guest.rs`
- Modify: `qemu-center/src/main.rs`
- Test: `qemu-center/src/guest.rs` and `qemu-center/src/main.rs`

**Interfaces:**
- Guest command helper returns the marker JSON safely (`test -f ... && cat ...`) without invoking Docker.
- qemu-center verifies the receipt with `RDC_AUTH_PUBLIC_KEYS` and compares it against the grant claims before resource checks or Docker commands.

- [ ] **Step 1: Write failing Rust tests**

  Add pure tests for a valid signed receipt, a JTI-only marker, an invalid signature, a mismatched VM/instance/action/artifact, and an expired receipt. Update the command-shape test to assert the marker is read rather than compared as plain JTI text.

- [ ] **Step 2: Run qemu-center tests and verify the expected failure**

  Run `cargo test --manifest-path qemu-center/Cargo.toml`. Expected: compilation or assertion failure because receipt verification is not implemented.

- [ ] **Step 3: Implement verification before any guest Docker call**

  Read the marker via SSH, parse the signed receipt, verify its signature using the same build-time key ring, compare every operation binding with the verified grant, and return the existing fail-closed preflight error on any mismatch. Only after this succeeds may `guest_docker` be called.

- [ ] **Step 4: Run the full qemu-center suite and release build**

  Run `cargo test --manifest-path qemu-center/Cargo.toml` and `cargo build --release --manifest-path qemu-center/Cargo.toml`. Expected: all tests pass and the release CLI builds without warnings that change behavior.

### Task 4: Update evidence and run all repository gates

**Files:**
- Create: `work/runtime-core-protection-20260917/evidence/E-065-signed-authorization-receipt-20260920.md`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Modify: `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`

- [ ] **Step 1: Record the threat-model finding and fix boundary**

  Document that a plain marker could be forged by a writer with Guest access, that the receipt now proves server-side online consumption, and that a Guest root/host-admin attacker can still extract a live plaintext runner.

- [ ] **Step 2: Run the complete verification matrix**

  Run `npx tsc --noEmit`, `npx vitest run --maxWorkers=1 --minWorkers=1`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path qemu-center/Cargo.toml`, `cargo test --manifest-path authorization-service/Cargo.toml`, `python -m unittest src-tauri/src/services/test_qemu_guest.py`, both release builds, `scripts/verify-release-core.ps1`, and `git diff --check`.

- [ ] **Step 3: Update counts and leave real-device items pending**

  Add E-065 to the evidence index and explicitly retain the pending manual login/browse/30-minute, production TLS/key-rotation, offline, copy, and replay drills.

### Task 5: Add a host-side one-time receipt ledger

**Files:**
- Modify: `qemu-center/src/main.rs`
- Test: `qemu-center/src/main.rs` test module
- Create: `work/runtime-core-protection-20260917/evidence/E-066-host-receipt-replay-guard-20260920.md`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Modify: `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`

**Interfaces:**
- Produces `consume_execution_receipt_once(state_dir: &Path, grant_jti: &str) -> Result<(), String>`.
- Stores one empty receipt-consumption file below `<state-dir>/execution-receipts/`, using URL-safe encoding of the JTI as the filename.
- Uses `OpenOptions::create_new(true)` so concurrent or repeated use of the same signed JTI fails atomically.

- [x] **Step 1: Write the failing test**

  Add a test that calls `consume_execution_receipt_once` twice with the same state directory and JTI, expects the first call to succeed and the second to return an already-used error, then confirms a different state directory has an independent ledger.

- [x] **Step 2: Run the focused test and verify the expected failure**

  Run `cargo test --manifest-path qemu-center/Cargo.toml execution_receipt_once`. Expected: compilation failure because the ledger function does not exist.

- [x] **Step 3: Implement the minimal atomic ledger**

  Validate that the JTI is non-empty and contains no path/control characters, create `<state-dir>/execution-receipts`, encode the JTI with the existing URL-safe base64 engine, and create the ledger file with `create_new(true)`. Map `AlreadyExists` to a replay error and all other filesystem errors to a fail-closed error.

- [x] **Step 4: Consume the ledger before Docker**

  In `cmd_redroid_create`, call the ledger only after grant and signed receipt validation succeeds and immediately before resource/Docker work. A ledger collision must return before `docker ps`, `docker volume create`, or `docker run`.

- [x] **Step 5: Run the qemu-center suite and document the residual boundary**

  Record positive, replay, concurrent-safe, and full-suite results in E-066. State explicitly that deleting or copying the entire host state directory remains an administrator-level boundary and still requires the service-side device proof in a fresh operation.
