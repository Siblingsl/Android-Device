# E-035 — Per-operation execution grant boundary

Date: 2026-09-18

## Scope

Close the gap between authorizing an encrypted core download and authorizing
the execution of the plaintext guest runner.

## Evidence

- `authorization-service/src/crypto.rs` signs a base64url canonical payload
  containing device, session, client version, artifact ID/hash, workflow, VM,
  instance, expiry, JTI and nonce.
- `POST /v1/execution-grants` requires a live session with
  `protected-preset`, recomputes the published artifact hash, and atomically
  consumes the request nonce before issuing a two-minute grant.
- `POST /v1/execution-grants/consume` verifies the signed grant again,
  rechecks the session/client/entitlement/version and published artifact hash,
  then atomically consumes `execution-grant-jti:<jti>`; a second consume
  returns conflict.
- `src-tauri/src/services/authorization.rs` verifies the trusted key, issuer,
  audience, time window, lease capability and exact operation context.
- QEMU host orchestration attaches only the signed envelope to the runner
  request. The guest runner rejects a missing grant, verifies the envelope
  with the public key rendered into the protected artifact, and consumes the
  grant before Docker work; the key is never accepted from `request.json`.
- `rdc-auth-admin artifact publish-runner` renders the public verifier key into
  the runner, renders the HTTPS consume URL, and publishes the rendered file,
  preventing deployment of the raw placeholder source by accident.

## Automated checks

- Authorization-service focused crypto and route tests: passed, including
  published-artifact hash mismatch, request-nonce replay rejection and
  one-time execution-grant consume/replay rejection.
- Tauri focused execution-grant and runner-propagation tests: passed, including
  expiry, signature tampering, device binding and workflow-action mismatch.
- Python guest-runner tests: 16 passed, including tampered signatures, a grant
  bound to a different core artifact, tampering with the runner file itself,
  consume-service replay rejection, and the invariant that Docker is not
  constructed when grant consumption fails.
- A real local OpenSSL Ed25519 verification smoke test passed using a generated
  test key, the embedded public-key format, the signed payload, the runner
  consume request, fail-closed behavior when the consume service is unreachable,
  and the runner self-hash check.
- The optimized Tauri release build completed; `verify-release-core.ps1`
  reported clean for the desktop executable, library and MCP executable.

## Residual limitation

The guest now requires a reachable consume service before Docker work. A
captured still-valid grant can at most win the single atomic consume race; a
second submission is rejected. The rendered runner contains no client private
key or bearer credential, but it does require a reachable HTTPS endpoint.
Administrator/root/debugger access during a legitimate run can still observe
plaintext or patch the runner.

Real service deployment, rendered-artifact execution, grant replay and
tamper/copy drills remain manual acceptance items.
