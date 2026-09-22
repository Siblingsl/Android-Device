# Protected Core Key-Rotation Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repeatable, secret-free acceptance rehearsal that proves the protected-core authorization path survives a signing-key rotation and that runners rendered with the new key replace runners rendered with the old key without weakening fail-closed behavior.

**Architecture:** Reuse the existing in-memory Axum authorization router, deterministic test signing authorities, runner placeholder renderer, and client/qemu public-key-ring parsers. The rehearsal will exercise old-key issuance, new-key issuance after a simulated service restart, receipt verification against the matching key, rejection against the retired key, and artifact rendering for both runner generations. It will produce code-level evidence only; production TLS, secret-manager state, real accounts, and live guest execution remain manual gates.

**Tech Stack:** Rust, Axum, Tokio, `ed25519-dalek`, `tempfile`, existing authorization-service integration tests, qemu-center receipt verifier, Windows PowerShell evidence script.

**Spec:** `docs/ops/authorization-key-rotation-runbook.md`

## Global Constraints

- Never place a real signing secret, private key, account credential, or production endpoint in source, test output, command-line arguments, or evidence.
- The desktop client and qemu-center receive public-key rings only; signing private keys remain in the test fixture or server-side process.
- A key switch must not relax device proof, artifact/workflow binding, JTI one-time consumption, receipt expiry, or guest Docker preflight.
- Do not start Docker, QEMU, or touch live qcow2 state for this rehearsal.
- After each implementation phase run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path qemu-center/Cargo.toml`.

## Review Focus

- Old and new authorities must use distinct key IDs and public keys; a new receipt must never verify with the retired key.
- A copied old grant or receipt must remain one-time and must not become valid after the service authority changes.
- Runner rendering must replace every execution placeholder and must not leave the old public key in the new artifact.
- A malformed or duplicate public-key ring must fail before any protected operation is attempted.
- The rehearsal must state exactly which production properties it does not prove: TLS termination, secret-manager access, real account approval, cross-device execution, and live guest plaintext exposure.

---

### Task 1: Add the failing cross-key protocol test

**Files:**
- Modify: `authorization-service/tests/protocol.rs`
- Reference: `authorization-service/src/routes.rs` (`ExecutionGrantRequest`, `ConsumeExecutionGrantRequest`)
- Reference: `authorization-service/src/crypto.rs` (`SigningAuthority`, `SignedExecutionGrant`, `SignedExecutionAuthorizationReceipt`)

**Interfaces:**
- Consumes the existing `client_fixture`, `app_fixture`, `session_request`, and `post_json` helpers.
- Produces an integration test proving old/new authority behavior through the actual HTTP router, not direct helper calls only.

- [x] **Step 1: Write the cross-key protocol regression test**

  Add `restarting_with_next_signing_key_requires_a_new_runner_and_keeps_old_grants_one_time` that creates a shared approved client/store, starts an app with `auth-old`, obtains a valid session and execution grant, consumes it with a device proof, then rebuilds the router over the same store with `auth-next`. The test must assert: the first receipt has `key_id == "auth-old"`; replaying the same grant returns `409`; a newly issued grant/receipt has `key_id == "auth-next"`; the new receipt verifies with the next authority and fails verification with the old authority; and the old grant cannot be consumed again through the restarted router.

- [x] **Step 2: Run the focused test**

  Run:

  ```powershell
  cargo test --manifest-path authorization-service/Cargo.toml --test protocol restarting_with_next_signing_key_requires_a_new_runner_and_keeps_old_grants_one_time
  ```

  The existing authorization implementation already satisfied this stronger boundary, so the new
  regression test passed on its first run; this was recorded as existing behavior coverage rather
  than a production-code change.

- [x] **Step 3: Implement the smallest test fixture adjustment**

  Refactor only the shared test fixture needed to reuse one `AuthStore` across two `AppState` values. Keep the same client, entitlement, artifact hash, device proof, and JTI validation path; do not add production behavior solely to make the test pass.

- [x] **Step 4: Run the focused test and the authorization-service suite**

  Run the focused command again, then:

  ```powershell
  cargo test --manifest-path authorization-service/Cargo.toml
  ```

  Expected result: the rotation test and all existing authorization-service tests pass.

### Task 2: Pin runner artifact replacement during rotation

**Files:**
- Modify: `authorization-service/src/bin/rdc-auth-admin.rs` tests
- Modify: `src-tauri/src/services/authorization_client.rs` tests only if a cross-key assertion is needed
- Modify: `qemu-center/src/main.rs` tests only if receipt verification needs a public-key-ring assertion

**Interfaces:**
- Consumes `render_runner_source` and the existing public-key-ring parsers.
- Produces a test that identifies the old and next runner generations by key ID and public key, with no unresolved placeholders.

- [x] **Step 1: Write the renderer generation regression test**

  Add a test that renders the same placeholder source with `auth-old` and `auth-next`, then asserts the old output contains only the old key ID/public key, the next output contains only the next key ID/public key, both contain the configured HTTPS consume URL, and neither output contains `__RDC_EXECUTION_` placeholders.

- [x] **Step 2: Run the focused admin test**

  Run:

  ```powershell
  cargo test --manifest-path authorization-service/Cargo.toml --bin rdc-auth-admin runner_rendering
  ```

  The existing renderer already replaced the placeholders correctly; the test was strengthened to
  compare distinct old/new key generations and passed without a production renderer change.

- [x] **Step 3: Implement only the renderer/test fixture change required by the test**

  Keep `publish-runner` server-side and preserve its HTTPS-or-localhost URL policy. Do not add a private-key CLI argument, a client-side signing secret, or an automatic destructive replacement of production artifacts.

- [x] **Step 4: Run renderer, client trust-ring, qemu receipt, and full suites**

  Run the focused renderer test, the existing public-key-ring tests, the receipt tests, and the full required test matrix. Expected result: old/new trust-ring parsing remains green and the new runner generation is distinguishable by its embedded key ID.

### Task 3: Add a secret-free rotation rehearsal command and evidence

**Files:**
- Create: `scripts/verify-auth-rotation.ps1`
- Create: `work/runtime-core-protection-20260917/evidence/E-067-auth-key-rotation-rehearsal-20260920.md`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Modify: `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`

**Interfaces:**
- Script accepts no secrets and runs the focused rotation tests plus the release-core verifier against explicitly supplied local release binaries.
- Evidence records exact commands, test counts, key IDs used by fixtures, and residual production boundaries.

- [x] **Step 1: Write the failing script contract test/documented invocation**

  Add a PowerShell test or parser assertion that the script rejects missing binary paths, never reads `RDC_AUTH_SIGNING_KEY`, and reports the focused rotation test result before the release scan.

- [x] **Step 2: Run the contract check and verify the expected failure**

  Run the script with a deliberately missing qemu-center release path and confirm it exits nonzero without starting Docker/QEMU or printing any secret-like environment value.

- [x] **Step 3: Implement the secret-free rehearsal script**

  Use explicit paths and existing cargo/test commands; pass public-key configuration only where required for local verification. Keep the script fail-closed and avoid recursive deletion or broad workspace mutation.

- [x] **Step 4: Run the rehearsal and write E-067**

  Record old-key issuance, next-key issuance, old-grant replay rejection, old-key verification rejection of the next receipt, runner placeholder replacement, full test gates, and release scan results. Mark production TLS, secret-manager, real-account, cross-device, and live-guest checks as pending rather than inferring them from the rehearsal.

- [x] **Step 5: Update acceptance and handoff without declaring production complete**

  Add E-067 to the evidence index and retain the unchecked production rotation/manual matrix items until the user performs them in the real deployment.

### Task 4: Enforce the rehearsal in the Windows release workflow

**Files:**
- Modify: `.github/workflows/windows-release.yml`
- Modify: `work/runtime-core-protection-20260917/evidence/E-067-auth-key-rotation-rehearsal-20260920.md`

**Interfaces:**
- Runs only secret-free authorization-service tests and the contract check before packaging.
- Runs the rotation rehearsal and protected-core scan against the release binaries after packaging.

- [x] Add the authorization-service full suite and contract check to the release job.
- [x] Run the release rehearsal after the NSIS build with explicit binary paths and no signing-secret environment variable.
- [x] Document that CI enforces the code-level rehearsal while production rotation remains a deployment gate.

## Verification Checklist

- [x] Focused cross-key rotation regression test passed; existing production behavior made a RED-first implementation failure unnecessary.
- [x] Runner replacement test passed for both old and next key generations.
- [x] `authorization-service` full suite passes.
- [x] `qemu-center`, `src-tauri`, TypeScript, Vitest, formatting, and `git diff --check` pass.
- [x] Release scan is clean for all four protected binaries.
- [x] Evidence explicitly separates code-level rehearsal from production/manual acceptance.
- [x] Windows release CI runs the secret-free rehearsal before publishing an installer.
