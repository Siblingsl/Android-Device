# Device signing key hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-exportable Windows CNG/Platform Crypto Provider device signer while preserving the existing DPAPI/Ed25519 protocol for compatible clients.

**Architecture:** Introduce a signer abstraction in the Tauri secure-store layer. New Windows identities use a named ECDSA P-256 key in the Microsoft Platform Crypto Provider and return only a SEC1 public key; existing Ed25519 identities keep their current representation. Add an explicit algorithm field to registration so the authorization service chooses the verifier from server-stored metadata rather than guessing from untrusted input.

**Tech Stack:** Rust 2021, Tauri backend, `windows-sys` CNG/NCrypt bindings, `p256` ECDSA verification, existing `ed25519-dalek`, Axum, SQLite, Vitest/Rust tests.

**Spec:** `docs/superpowers/specs/2026-09-20-device-signing-key-hardening-design.md`

## Global Constraints

- Preserve existing `ed25519-dpapi-v1` registrations and do not silently rotate them.
- Never serialize, export, log, or expose CNG private key bytes.
- Server verification must use the algorithm stored for the registered client.
- Hardware-backed availability is a security level and must be visible to policy; no silent claim that DPAPI equals TPM protection.
- Backend changes require the project's full TypeScript, Vitest, Tauri, qemu-center, authorization-service, Python guest, release, and diff checks.
- Do not start or stop the live `node1`, modify qcow2 files, or change QEMU runtime state as part of this protocol work.

## Review Focus

- An attacker changes `client_key_algorithm` after registration: the server must use the stored value and reject the mismatch.
- A CNG key is deleted or replaced: startup must fail closed rather than silently create a new device identity.
- A P-256 signature is encoded as DER instead of raw `r || s`: the server must reject it.
- A client has an existing DPAPI Ed25519 identity: it must remain usable without an automatic migration.
- CNG/TPM/VBS is unavailable: the client must report the weaker fallback and obey the configured policy.

---

### Task 1: Add protocol algorithm identity and failing tests

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs` (`RegisterRequest` and signer call sites)
- Modify: `src-tauri/src/services/authorization.rs` (algorithm constants and typed verification errors)
- Modify: `authorization-service/src/crypto.rs` (algorithm enum and verifier dispatch)
- Modify: `authorization-service/src/routes.rs` (registration payload and client persistence)
- Test: existing Rust unit tests in the files above

**Interfaces:**
- Produces `ClientKeyAlgorithm::{Ed25519DpapiV1,EcdsaP256CngV1}` serialized as
  `ed25519-dpapi-v1` and `ecdsa-p256-cng-v1`.
- Produces `verify_client_signature(algorithm, public_key, payload, signature)`
  with explicit algorithm input.

- [x] **Step 1: Write failing tests**

  Add tests that register a request with an explicit algorithm, verify a P-256
  public key is not accepted by the Ed25519 branch, and verify the service
  rejects a signature format that does not match the stored algorithm. Use a
  deterministic P-256 test key and assert the expected error variants.

- [x] **Step 2: Run the focused tests and verify RED**

  Run:

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml services::authorization
  cargo test --manifest-path authorization-service/Cargo.toml crypto::tests
  ```

  Expected: compilation or assertion failures because the algorithm field and
  explicit verifier do not exist yet.

- [x] **Step 3: Implement the typed protocol field and dispatch**

  Add the enum, include it in registration request/response persistence, and
  route verification by the stored enum. Keep Ed25519 behavior byte-for-byte
  compatible. Add `p256` with ECDSA support to both Rust manifests and verify
  P-256 using the SHA-256 prehash API; accept only 65-byte SEC1 public keys and
  64-byte raw signatures.

- [x] **Step 4: Run focused tests and verify GREEN**

  Re-run the two focused commands. Expected: all existing authorization tests
  plus the new algorithm tests pass.

- [x] **Step 5: Commit the protocol slice**

  ```powershell
  git add src-tauri authorization-service
  git commit -m "feat: bind client signatures to explicit key algorithms"
  ```

### Task 2: Introduce the signer abstraction without changing existing identities

**Files:**
- Modify: `src-tauri/src/services/secure_store.rs`
- Modify: `src-tauri/src/services/authorization_client.rs`
- Test: `src-tauri/src/services/secure_store.rs` and `authorization_client.rs` unit tests

**Interfaces:**
- Produces `DeviceSigner` with `algorithm()`, `public_key_base64url()`, and
  `sign_canonical(payload)`, while retaining `MemorySecureStore` for tests.
- Existing DPAPI records continue to load as the Ed25519 signer.

- [x] **Step 1: Write failing signer tests**

  Add tests for Ed25519 signer round-trip, public-key-only identity serialization,
  and rejection when key metadata is incomplete or the stored public key changes.

- [x] **Step 2: Run focused tests and verify RED**

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml services::secure_store
  ```

  Expected: missing signer methods or failing assertions.

- [x] **Step 3: Implement the abstraction and migrate client call sites**

  Replace direct `load_signing_key_with(...).sign(...)` calls in registration,
  session, heartbeat, and device-proof creation with the signer interface. Keep
  the current DPAPI Ed25519 implementation as the compatibility backend.

- [x] **Step 4: Run focused tests and verify GREEN**

  Cargo accepts one test filter per invocation, so run the two focused suites
  as separate commands:

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml services::secure_store
  cargo test --manifest-path src-tauri/Cargo.toml services::authorization_client
  ```

- [x] **Step 5: Commit the signer abstraction**

  ```powershell
  git add src-tauri/src/services/secure_store.rs src-tauri/src/services/authorization_client.rs
  git commit -m "refactor: abstract device proof signing"
  ```

### Task 3: Add the Windows CNG/Platform Crypto Provider backend

**Files:**
- Modify: `src-tauri/src/services/secure_store.rs`
- Modify: `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` only if the CNG implementation needs a new direct dependency
- Test: Windows-gated secure-store tests and cross-platform policy tests

**Interfaces:**
- Produces `CngDeviceSigner` backed by a named `ECDSA_P256` key in the
  Microsoft Platform Crypto Provider.
- Exports only an uncompressed SEC1 public key; signing hashes canonical JSON
  with SHA-256 and calls `NCryptSignHash`.

- [x] **Step 1: Write failing policy and shape tests**

  Add tests that assert the CNG metadata contains an algorithm, key name, and
  public key but no private-key field, and that malformed CNG public blobs,
  wrong magic values, wrong coordinate lengths, and non-64-byte signatures are
  rejected.

- [x] **Step 2: Run tests and verify RED**

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml services::secure_store
  ```

  Expected: missing CNG parser/signer types or failing shape assertions.

- [x] **Step 3: Implement minimal Windows CNG backend**

  Under `cfg(windows)`, open `MS_PLATFORM_CRYPTO_PROVIDER`, create or open a
  user-scoped named P-256 key, inspect hardware/VBS implementation flags,
  export `BCRYPT_ECCPUBLIC_BLOB`, validate its magic and coordinate sizes, and
  convert it to `04 || X || Y`. Wrap NCrypt handles in an RAII type and map
  provider failures to a typed error. Never call an export API for private key
  material. Strict hardware/VBS selection is applied by the policy layer in
  Task 4; the current `windows-sys` bindings do not expose a dedicated VBS
  creation flag. Under non-Windows or unsupported-provider conditions, policy
  keeps the existing DPAPI fallback.

- [x] **Step 4: Run cross-platform tests and Windows-gated tests**

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml services::secure_store
  $env:RDC_RUN_CNG_PROVIDER_TESTS = "1"
  cargo test --manifest-path src-tauri/Cargo.toml services::secure_store -- --ignored
  ```

  Expected: the shape tests pass on Windows and the CNG code remains excluded
  from non-Windows builds. The explicitly enabled provider probe creates and
  deletes an ephemeral named user key; hardware/TPM backing remains a manual
  acceptance check in Task 5.

- [x] **Step 5: Commit the CNG backend**

  ```powershell
  git add src-tauri/src/services/secure_store.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -m "feat: use non-exportable Windows device signing keys"
  ```

### Task 4: Add fallback policy, observability, and documentation

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Modify: `src-tauri/src/services/secure_store.rs`
- Modify: `src-tauri/src/models/mod.rs` or the existing runtime status model where authorization security status is exposed
- Modify: `src/i18n/pages/settings.ts` and the relevant Settings UI if a status row is already present
- Test: relevant Rust and Vitest tests
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`, `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`

**Interfaces:**
- Produces a security level: `hardware_backed`, `cng_software_provider`, or
  `dpapi_software_fallback`.
- Produces a policy error when high-value authorization requires hardware-backed
  keys and the current device cannot provide one.

- [x] **Step 1: Write failing policy/UI tests**

  Add tests for default permissive fallback, strict hardware-required mode,
  stable serialization of the security level, and a user-visible message that
  distinguishes TPM-backed protection from DPAPI fallback.

- [x] **Step 2: Run tests and verify RED**

  ```powershell
  npx vitest run src/pages/Settings.test.tsx
  cargo test --manifest-path src-tauri/Cargo.toml services::authorization_client
  ```

  Expected: missing security-level state or strict-policy assertions.

- [x] **Step 3: Implement policy and user-visible status**

  Keep permissive fallback for existing deployments, add a strict mode for
  production accounts, and ensure every protected operation records the active
  key algorithm/security level in audit metadata without recording private
  material.

- [x] **Step 4: Run focused tests and verify GREEN**

  Re-run the focused commands and inspect that no private key, DPAPI plaintext,
  CNG key handle, or artifact plaintext appears in the status payload.

- [x] **Step 5: Update evidence and handoff**

  Record the exact provider/policy tests, add a new evidence file, and leave
  real TPM/VBS, cross-machine copy, and key-rotation checks in P7/production
  acceptance rather than claiming them as automated.

### Task 5: Full verification and release gate

**Files:**
- Modify: `docs/superpowers/plans/2026-09-20-device-signing-key-hardening.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-054-device-signing-key-hardening-20260920.md`

- [ ] **Step 1: Run all repository gates**

  ```powershell
  npx tsc --noEmit
  npx vitest run
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo test --manifest-path qemu-center/Cargo.toml
  cargo test --manifest-path authorization-service/Cargo.toml
  python -m unittest src-tauri/src/services/test_qemu_guest.py
  git diff --check
  ```

- [ ] **Step 2: Build release binaries and scan them**

  ```powershell
  cargo build --release --manifest-path src-tauri/Cargo.toml
  cargo build --release --manifest-path qemu-center/Cargo.toml
  powershell -NoProfile -Command "& '.\\scripts\\verify-release-core.ps1' -BinaryPath '.\\src-tauri\\target\\release\\redroid-device-center.exe', '.\\qemu-center\\target\\release\\qemu-center.exe'"
  ```

- [ ] **Step 3: Record evidence and review boundaries**

  Document that the CNG private key is non-exportable by design, hardware
  backing is still an environment fact requiring manual confirmation, and a
  privileged attacker on the original machine can still invoke legitimate
  signing operations while the client is running.

- [ ] **Step 4: Mark this plan complete only after all gates pass**

  Do not remove `docs/AI-HANDOFF-NEXT-STEPS.md`; P7 and production acceptance
  remain separate until the user completes them.
