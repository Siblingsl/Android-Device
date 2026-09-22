# Authorization Service Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent protected authorization responses from being cached, bound in-memory artifact transfers from growing without limit, and accidental public plaintext listeners from exposing the service.

**Architecture:** Apply a small Axum middleware to the `/v1` router so lease, manifest, chunk, and error responses are marked non-cacheable. Give `AppState` a process-local transfer limit; prune expired entries before admission and return a stable 503 error when the limit is reached. Validate the service bind address before opening a listener and accept only literal loopback socket addresses, keeping plaintext HTTP behind the same-host TLS edge.

**Tech Stack:** Rust 2021, Axum 0.8, Tokio, existing `authorization-service` route/store tests.

**Spec:** `docs/superpowers/specs/2026-09-17-authorization-service-hardening-design.md`

## Global Constraints

- Keep service signing keys, entitlement state, and artifact plaintext server-side.
- Keep the existing device/session/manifest/chunk bindings unchanged.
- Do not change the QEMU live state or add a client-side offline fallback.
- The default transfer limit is exactly 128; tests may inject a smaller limit.
- `RDC_AUTH_BIND` must be a literal loopback socket address; non-loopback and hostname values fail before binding.

---

### Task 1: Add no-store response headers

**Files:**
- Modify: `authorization-service/src/routes.rs`
- Test: `authorization-service/src/routes.rs` route tests

**Interfaces:**
- Consumes: existing `router(AppState)` and Axum `Response`.
- Produces: `/v1` responses with `Cache-Control: no-store` and `Pragma: no-cache`.

- [x] **Step 1: Write the failing test**

Add a route test that creates a valid session and asserts:

```rust
assert_eq!(
    response.headers().get("cache-control").unwrap(),
    "no-store"
);
assert_eq!(response.headers().get("pragma").unwrap(), "no-cache");
```

- [x] **Step 2: Run the test and verify it fails**

Run: `cargo test --manifest-path authorization-service/Cargo.toml routes::tests::protected_responses_are_not_cacheable -- --exact`

Expected: FAIL because the current response has no cache-control header.

- [x] **Step 3: Write the minimal middleware**

Add an Axum middleware that runs `next.run(request).await`, inserts the two static headers into the response, and attach it with `middleware::from_fn` to the `/v1` router.

- [x] **Step 4: Run the focused test**

Run: `cargo test --manifest-path authorization-service/Cargo.toml routes::tests::protected_responses_are_not_cacheable -- --exact`

Expected: PASS.

### Task 2: Bound temporary artifact transfers

**Files:**
- Modify: `authorization-service/src/routes.rs`
- Test: `authorization-service/src/routes.rs` route tests

**Interfaces:**
- Consumes: `AppState::new`, `prepare_artifact`, existing `transfers` map.
- Produces: `AppState::with_transfer_limit(usize)` for tests, default limit 128, and HTTP 503 with code `transfer_capacity_exhausted` when full.

- [x] **Step 1: Write the failing route test**

Construct a test state with `with_transfer_limit(1)`, complete one valid prepare request, then send a second valid prepare request with another ephemeral key and assert:

```rust
assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
let body: serde_json::Value = response_json(second).await;
assert_eq!(body["code"], "transfer_capacity_exhausted");
```

- [x] **Step 2: Run the test and verify it fails**

Run: `cargo test --manifest-path authorization-service/Cargo.toml routes::tests::transfer_capacity_is_enforced_before_new_transfer -- --exact`

Expected: FAIL because the current service accepts both transfers.

- [x] **Step 3: Implement admission and pruning**

Add `max_active_transfers: usize` to `AppState`, make `new` use `128`, add `with_transfer_limit`, and prune expired entries before checking the limit. Return `ApiError::service_unavailable("transfer_capacity_exhausted", "artifact transfer capacity is exhausted")` before inserting a new `ArtifactTransfer`.

- [x] **Step 4: Add expiry-pruning coverage**

Use a short-lived transfer fixture or direct state setup to confirm an expired entry is removed before a new prepare is admitted. Keep the assertion on the new transfer succeeding, not on private map size.

- [x] **Step 5: Run the service tests**

Run: `cargo test --manifest-path authorization-service/Cargo.toml`

Expected: all existing and new tests pass.

### Task 3: Final verification and evidence

**Files:**
- Modify: `docs/AI-HANDOFF-NEXT-STEPS.md`
- Modify: `docs/2026-09-17-runtime-memory-and-core-delivery-report.md`
- Create: `work/runtime-core-protection-20260917/evidence/E-026-authorization-service-hardening.md`

- [x] **Step 1: Run the project gates**

Run:

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path qemu-center/Cargo.toml
cargo test --manifest-path authorization-service/Cargo.toml
git diff --check
```

- [x] **Step 2: Record the exact results**

Record the observed counts, note that the change is server-side only, and leave production TLS/account/secret-manager and real-device checks marked manual.

### Task 4: Reject non-loopback plaintext listeners

**Files:**
- Modify: `authorization-service/src/main.rs`
- Modify: `authorization-service/README.md`
- Test: `authorization-service/src/main.rs` unit tests

**Interfaces:**
- Consumes: `RDC_AUTH_BIND` as a string before `TcpListener::bind`.
- Produces: `validate_loopback_bind(&str) -> Result<(), String>` and a startup guard that accepts `127.0.0.1:port` / `[::1]:port` only.

- [x] **Step 1: Write the failing tests**

Add unit tests for the pure bind validator:

```rust
assert!(validate_loopback_bind("127.0.0.1:8787").is_ok());
assert!(validate_loopback_bind("[::1]:8787").is_ok());
assert!(validate_loopback_bind("0.0.0.0:8787").is_err());
assert!(validate_loopback_bind("192.0.2.10:8787").is_err());
assert!(validate_loopback_bind("localhost:8787").is_err());
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `cargo test --manifest-path authorization-service/Cargo.toml --bin rdc-authorization-service tests::accepts_literal_loopback_socket_addresses -- --exact`

Expected: FAIL because the validator does not exist yet.

- [x] **Step 3: Implement the minimal startup guard**

Parse `bind` as `std::net::SocketAddr`, reject parse failures and any address whose IP is not loopback, and call the validator before constructing the listener. Return a concise configuration error without logging secrets.

- [x] **Step 4: Document the deployment contract**

Update the local and production examples to use a literal loopback bind and state that the managed TLS 1.3 edge must run on the same host. Do not add an insecure non-loopback override.

- [x] **Step 5: Run the focused test and service tests**

Run:

```powershell
cargo test --manifest-path authorization-service/Cargo.toml --bin rdc-authorization-service tests::accepts_literal_loopback_socket_addresses -- --exact
cargo test --manifest-path authorization-service/Cargo.toml --bin rdc-authorization-service tests::rejects_non_loopback_and_hostname_bindings -- --exact
cargo test --manifest-path authorization-service/Cargo.toml
```

Expected: the validator tests and all existing route/crypto/store tests pass.

### Task 5: Bound authorization control-plane request bodies

**Files:**
- Modify: `authorization-service/src/routes.rs`
- Test: `authorization-service/src/routes.rs` route tests
- Modify: `docs/superpowers/specs/2026-09-17-authorization-service-hardening-design.md`

**Interfaces:**
- Consumes: JSON control-plane requests under `/v1`.
- Produces: a `64 KiB` maximum request body before JSON extraction and business logic.

- [x] **Step 1: Write the failing route test**

Send a syntactically valid JSON body larger than `64 KiB` to a `/v1` route and assert
`413 Payload Too Large`. The test must use a body that would otherwise fail later in
the handler, proving the request was rejected by the router boundary.

- [x] **Step 2: Run the focused test and observe the expected failure**

Run: `cargo test --manifest-path authorization-service/Cargo.toml routes::tests::control_plane_request_body_limit_is_enforced -- --exact`

Expected: FAIL because the router has no explicit control-plane body limit.

- [x] **Step 3: Add the minimal router layer**

Apply Axum's `DefaultBodyLimit::max(64 * 1024)` to the `/v1` router. Do not add a
client-side fallback or change artifact chunk sizing.

- [x] **Step 4: Run the focused service tests and project gates**

Run the focused route test, the full authorization-service suite, then the required
TypeScript, Vitest, Tauri, qemu-center, formatting, and diff checks.
