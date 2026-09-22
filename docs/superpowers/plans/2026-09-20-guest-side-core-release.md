# Guest 侧核心交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove release-build `qemu_guest.py` plaintext from the Windows/Tauri staging path while preserving the existing server-authoritative, one-time online execution gate.

**Architecture:** The Tauri authorization layer obtains only signed execution grants. A small, non-secret `qemu_loader.py` is staged into the guest; it calls a new HTTPS artifact-release endpoint from inside the guest, verifies the returned hash, writes the protected runner only inside a short-lived guest directory, and starts it. The protected runner still calls the existing consume endpoint, so a release response is not an offline execution credential.

**Tech Stack:** Rust/Tauri services, Rust `authorization-service` with Axum and SQLite, Rust `qemu-center`, Python stdlib guest loader/runner, existing Ed25519 grants and SHA-256 artifact checks.

**Spec:** `docs/superpowers/specs/2026-09-20-guest-side-core-release-design.md`

## Global Constraints

- Do not place `qemu_guest.py` plaintext in Windows temp, `qemu-center/state/presets`, argv, logs, or release binaries.
- Keep `/v1/execution-grants/consume` as the one-time execution gate; release prefetch must not consume the grant.
- Service-side artifact, grant, device proof, session, entitlement, client version, VM, instance, action, expiry, and hash checks remain fail closed.
- HTTP is allowed only for loopback development; production release traffic requires HTTPS.
- Guest-side plaintext during legitimate execution and guest-root/host-admin extraction remain explicit out-of-scope boundaries.
- Existing user changes and unrelated dirty files must be preserved.
- Backend changes are authorized by the user’s request, but every phase must pass the project’s four required verification commands before claiming completion.

## Review Focus

- A release response with a valid-looking grant but an altered artifact body must fail before Docker starts; test in Task 2 and Task 3.
- A release request must not consume the JTI, while the subsequent runner consume must remain one-time; test in Task 2 and Task 4.
- A missing release URL or public-key ring in a release build must fail closed rather than use the old local script; test in Task 3.
- A failed or interrupted loader must remove the guest core and request context; test in Task 4.
- The Rust workflow result must contain no local core path and no stale plaintext cleanup fallback; test in Task 3 and the release scan in Task 5.

---

### Task 1: Lock the service protocol with failing tests

**Files:**
- Modify: `authorization-service/src/routes.rs` around the router, execution-grant consume handler, artifact helpers, and route tests.
- Test: `authorization-service/src/routes.rs` inline tests.

**Interfaces:**
- Consumes: existing `SignedExecutionGrant`, `ExecutionAuthorizationReceiptClaims`, `AuthStore`, `safe_artifact_path`, and `sha256_file`.
- Produces: `POST /v1/execution-grants/release`, `ReleaseExecutionGrantRequest`, `SignedArtifactRelease`, and a shared validation function whose release path does not consume the grant reservation.

- [ ] **Step 1: Add the response/request types and failing route tests.**

  Add the serde shapes below near the existing consume request types:

  ```rust
  #[derive(Debug, Serialize, Deserialize)]
  pub struct ReleaseExecutionGrantRequest {
      pub grant: SignedExecutionGrant,
  }

  #[derive(Debug, Serialize)]
pub struct SignedArtifactRelease {
    pub artifact_id: String,
    pub artifact_sha256: String,
      pub artifact_size_bytes: u64,
      pub content_base64: String,
  }
  ```

  Add tests named `artifact_release_rejects_invalid_grant_without_content`, `artifact_release_returns_matching_content_hash`, `artifact_release_does_not_consume_execution_jti`, `artifact_release_rejects_revoked_entitlement`, and `artifact_release_is_not_cacheable`. The tests must create a published artifact, obtain a real signed grant using the existing test helpers, attach the correct device proof where needed, call the new route, decode `content_base64`, and assert the exact artifact bytes. The response must not contain an execution authorization receipt because release does not consume the JTI.

- [ ] **Step 2: Run the focused service tests and verify they fail for the missing route.**

  Run:

  ```powershell
  cargo test --manifest-path authorization-service/Cargo.toml artifact_release -- --nocapture
  ```

  Expected: compile/test failure because the route and handler do not exist yet.

- [ ] **Step 3: Implement a shared non-consuming grant validation function.**

  Extract the checks currently performed in `consume_execution_grant` through artifact hash validation into a helper with this exact shape:

  ```rust
  fn validate_execution_grant_for_artifact(
      state: &AppState,
      grant: &SignedExecutionGrant,
      now: i64,
  ) -> Result<(ExecutionGrantClaims, ArtifactRecord, PathBuf), ApiError>
  ```

  The helper must verify the trusted signature, issuer/audience, all required claims, current session, approved client, device proof, client version, both entitlements, artifact/action policy, safe artifact path, current SHA-256, and expiry. It must not call either `consume_nonce` for `execution-grant-jti:*` or the request nonce reservation.

- [ ] **Step 4: Implement the release handler and route.**

  Add `.route("/v1/execution-grants/release", post(release_execution_grant))`. The handler must call the helper, read exactly the validated artifact bytes, and return URL-safe base64 content plus exact size/hash. It must not build or return an execution authorization receipt. Add `Cache-Control: no-store` through the existing middleware and cap the artifact at `512 * 1024` bytes with a fail-closed `artifact_too_large` response.

- [ ] **Step 5: Re-run the focused tests and commit the protocol phase.**

  Run:

  ```powershell
  cargo test --manifest-path authorization-service/Cargo.toml artifact_release -- --nocapture
  cargo test --manifest-path authorization-service/Cargo.toml execution_grant -- --nocapture
  ```

  Expected: PASS. Commit:

  ```powershell
  git add authorization-service/src/routes.rs authorization-service/src/crypto.rs
  git commit -m "feat: add guest-side protected artifact release"
  ```

### Task 2: Add the guest loader and bind it to the release response

**Files:**
- Create: `src-tauri/src/services/qemu_loader.py`.
- Create: `src-tauri/src/services/test_qemu_loader.py`.
- Modify: `src-tauri/src/services/test_qemu_guest.py` for the consume-ordering regression.

**Interfaces:**
- Consumes: `POST /v1/execution-grants/release`, existing grant fields, existing `consume_execution_grant`, and `EXECUTION_AUTHORIZATION_ROOT`.
- Produces: `load_protected_runner(request_path, work_dir)`, `release_core(request)`, and a guest-only temporary runner lifecycle.

- [ ] **Step 1: Write loader tests for the security contract.**

  Mock `http.client.HTTPSConnection` and assert these cases: release HTTP 403 raises without creating a core; a response whose `artifact_sha256` differs from the grant raises; a response whose decoded content hash differs raises; a response over `512 * 1024` bytes raises; and a successful response creates a mode-0600 core beneath the supplied work directory and returns its path. The test must assert the grant payload is sent in JSON body and never appears in the subprocess argv.

- [ ] **Step 2: Run the loader tests to verify they fail.**

  Run:

  ```powershell
  python -m unittest src-tauri/src/services/test_qemu_loader.py -v
  ```

  Expected: FAIL because `qemu_loader.py` is not present.

- [ ] **Step 3: Implement the minimal stdlib loader.**

  Define build-time placeholders `EXECUTION_RELEASE_URL` and `EXECUTION_GRANT_PUBLIC_KEYS` (a `key_id=base64url-public-key` ring); reject unresolved placeholders and non-HTTPS non-loopback URLs. Read the request file, make one `POST` request with `Cache-Control: no-store`, limit response bytes before JSON parsing, decode URL-safe base64, compare `sha256(content)` with both response and grant claim, create the guest-only core with `O_CREAT|O_EXCL` and `0o600`, and return the core path. Use `try/finally` to unlink the core and loader-created request context.

- [ ] **Step 4: Change the protected runner to require online consume after release.**

  Do not weaken the runner’s existing online consume. In `qemu_guest.py` retain:

  ```python
  claims = verify_execution_grant(request, workflow, request.get("vm", ""), expected_instance)
  if action == "authorize":
      receipt = consume_execution_grant(grant)
      write_execution_authorization_marker(request, claims, receipt)
      return
  consume_execution_grant(grant)
  ```

  Add a test that patches `consume_execution_grant` and proves it is called before `details`, `build`, `seed`, `restore`, and `activate` work.

- [ ] **Step 5: Run Python tests and commit the guest loader phase.**

  Run:

  ```powershell
  python -m unittest src-tauri/src/services/test_qemu_loader.py src-tauri/src/services/test_qemu_guest.py -v
  ```

  Expected: PASS. Commit:

  ```powershell
  git add src-tauri/src/services/qemu_loader.py src-tauri/src/services/test_qemu_loader.py src-tauri/src/services/qemu_guest.py src-tauri/src/services/test_qemu_guest.py
  git commit -m "feat: fetch protected runner inside guest"
  ```

### Task 3: Remove Tauri plaintext download and switch Rust staging to loader-only

**Files:**
- Modify: `src-tauri/src/services/authorization_client.rs` around `AuthorizedCoreArtifact`, `AuthorizedCoreWorkflow`, and `runtime_download_core_artifact_with_execution_grants`.
- Modify: `src-tauri/src/commands/mod.rs` around `qemu_redroid_create`, `qemu_redroid_upgrade`, `qemu_redroid_restore`, and `qemu_redroid_list`.
- Modify: `src-tauri/src/services/qemu.rs` and `src-tauri/src/services/qemu_presets.rs` to remove `core_script: Option<PathBuf>` from protected release paths.
- Modify: `src-tauri/src/services/authorization_client.rs` tests and `src-tauri/src/services/qemu_presets.rs` tests.

**Interfaces:**
- Consumes: `AuthorizedCoreArtifact { execution_grant }`, `AuthorizedCoreWorkflow { execution_grants }`, and `qemu_loader.py` embedded by qemu-center.
- Produces: protected operations that create only request/grant files and never call `download_artifact_to`.

- [ ] **Step 1: Add failing Rust assertions for the new result shape and no-temp behavior.**

  Replace tests that assert a `PathBuf` with tests that assert only grants are returned. Add a test around the staging helper that scans the work directory after grant preparation and asserts `qemu_guest.py` is absent; add a source-level regression test that `runtime_download_core_artifact_with_execution_grants` does not call `download_artifact_with_session`.

- [ ] **Step 2: Run focused Rust tests to expose old path dependencies.**

  Run:

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml authorization_client::tests -- --nocapture
  cargo test --manifest-path src-tauri/Cargo.toml qemu_presets::tests -- --nocapture
  ```

  Expected: FAIL/compile errors showing every caller that still expects `path`.

- [ ] **Step 3: Change authorization results to grants-only.**

  Remove `CORE_SCRIPT_TEMP_PREFIX`, stale plaintext cleanup, `runtime_download_core_artifact`, and the `download_artifact_with_session` call from the execution-grant workflow. Keep the existing session acquisition and manifest/hash lookup only as server-side grant issuance inputs; the returned structs contain no path or artifact bytes.

- [ ] **Step 4: Stage loader and request only.**

  Update `Guest::upload_with_core` to `Guest::upload_loader`, writing the loader source from `include_str!("qemu_loader.py")` into the local tar staging directory. Keep grant JSON in a `0600` local file only long enough to upload; invoke `sudo python3 <remote>/qemu_loader.py <remote>/request.json`. Do not put grant JSON into an argv string; preserve the existing base64 request upload helper.

- [ ] **Step 5: Update all protected command callers.**

  `commands/mod.rs` must serialize only the signed grants into request JSON, remove `DownloadedCoreCleanup`, and pass no path into `qemu::redroid_*` or `qemu_presets::*`. Keep cleanup of request/grant/loader files in both local and guest staging directories. The non-protected debug fallback must not be reachable from release protected commands.

- [ ] **Step 6: Run focused Rust tests and commit the client/staging phase.**

  Run:

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml authorization_client::tests -- --nocapture
  cargo test --manifest-path src-tauri/Cargo.toml qemu_presets::tests -- --nocapture
  cargo test --manifest-path src-tauri/Cargo.toml commands::tests -- --nocapture
  ```

  Expected: PASS. Commit:

  ```powershell
  git add src-tauri/src/services/authorization_client.rs src-tauri/src/services/qemu.rs src-tauri/src/services/qemu_presets.rs src-tauri/src/commands/mod.rs
  git commit -m "refactor: keep protected core out of tauri staging"
  ```

### Task 4: Build and execute the loader from Tauri QEMU staging

**Files:**
- Modify: `src-tauri/src/services/qemu_presets.rs` and `src-tauri/src/services/qemu_loader.py`.
- Modify: `src-tauri/build.rs` so release configuration is rendered at compile time and unresolved placeholders do not enter the binary.
- Keep: `qemu-center/src/main.rs` host-side grant/receipt verification; it does not stage the protected runner.
- Modify: release build configuration that currently sets `RDC_AUTH_PUBLIC_KEYS`, adding `RDC_AUTH_EXECUTION_RELEASE_URL`.

**Interfaces:**
- Consumes: loader source, release endpoint, grant-only request.
- Produces: fail-closed Tauri QEMU staging behavior with no embedded protected runner.

- [ ] **Step 1: Add failing Tauri staging tests.**

  Add tests asserting a protected staging bundle contains `qemu_loader.py` and request data but not `qemu_guest.py` or a known protected-runner marker; missing build configuration must fail closed.

- [ ] **Step 2: Run the focused Tauri staging tests and verify failure.**

  Run:

  ```powershell
  cargo test --manifest-path src-tauri/Cargo.toml qemu_presets::tests -- --nocapture
  ```

  Expected: FAIL before the new source/config path exists.

- [ ] **Step 3: Embed only the loader and render build-time configuration.**

  Use `build.rs` plus `option_env!("RDC_AUTH_EXECUTION_RELEASE_URL")` and the existing `RDC_AUTH_PUBLIC_KEYS` ring. Refuse to create a protected bundle if either is missing. The rendered loader may contain public keys and endpoint only; tests must assert it contains no `qemu_guest.py` source marker.

- [ ] **Step 4: Execute the loader with the existing guest command boundary.**

  Change the staging command from `sudo python3 .../qemu_guest.py` to `sudo python3 .../qemu_loader.py`, preserve the request file path, timeout, output contract, and cleanup. Ensure loader stdout/stderr never prints grant payload, device proof, artifact content, or receipt payload.

- [ ] **Step 5: Update release build documentation and tests.**

  Document `RDC_AUTH_EXECUTION_RELEASE_URL=https://auth.example/v1/execution-grants/release` as the production-shaped example beside the existing public-key configuration. Add a fail-closed release test for unset URL and a positive debug/test configuration path.

- [ ] **Step 6: Run Tauri and qemu-center tests and commit.**

  Run:

  ```powershell
  cargo test --manifest-path qemu-center/Cargo.toml -- --nocapture
  ```

  Expected: PASS. Commit:

  ```powershell
  git add qemu-center/src qemu-center/README.md .github/workflows/windows-release.yml
  git commit -m "feat: make qemu-center fetch protected core in guest"
  ```

### Task 5: Remove stale plaintext paths, verify release artifacts, and update handoff

**Files:**
- Modify: `scripts/verify-release-core.ps1` to scan for protected-runner source and reject old staging names.
- Modify: `docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md` to reference this phase and its stronger staging boundary.
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md` with a new evidence entry only after verification completes.
- Create: `work/runtime-core-protection-20260917/evidence/E-072-guest-side-core-release-20260920.md`.

**Interfaces:**
- Consumes: all previous tasks and the project’s four required verification commands.
- Produces: evidence-backed release scan and a clearly stated manual-verification boundary.

- [ ] **Step 1: Add failing release-scan checks.**

  Extend the script to fail when release sources or binaries contain the protected runner marker, when `qemu_guest.py` is copied into a release staging bundle, or when the loader endpoint/public-key configuration is absent.

- [ ] **Step 2: Run the release scan before final verification.**

  Run:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/verify-release-core.ps1
  ```

  Expected: it reports the old plaintext path until all stale callers and artifacts are removed.

- [ ] **Step 3: Implement scan and documentation changes.**

  Keep the scan narrow: inspect only release inputs and staging directories in scope; do not delete user files or clean unrelated worktree artifacts. Record exact paths and hashes in the evidence file.

- [ ] **Step 4: Run all required project gates.**

  Run:

  ```powershell
  npx tsc --noEmit
  npx vitest run
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo test --manifest-path qemu-center/Cargo.toml
  cargo test --manifest-path authorization-service/Cargo.toml
  powershell -ExecutionPolicy Bypass -File scripts/verify-release-core.ps1
  git diff --check
  ```

  Expected: all commands PASS. Any real Tauri/guest walkthrough remains explicitly `待人工确认`, not marked green by automated tests.

- [ ] **Step 5: Record evidence and commit the documentation phase.**

  Evidence must include: no Windows plaintext core path, loader-only staging, release route negative/positive tests, one-time consume ordering, cleanup tests, and the manual checks still pending. Then commit:

  ```powershell
  git add scripts/verify-release-core.ps1 docs/superpowers/specs/2026-09-17-server-authoritative-core-delivery-design.md docs/AI-HANDOFF-NEXT-STEPS.md work/runtime-core-protection-20260917/evidence/E-072-guest-side-core-release-20260920.md
  git commit -m "docs: record guest-side protected core verification"
  ```

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-guest-side-core-release.md`. Please review the plan. Does it capture what you want?
