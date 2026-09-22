# Server-Authoritative Core Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make protected Redroid Device Center capabilities unavailable without a valid server-issued, device-bound, short-lived lease while keeping non-protected diagnostics and ordinary device controls usable.

**Architecture:** The server is the trust authority for accounts, entitlements, revocation, version policy, core algorithms, and artifact manifests. The Tauri Rust layer owns device-key storage, signature verification, lease lifecycle, and protected-command enforcement; React only renders authorization state. Files that must run inside QEMU/Android are delivered as signed, session-bound encrypted chunks, while the highest-value logic remains server-side.

**Tech Stack:** Tauri Rust client, standalone Rust authorization service, TLS 1.3, Ed25519 signatures, X25519 + HKDF-SHA256 + ChaCha20-Poly1305 chunk encryption, Windows DPAPI/CNG secure storage, JSON/HTTP, SQLite-backed private authorization service, Vitest, Rust unit/integration tests.

**Spec:** `docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md`

## Global Constraints

- The default deployment is the project maintainer's private public authorization service; customer self-hosting is a separate future protocol-compatible project, not silently added here.
- No server private key, production token, device private key, third-party asset credential, or unencrypted core artifact enters Git, an installer, a log, a command-line argument, or a guest shared directory.
- Client-embedded material is limited to public verification keys and non-secret product metadata; a patched frontend must not be sufficient to unlock protected operations.
- Local signature/lease checks are defense in depth. High-value decisions and artifact authorization remain server-authoritative.
- A legal, user-authorized client may receive runtime plaintext for unavoidable local execution; the design does not claim to defeat administrator/root/debugger extraction after decryption.
- Existing third-party GApps/Magisk/LSPosed/Shamiko assets retain their upstream license obligations and are not relabeled as project-owned secrets.
- Every production code change follows TDD and the project four-suite validation gate; server-only tests add the server's own unit/integration commands.
- Backend changes in `src-tauri` and `qemu-center` require the user's explicit authorization before implementation starts.

## Implementation status (2026-09-17)

- Tasks 1–5 are implemented in the Tauri Rust client, including DPAPI-backed
  device identity, signed short-lived leases, Rust-side protected preset
  enforcement, structured UI status, and fail-closed release behavior.
- Task 6 is implemented as signed manifest plus X25519/HKDF/ChaCha20-Poly1305
  256 KiB chunk delivery. The QEMU preset path consumes the server-delivered
  runner and removes the local temporary plaintext after upload.
- Task 7 remains for account authentication, production service integration, and
  manual tamper/real-device acceptance. The client-side public-key rotation
  window is now implemented as a build-time key ring; deployment still needs
  an operator-run rotation rehearsal.
- Task 8 closes the release-only metadata path: version-independent guest
  details and restore actions use a server-delivered universal core artifact;
  an unavailable authorization service may return only basic read-only list
  rows and must never fall back to an embedded release script.
- Task 10 hardens lease timing: a stale or manipulated unsigned `serverTime`
  response field must not extend a signed lease, and an in-process wall-clock
  rollback must not extend the active session. The client validates a newly
  received lease against the later of local wall time and the reported server
  time, then tracks expiry from a monotonic process clock.
- Task 11 closes the protected-download handoff: the client that performs an
  artifact download now adopts the session returned by the shared runtime
  authorization check before requesting the manifest.

### Task 10: Make client lease expiry resistant to stale server time and clock rollback

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Test: `src-tauri/src/services/authorization_client.rs`
- Modify: `docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md`

**Acceptance:**
- [x] A signed lease already expired according to local time is rejected even when
  the response supplies an older `serverTime`.
- [x] Once accepted, lease checks use monotonic elapsed time instead of repeatedly
  trusting the wall clock, so moving the local clock backward cannot extend the
  active session.
- [x] The full project validation gate remains green.

### Task 11: Preserve the active session across protected artifact downloads

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Test: `src-tauri/src/services/authorization_client.rs`
- Modify: `docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md`

**Acceptance:**
- [x] A runtime download client adopts the session already validated by the
  shared runtime authorization state before preparing an artifact.
- [x] The handoff is covered by a fake-transport regression test.
- [x] The full project validation gate remains green.

---

### Task 1: Add protocol types and protected-capability policy

**Files:**
- Create: `src-tauri/src/services/authorization.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/mod.rs` only if shared app models are the established boundary
- Modify: `src/types/index.ts`
- Test: `src-tauri/src/services/authorization.rs`
- Test: `src/lib/authorization.test.ts`

**Interfaces:**
- Produces `ProtectedCapability::{ProtectedPreset, ProtectedArtifact, ProtectedAlgorithm}`.
- Produces `AuthorizationStatus::{NotRegistered, AuthenticationRequired, LeaseExpired, ServerUnreachable, ClientOutdated, BindingMismatch, ArtifactIntegrityFailed, Revoked, Ready}`.
- Produces `LeaseClaims { iss, aud, sub, client_id, device_id, session_id, capabilities, client_version, iat, exp, jti, nonce }`.
- Produces `ArtifactManifest { artifact_id, version, target_abi, target_android, session_id, device_id, size_bytes, sha256, expires_at, key_id, transfer_id, server_ephemeral_public_key, chunk_size_bytes, chunk_count, nonce_prefix }`.
- Test fixtures define `test_claims_with_expiry`, `test_claims_for_device`, and `test_manifest` in the same test module; they construct valid signed values and are not production APIs.

- [ ] **Step 1: Write failing claim-validation tests**

```rust
#[test]
fn expired_lease_is_rejected_even_when_the_signature_is_valid() {
    let claims = test_claims_with_expiry(1_000);
    assert_eq!(validate_claims(&claims, 1_001), Err(AuthorizationError::LeaseExpired));
}

#[test]
fn a_lease_for_another_device_is_rejected() {
    let claims = test_claims_for_device("device-a");
    assert_eq!(validate_device_binding(&claims, "device-b"), Err(AuthorizationError::BindingMismatch));
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml authorization::tests::expired_lease -- --exact`

Expected: FAIL because authorization types and validation do not exist.

- [ ] **Step 3: Implement pure policy and wire formats**

Use `serde(rename_all = "camelCase")` for the app-facing model and explicit snake_case raw wire structs for the HTTP protocol if the server contract requires them. Validate issuer, audience, device, session, `iat`, `exp`, `jti`, nonce and capability before returning `Ready`.

- [ ] **Step 4: Add TypeScript state and capability types**

Model all error states as a discriminated union. The UI must not infer `Ready` from a missing error or from a locally stored boolean.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: define protected capability authorization policy`

---

### Task 2: Implement device-key generation and secure storage

**Files:**
- Create: `src-tauri/src/services/secure_store.rs`
- Modify: `src-tauri/src/services/authorization.rs`
- Modify: `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` for the selected Windows cryptography/storage APIs
- Test: `src-tauri/src/services/secure_store.rs`

**Interfaces:**
- Produces trait `SecureStore { load(key: &str) -> Result<Option<Vec<u8>>, SecureStoreError>; save(key: &str, value: &[u8]) -> Result<(), SecureStoreError>; delete(key: &str) -> Result<(), SecureStoreError>; }`.
- Produces `WindowsSecureStore` backed by DPAPI/CNG and `MemorySecureStore` for deterministic tests.
- Produces `DeviceIdentity { install_id, device_id, public_key }` and `ensure_device_identity()`.

- [ ] **Step 1: Write failing storage tests**

```rust
#[test]
fn device_identity_round_trips_without_exposing_private_key_bytes() {
    let store = MemorySecureStore::default();
    let first = ensure_device_identity_with(&store).unwrap();
    let second = ensure_device_identity_with(&store).unwrap();
    assert_eq!(first.device_id, second.device_id);
    assert_eq!(first.public_key, second.public_key);
    assert!(!serde_json::to_string(&first).unwrap().contains("private"));
}
```

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml secure_store::tests::device_identity -- --exact`

Expected: FAIL because the secure-store boundary is missing.

- [ ] **Step 3: Implement the test store and Windows store**

Generate the device key pair once, store only the private material through DPAPI/CNG, and return the public key for registration. Reject empty/corrupt stored values and regenerate only after an explicit binding-reset path; ordinary startup must not silently change the device identity.

- [ ] **Step 4: Verify sensitive-value hygiene**

Add tests that command argument builders, serialized settings, log helpers and guest-bind builders never contain the device private key or an authorization token.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: protect client device identity with windows secure storage`

---

### Task 3: Build the private authorization service

**Files:**
- Create: `authorization-service/Cargo.toml`
- Create: `authorization-service/src/lib.rs`
- Create: `authorization-service/src/main.rs`
- Create: `authorization-service/src/crypto.rs`
- Create: `authorization-service/src/store.rs`
- Create: `authorization-service/src/routes.rs`
- Create: `authorization-service/src/bin/rdc-auth-admin.rs`
- Create: `authorization-service/migrations/0001_initial.sql`
- Create: `authorization-service/README.md`
- Test: `authorization-service/src/routes.rs`, `authorization-service/src/crypto.rs`, `authorization-service/src/store.rs`

**Interfaces:**
- HTTP routes: `POST /v1/clients/register`, `POST /v1/sessions`, `GET /v1/capabilities`, `POST /v1/sessions/{id}/heartbeat`, `POST /v1/sessions/{id}/close`, `POST /v1/artifacts/{id}/prepare`.
- Environment variables: `RDC_AUTH_DATABASE_URL`, `RDC_AUTH_SIGNING_KEY`, `RDC_AUTH_ARTIFACT_ROOT`, `RDC_AUTH_PUBLIC_BASE_URL`.
- Admin binary commands: `client approve`, `entitlement grant`, `artifact publish`, `client revoke`, `key rotate`.
- Store records: clients, devices, accounts, entitlements, sessions, used `jti`/nonce values, revocations, signing keys, artifact manifests.
- Route tests define `test_app()` and `post_session()` as local helpers that use an isolated in-memory SQLite database and a generated test signing key.
- Crypto tests define `signed_manifest(artifact_id, sha256)` as a local helper that signs the complete manifest with the generated test key.

- [ ] **Step 1: Write failing route and cryptographic tests**

```rust
#[tokio::test]
async fn sessions_reject_a_replayed_nonce() {
    let app = test_app().await;
    let first = post_session(&app, "nonce-1").await;
    assert_eq!(first.status(), StatusCode::OK);
    let second = post_session(&app, "nonce-1").await;
    assert_eq!(second.status(), StatusCode::CONFLICT);
}

#[test]
fn artifact_manifest_signature_changes_when_hash_changes() {
    let first = signed_manifest("artifact-a", "hash-a");
    let second = signed_manifest("artifact-a", "hash-b");
    assert_ne!(first.signature, second.signature);
}
```

- [ ] **Step 2: Run server tests and observe the expected failure**

Run: `cargo test --manifest-path authorization-service/Cargo.toml`

Expected: FAIL because the service crate and routes do not exist.

- [ ] **Step 3: Implement the SQLite schema and server key loading**

Load the signing key only from `RDC_AUTH_SIGNING_KEY`, fail closed when it is absent or malformed, and expose only the public key through a versioned configuration response. Store used nonces/JTIs transactionally so concurrent requests cannot replay a session.

- [ ] **Step 4: Implement registration, lease, heartbeat, revoke and capability routes**

Require a valid device signature over the server challenge, enforce account/device/version/concurrency policy, issue leases of no more than 15 minutes, and store the lease `jti` and expiry. A revoked session must not receive a new heartbeat or artifact authorization.

- [ ] **Step 5: Implement artifact manifest authorization**

Read only artifacts under `RDC_AUTH_ARTIFACT_ROOT`, verify their expected hash, bind the response to account/device/session/version/ABI/Android target, and return no artifact data without a valid lease and entitlement.

- [ ] **Step 6: Add deployment and secret-handling documentation**

Document TLS termination, database backup, signing-key rotation, artifact permissions, log redaction, and the rule that production secrets are injected by the deployment system rather than committed.

- [ ] **Step 7: Run server tests and commit**

Run: `cargo test --manifest-path authorization-service/Cargo.toml`.

Commit: `feat: add private authorization service`

---

### Task 4: Implement the Tauri authorization client

**Files:**
- Modify: `src-tauri/src/services/authorization.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` for the selected TLS/HTTP/crypto libraries
- Modify: `src/services/deviceService.ts`
- Modify: `src/types/index.ts`
- Test: `src-tauri/src/services/authorization.rs`
- Test: `src/services/authorization.test.ts`

**Interfaces:**
- Produces `AuthorizationClient<T: AuthTransport, S: SecureStore>`.
- Produces `register_client() -> Result<DeviceRegistration, AuthorizationError>`.
- Produces `acquire_session(request: SessionRequest) -> Result<AuthorizationSession, AuthorizationError>`.
- Produces `heartbeat(session_id: &str) -> Result<LeaseStatus, AuthorizationError>`.
- Produces `fetch_artifact(request: ArtifactRequest) -> Result<DecryptedArtifact, AuthorizationError>`.
- Produces Tauri commands `authorization_status`, `authorization_register`, `authorization_acquire_session`, `authorization_heartbeat`, `authorization_revoke_local`.
- Test fixtures define `FakeTransport::artifact_with_wrong_hash`, `FakeTransport::revoked_session`, `test_client`, `test_artifact_request`, and `test_session_request` in the test module; they never ship in the client.

- [ ] **Step 1: Write failing client tests with a fake transport**

```rust
#[tokio::test]
async fn client_refuses_artifact_when_manifest_hash_does_not_match_plaintext() {
    let transport = FakeTransport::artifact_with_wrong_hash();
    let client = test_client(transport);
    let result = client.fetch_artifact(test_artifact_request()).await;
    assert_eq!(result, Err(AuthorizationError::ArtifactIntegrityFailed));
}

#[tokio::test]
async fn client_does_not_start_a_new_session_after_revoke() {
    let transport = FakeTransport::revoked_session();
    let client = test_client(transport);
    assert_eq!(client.acquire_session(test_session_request()).await, Err(AuthorizationError::Revoked));
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml authorization::tests::client_refuses_artifact -- --exact`

Expected: FAIL because the transport/client implementation is missing.

- [ ] **Step 3: Implement TLS HTTP transport and signed lease verification**

Use TLS 1.3, include request nonce and device signature, verify server signature against the embedded public-key ring, enforce `aud`, `iss`, device/session/version and expiry, and never put tokens in command arguments or logs. Certificate pinning may be added only as a deployable configuration that still permits planned certificate rotation.

- [ ] **Step 4: Implement chunked AEAD decryption and cleanup**

Derive the per-request key from the X25519 exchange and session context, authenticate every chunk, stream to the destination only after manifest checks are available, delete partial files on any error, and zero/drop temporary key material as soon as the operation ends. The implementation must not persist a reusable master key.

- [ ] **Step 5: Expose structured status to the frontend**

Add `DeviceService.authorizationStatus()` and the corresponding actions. Show `serverUnreachable` separately from `leaseExpired`; a locally cached boolean cannot make a new protected operation ready.

- [ ] **Step 6: Run the four-suite gate and commit**

Commit: `feat: add server-authoritative authorization client`

---

### Task 5: Add the first real protected capability gate

**Files:**
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `qemu-center/src/main.rs` only if a signed capability handle must be passed to the CLI
- Modify: `src/pages/tracks/QemuTrackPanel.tsx`
- Modify: `src/services/deviceService.ts`
- Test: `src-tauri/src/services/qemu_presets.rs`, `src-tauri/src/services/qemu.rs`, `src/pages/tracks/QemuTrackPanel.test.tsx`

**Interfaces:**
- Produces `authorize_protected_operation(capability, context) -> Result<CapabilityLease, AuthorizationError>`.
- Protects `ProtectedPreset` around the existing QEMU preset create/upgrade path.
- Passes only an opaque one-time capability handle over an inherited pipe/stdin or an OS-protected local channel; never passes a bearer token as a command-line argument.
- Gate tests define `authorize_preset_for_test(status)` and `ready_lease_with(capabilities)` as local helpers over the Task 1 policy implementation.

- [ ] **Step 1: Write failing gate tests**

```rust
#[test]
fn qemu_preset_creation_is_rejected_without_a_ready_lease() {
    let result = authorize_preset_for_test(AuthorizationStatus::LeaseExpired);
    assert_eq!(result, Err("protected preset authorization required".into()));
}

#[test]
fn qemu_preset_creation_accepts_only_the_requested_capability() {
    let lease = ready_lease_with(&[ProtectedCapability::ProtectedArtifact]);
    assert!(authorize_lease(&lease, ProtectedCapability::ProtectedPreset).is_err());
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml qemu_presets::tests::qemu_preset_creation_is_rejected -- --exact`

Expected: FAIL because the preset path currently has no authorization gate.

- [ ] **Step 3: Implement the Rust-side gate**

Require the lease immediately before the protected operation, recheck expiry and capability, and return a structured authorization error before any image build, guest file write, or container mutation. Keep read-only diagnostics and ordinary control actions outside this first gate.

- [ ] **Step 4: Add frontend status and safe failure UX**

Disable only protected preset actions when authorization is unavailable, explain whether registration, renewal, or network access is needed, and preserve the user-entered form without logging sensitive material.

- [ ] **Step 5: Run the four-suite gate and commit**

Commit: `feat: gate qemu presets with server authorization`

---

### Task 6: Deliver an encrypted, session-bound core artifact

**Files:**
- Modify: `authorization-service/src/routes.rs`
- Modify: `authorization-service/src/crypto.rs`
- Modify: `src-tauri/src/services/authorization.rs`
- Create: `src-tauri/src/services/artifact_delivery.rs`
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `qemu-center/src/main.rs` only for the minimal one-time capability channel
- Test: server route/crypto tests, `src-tauri/src/services/artifact_delivery.rs`, `src-tauri/src/services/qemu_presets.rs`

**Interfaces:**
- Produces `prepare_artifact(artifact_id, target, ephemeral_public_key) -> SignedEncryptedArtifact` on the server.
- Produces `deliver_core_artifact(request) -> Result<ArtifactReceipt, AuthorizationError>` in the client.
- `ArtifactReceipt` contains only artifact ID, hash, target, session binding and cleanup status; it does not serialize plaintext or a reusable key.
- Delivery tests define `test_request()` with a unique temporary partial path, `deliver_with_corrupt_chunk(request)`, and `deliver_for_target(request, android_version, artifact_id)` as local helpers.

- [ ] **Step 1: Write failing delivery tests**

```rust
#[tokio::test]
async fn partial_artifact_download_is_deleted_after_authentication_failure() {
    let result = deliver_with_corrupt_chunk(test_request()).await;
    assert_eq!(result, Err(AuthorizationError::ArtifactIntegrityFailed));
    assert!(!test_request().partial_path.exists());
}

#[tokio::test]
async fn artifact_for_another_android_version_is_rejected_before_guest_write() {
    let result = deliver_for_target(test_request(), "android-14", "android-13-artifact").await;
    assert_eq!(result, Err(AuthorizationError::TargetMismatch));
}
```

- [ ] **Step 2: Run focused tests and observe the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml artifact_delivery::tests::partial_artifact -- --exact`

Expected: FAIL because encrypted artifact delivery does not exist.

- [ ] **Step 3: Implement signed manifest and chunked encryption on the server**

Generate a per-request data key, bind it to session/device/artifact/hash/target, encrypt chunks with unique nonces and authenticated associated data, and return the wrapped key only for the request's ephemeral public key. Reject expired/revoked leases before reading the artifact.

- [ ] **Step 4: Implement client verification, decryption and cleanup**

Verify the manifest signature and target before guest writes; authenticate and hash the complete plaintext; write only after all checks pass; remove encrypted partials, temporary keys and failed plaintext on every error path. Keep the artifact cache short-lived and unusable without a live lease.

- [ ] **Step 5: Connect delivery to the protected preset path**

The preset builder requests only the artifact IDs required for the selected profile. It must not download full proprietary bundles when the operation needs one component, and the server response must be recorded by hash/session ID rather than plaintext content.

- [ ] **Step 6: Run server tests, the four project suites, and commit**

Commit: `feat: deliver session-bound encrypted core artifacts`

---

### Task 7: Revocation, rotation, tamper tests, and rollout evidence

**Files:**
- Create: `authorization-service/tests/protocol.rs`
- Create: `src-tauri/tests/authorization_e2e.rs` if the existing test harness supports a local service
- Create: `docs/qa/2026-09-17-authorization-acceptance.md`
- Modify: `SECURITY.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Test: all client/server suites

**Interfaces:**
- Consumes the registered client, lease, artifact, and protected-preset flows from Tasks 1–6.
- Produces evidence for invalid signature, expired lease, wrong device, replayed nonce/JTI, clock rollback, revoked session, key rotation, corrupt chunk, partial download, copied installation, and patched frontend attempts.
- Integration fixtures define `provision_authorized_client`, `revoke_client`, `request_artifact`, `rotate_server_key`, and `request_with_key_id`; all use an isolated test database and generated keys.

Current progress: `authorization-service/tests/protocol.rs` now covers the
real router path for revoked artifact transfers and a restarted service using
a new signing `keyId`; deployment rotation and live tamper/copy acceptance
remain manual.

- [ ] **Step 1: Write failing protocol integration cases**

```rust
#[tokio::test]
async fn revoked_session_cannot_receive_a_new_artifact_handle() {
    let context = provision_authorized_client().await;
    revoke_client(&context).await;
    let response = request_artifact(&context).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rotated_server_key_accepts_new_key_and_rejects_unknown_key() {
    let context = provision_authorized_client().await;
    rotate_server_key(&context).await;
    assert!(request_with_key_id(&context, "next-key").await.is_ok());
    assert_eq!(request_with_key_id(&context, "attacker-key").await.unwrap_err(), ProtocolError::UnknownKey);
}
```

- [ ] **Step 2: Run the focused integration tests and observe the expected failures**

Run: `cargo test --manifest-path authorization-service/Cargo.toml --test protocol`

Expected: FAIL until revocation and rotation behavior is fully wired.

- [ ] **Step 3: Implement heartbeat revocation and key rotation**

Make revocation take effect on the next heartbeat, preserve only the documented public-key rotation window, reject unknown key IDs, and prevent local clock rollback from extending a lease.

- [ ] **Step 4: Execute the client tamper and copy tests**

Run the protected operation after removing the React authorization call, copying the installation directory to another device, replaying an old response, changing the manifest hash, and using an expired lease. The expected result is refusal before protected work begins; basic diagnostics remain available.

- [ ] **Step 5: Document deployment and security limits**

Record that local runtime plaintext can be observed by an administrator/root/debugger, that server-side execution is required for absolute protection of the highest-value logic, and that third-party assets retain their licenses.

- [ ] **Step 6: Run every required validation command and commit**

Run: `cargo test --manifest-path authorization-service/Cargo.toml`; `npx tsc --noEmit`; `npx vitest run`; `cargo test --manifest-path src-tauri/Cargo.toml`; `cargo test --manifest-path qemu-center/Cargo.toml`.

Commit: `docs: record authorization acceptance and threat limits`

---

### Task 8: Protect release metadata enrichment without breaking diagnostics

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Modify: `src-tauri/src/services/qemu_presets.rs`
- Modify: `src-tauri/src/services/qemu.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `authorization-service/README.md`
- Test: the corresponding Rust unit tests

**Acceptance:**

- [x] Version-independent details and restore use one explicit
  `targetAndroid=any` artifact.
- [x] Release builds obtain the details runner from the authorization service;
  if authorization is unavailable, only basic list rows are returned.
- [x] Details runner plaintext is removed from local staging and the guest on
  success and failure.
- [x] The downloaded plaintext artifact itself is worker-owned and removed
  after create, upgrade, restore, and metadata-enrichment operations, including
  error paths.
- [x] No release binary contains the embedded runner body.
- [x] Run the project validation gate and record the result.

### Task 9: Make the signing-key rotation window real in release configuration

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Modify: `authorization-service/README.md`
- Modify: `docs/2026-09-17-server-authoritative-core-delivery-design.md`
- Test: `src-tauri/src/services/authorization_client.rs`

**Acceptance:**

- [x] The client accepts a build-time `RDC_AUTH_PUBLIC_KEYS` ring containing
  the old and next public keys, selected by signed response `keyId`.
- [x] Duplicate IDs, empty entries, and malformed public keys fail closed.
- [x] The single-key environment variables remain a compatibility fallback.
- [ ] A production operator rehearsal rotates the server key in the documented
  order and confirms old/new client behavior.

### Task 10: Make release authorization configuration fail closed

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs`
- Modify: `docs/2026-09-17-runtime-memory-authorization-acceptance.md`
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Test: `src-tauri/src/services/authorization_client.rs`

**Acceptance:**

- [x] A pure configuration resolver rejects a missing service URL or missing public-key ring.
- [x] Malformed/duplicate public-key entries remain rejected before a transport or secure-store
  client is constructed.
- [x] A non-loopback HTTP service URL remains rejected; loopback HTTP remains a development-only
  exception.
- [x] The focused test and full required gate pass; production deployment rehearsal remains a
  separate manual item.

### Task 12: Make the release core-body scan repeatable

- [x] Add `scripts/verify-release-core.ps1` with explicit runner-body markers.
- [x] Run it against the current release executable and library.
- [x] Add it as a blocking step in `.github/workflows/windows-release.yml` after Tauri packaging.

### Task 11: Expand protocol tamper-boundary coverage

The registration/approval/lease/artifact happy path is covered by
`E-031-registration-and-artifact-protocol.md`. Add route-level negative assertions for the
same transfer so the automated evidence also covers wrong device binding, invalid chunk index,
wrong bearer/session, and client-side ciphertext tampering. Copying a live installation and
production offline/TLS/key-rotation rehearsals remain manual because they require separate
devices or deployment state.

- [x] **Step 1: Add focused negative assertions to the protocol fixture**
- [x] **Step 2: Run the protocol test and record the evidence**

---

### Task 13: Bind guest execution to a short-lived signed operation grant

The current implementation authorizes registration, leases and encrypted
artifact transfer, but a copied plaintext runner could still be invoked with a
hand-written request after a legitimate download. Close that boundary without
claiming absolute anti-reverse protection.

Implementation progress: the signed payload envelope, `/v1/execution-grants`
endpoint, Rust binding verifier, host request propagation, guest fail-closed
verifier, `publish-runner` key rendering path, and the server-side grant
consume boundary are implemented. The remaining acceptance work is
deployment/copy testing with the rendered artifact and a reachable real
authorization service.

- [x] **Step 1: Complete failing protocol and runner tests**

  Cover missing, expired, wrong-device, wrong-artifact, wrong-action and
  replayed execution grants. The runner must reject a request whose trusted
  signature does not verify; a public key supplied by the request is not trusted.
  Added regression coverage for missing/expired grants, signature tampering,
  wrong device, wrong action, wrong core artifact, request-nonce replay and
  one-time grant consume/replay rejection; the service and runner focused
  suites pass.

- [x] **Step 2: Add the server grant endpoint and signed claims**

  Issue a short-lived grant only for a live session with the required
  entitlement, bind it to the verified manifest hash and operation context,
  and consume its request nonce transactionally.

- [x] **Step 3: Enforce the grant in Rust and in the guest execution path**

  Request the grant immediately before upload, include only the signed envelope
  in the runner request, and make the guest verifier fail closed when the grant
  is absent or invalid. Prefer an existing guest crypto primitive; if the
  target image cannot verify the signature reliably, move the sensitive action
  behind a server-side execution API rather than adding an unauthenticated
  boolean check.

- [x] **Step 3a: Consume the grant before guest-side Docker work**

  POST the signed grant to a rendered server consume URL after local
  verification. The service must atomically reserve the grant JTI and return
  conflict on replay; transport errors and non-success responses must stop the
  operation before Docker work.

- [ ] **Step 4: Run tamper, copy and failure-cleanup acceptance**

  Verify that copying the runner without a fresh grant, changing its action or
  target, replaying a grant, and interrupting upload all fail before protected
  work. Keep administrator/root/debugger plaintext extraction documented as an
  unavoidable runtime limitation.

---

### Task 14: Make the production desktop release carry the authorization endpoint

The release workflow currently runs the Tauri build without
`RDC_AUTH_BASE_URL` or `RDC_AUTH_PUBLIC_KEYS`. That produces a binary with no
embedded runner, but it also prevents an authorized customer from downloading
the protected core. Treat the public endpoint and verifier key ring as required
non-secret release configuration, while keeping the server signing secret out
of the desktop job.

- [x] **Step 1: Document the release configuration contract**

  Use GitHub Actions repository variables for the public endpoint and verifier
  key ring; document that the release job must fail before compilation when
  either value is missing.

- [x] **Step 2: Add the release preflight and inherited build environment**

  Inject `RDC_AUTH_BASE_URL` and `RDC_AUTH_PUBLIC_KEYS` into the Windows release
  job and validate both before tests/build. Reject an accidentally present
  desktop signing secret in the same preflight.

- [x] **Step 3: Run the required project gate and review the workflow diff**

  Run the four project suites, `cargo fmt --check`, `git diff --check`, and
  verify that the workflow only references public repository variables and
  never a server signing secret. All required gates passed; the diff check
  reports only the repository's existing LF/CRLF normalization warnings.

---

### Task 15: Bind execution grants to the server-approved artifact workflow

The execution grant currently binds the artifact hash and operation context, but
the service does not independently constrain which published artifact may be
used for each protected workflow. A reversed client must not be able to ask the
service to sign an arbitrary published artifact for `preset_apply`,
`preset_restore`, or `preset_details`. Keep the policy server-authoritative and
also enforce it again at grant consumption.

- [x] **Step 1: Add a failing route-level policy test**

  A targeted runner artifact may be used only for `preset_apply`; the
  universal runner may be used only for `preset_restore` and `preset_details`.
  A generic or mismatched artifact must receive 403 and must not consume the
  request nonce.

- [x] **Step 2: Implement the smallest server-side policy**

  Validate the artifact/workflow pair during grant issuance and consumption.
  Keep artifact download behavior unchanged; this policy protects executable
  authorization and fails closed for unknown artifact IDs.

- [x] **Step 3: Re-run focused and full gates and record the evidence**

  Include the negative route test, Tauri/qemu tests, and a release-body scan.
  The focused and full gates passed, and the PowerShell release-body scanner
  returned clean for both release binaries after a compatibility fix. Production
  deployment, copy/tamper, and real service key rotation remain manual
  acceptance items.
