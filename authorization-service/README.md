# RDC Authorization Service

This is the private server-side authority for protected Redroid Device Center
capabilities. It is intentionally a separate crate: the Tauri client contains
only verification keys and the minimum protocol logic, while the signing
private key, entitlement database, revocation state, and artifact root remain
server-side.

The service fails closed when RDC_AUTH_SIGNING_KEY,
RDC_AUTH_DATABASE_URL, or RDC_AUTH_ARTIFACT_ROOT is missing. The signing key
is a base64url-no-pad encoded 32-byte Ed25519 secret and must be injected by
the deployment secret manager; it must never be committed or passed as a
command-line argument. TLS should terminate at the deployment's managed
edge/reverse proxy with TLS 1.3 enforced. `RDC_AUTH_BIND` is required to be a
literal loopback socket address (for example `127.0.0.1:8787` or `[::1]:8787`);
the service refuses wildcard, LAN, public, and hostname bindings so a
misconfigured plaintext listener cannot expose the authorization API. The
managed TLS edge must run on the same host. Cross-container deployment needs
a separately reviewed internal TLS or Unix-socket design; there is no
insecure non-loopback override.

Example local-only startup:

    RDC_AUTH_SIGNING_KEY=<base64url-32-byte-secret>
    RDC_AUTH_DATABASE_URL=./state/authorization.sqlite
    RDC_AUTH_ARTIFACT_ROOT=./state/artifacts
    RDC_AUTH_BIND=127.0.0.1:8787
    cargo run --manifest-path authorization-service/Cargo.toml

For a production desktop build, configure the same two non-secret values as
GitHub Actions repository variables named `RDC_AUTH_BASE_URL` and
`RDC_AUTH_PUBLIC_KEYS` (or inject them into an equivalent private release
pipeline) before building Tauri:

    $env:RDC_AUTH_BASE_URL = "https://auth.example.invalid"
    $env:RDC_AUTH_PUBLIC_KEYS = "auth-2026-01=<base64url-old-key>,auth-2026-02=<base64url-next-key>"
    npm run tauri build

The Windows release workflow fails before compilation when either value is
missing. The server signing secret is never set in the desktop build
environment; only the public endpoint and verifier key ring are inherited by
the Tauri compiler.
`auth.example.invalid` is an example value only; use the real deployment URL
in the private release pipeline.

For a signing-key rotation, release a client containing both the old and next
public keys, pause protected QEMU operations, switch
`RDC_AUTH_SIGNING_KEY_ID` and `RDC_AUTH_SIGNING_KEY` on the server to the next
key, and re-publish every runner artifact with the next execution public key
before resuming operations. A runner embeds the execution-grant verifier key;
switching only the service environment would make old runners reject new
grants. After the old client population and old runners have expired, release
a client containing only the next key. The client rejects duplicate or
malformed key-ring entries. The legacy single-key variables remain supported
for one-key deployments. See `docs/ops/authorization-key-rotation-runbook.md`
for the full maintenance-window procedure and rollback conditions.

Registration is two-phase: POST /v1/clients/register creates a pending
device challenge, then POST /v1/clients/register/complete proves possession
of the device signing key. An operator must approve the client and grant
capabilities before POST /v1/sessions can issue a lease. Session nonces are
stored transactionally and cannot be replayed.

The general artifact endpoint returns a signed, session/device/target-bound
manifest with a per-request X25519 server key and transfer metadata. The client
then fetches authenticated chunk endpoints; every chunk is encrypted with a
session-bound ChaCha20-Poly1305 key and is useless without the matching
ephemeral client secret. This encrypted path is used for ordinary artifact
delivery. The protected QEMU execution path is intentionally different:
`POST /v1/execution-grants/release` returns the small, already-authorized runner
over HTTPS so the guest can execute it without putting the runner in the
desktop binary or Windows staging area. The response is still plaintext to the
authorized guest process, so TLS protects it in transit but does not remove
the runtime guest-root/debugger boundary described below. The `/v1` control
plane also rejects request bodies larger than 64 KiB before JSON/business
processing; artifact chunks remain response-side and are not subject to this
control-plane limit.

For the QEMU protected preset path, render the runner with the active signing
public key and the HTTPS execution-grant consume URL first. The guest verifies
and consumes each execution grant against values embedded in this rendered
artifact; publishing the raw repository source would fail closed because it
still contains trust placeholders:

    $env:RDC_AUTH_EXECUTION_CONSUME_URL = "https://auth.example/v1/execution-grants/consume"
    cargo run --manifest-path authorization-service/Cargo.toml --bin rdc-auth-admin -- \
      artifact publish-runner qemu-guest-script 1 x86_64 android-14 \
      src-tauri/src/services/qemu_guest.py /srv/rdc-artifacts/qemu_guest-android14.py

Publish one artifact per supported Android target. The client downloads it
into a one-use OS temporary file, uploads it to the guest bundle, and removes
the local file after the operation. The guest necessarily has executable
plaintext while running; administrator/root/debugger extraction remains an
explicit threat-model limitation, so the highest-value rules should stay on
the service rather than in the runner.

The restore action uses a separate version-independent runner artifact. Publish
it with the literal target `any`:

    cargo run --manifest-path authorization-service/Cargo.toml --bin rdc-auth-admin -- \
      artifact publish-runner qemu-guest-script-universal 1 x86_64 any \
      src-tauri/src/services/qemu_guest.py /srv/rdc-artifacts/qemu_guest-universal.py

The `publish-runner` command reads `RDC_AUTH_SIGNING_KEY` and
`RDC_AUTH_EXECUTION_CONSUME_URL` only on the private administration host,
replaces the execution-key and consume-URL placeholders, writes the rendered
artifact, and publishes that path. The desktop build receives only the public
verifier key and consume endpoint inside the protected runner; it never
receives the signing secret.

Execution grants are also server-policy-bound to the published runner role:
`qemu-guest-script` may be issued only for `preset_apply`, while
`qemu-guest-script-universal` may be issued only for `preset_restore` or
`preset_details`. Unknown artifact/workflow pairs fail closed both when a grant
is issued and when it is consumed; a reversed client cannot repurpose another
published artifact by changing only the request action.

After receiving a grant, the desktop client signs the exact server-signed
payload with its DPAPI-protected device key and attaches `device_proof`. The
guest runner requires that field, and the consume endpoint verifies it against
the registered device public key before reserving the one-time JTI. Copying an
encrypted artifact or grant to another device therefore does not provide the
device proof needed to execute it. This still does not protect against a local
administrator, guest root, or debugger extracting plaintext during a legitimate
run.
