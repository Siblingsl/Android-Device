# E-067 — Secret-free authorization key-rotation rehearsal

Date: 2026-09-20  
Scope: code-level authorization and release-artifact rehearsal only

## Result

The protected execution path passed a local old/new signing-authority rehearsal without
starting Docker or QEMU and without placing any signing secret in a script argument, source
file, or captured output.

The focused protocol regression covers one persistent authorization store across a simulated
service restart:

- the first execution grant and receipt use `auth-old`;
- the consumed old grant replays as `409 Conflict`;
- after reopening the same store with `auth-next`, a new grant and receipt use `auth-next`;
- the new receipt verifies with the next authority and fails verification with the retired one;
- the old grant is rejected by the restarted service before any protected operation.

The runner-generation regression renders the same placeholder source for both authorities and
asserts that each output contains only its own key ID/public key, the configured HTTPS consume
URL, and no unresolved execution placeholders.

## Commands and results

The contract check was first run before the rehearsal script existed and failed closed with a
missing-script error. After implementation:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-verify-auth-rotation.ps1
rotation rehearsal contract passed
```

Focused checks:

```text
cargo test --manifest-path authorization-service/Cargo.toml --test protocol restarting_with_next_signing_key_keeps_execution_grants_bound_to_their_authority
1 passed; 0 failed

cargo test --manifest-path authorization-service/Cargo.toml --bin rdc-auth-admin runner_rendering_replaces_trusted_key_and_consume_url_placeholders
1 passed; 0 failed
```

Authorization-service full suite:

```text
cargo test --manifest-path authorization-service/Cargo.toml
23 library + 2 admin + 2 startup + 4 protocol tests passed; 0 failed
```

Release rehearsal:

```text
$paths=@('src-tauri/target/release/redroid-device-center.exe','src-tauri/target/release/redroid_device_center_lib.dll','src-tauri/target/release/rdc-mcp.exe','qemu-center/target/release/qemu-center.exe'); & .\scripts\verify-auth-rotation.ps1 -BinaryPath $paths
clean: redroid-device-center.exe
clean: redroid_device_center_lib.dll
clean: rdc-mcp.exe
clean: qemu-center.exe
rotation rehearsal passed
```

The reusable entry point is [`scripts/verify-auth-rotation.ps1`](../../../scripts/verify-auth-rotation.ps1),
with its fail-closed contract check in [`scripts/test-verify-auth-rotation.ps1`](../../../scripts/test-verify-auth-rotation.ps1).
The Windows release workflow now runs the authorization-service suite and the contract check
before packaging, then runs this rehearsal against the three release binaries after the NSIS
build. The release job exposes only `RDC_AUTH_BASE_URL` and `RDC_AUTH_PUBLIC_KEYS`; it does not
provide `RDC_AUTH_SIGNING_KEY`.

## What this does not prove

This is not production acceptance. The following remain manual deployment gates:

- TLS termination and certificate/hostname configuration;
- secret-manager injection, access control, and rotation audit logs;
- real account approval and entitlement administration;
- a cross-device copy/tamper/replay exercise against the deployed service;
- re-publishing the production runner during a dual-public-key window;
- live guest execution, root/debugger extraction, and plaintext exposure during an authorized run.

The test authorities use deterministic fixture keys only. No production key, account credential,
or endpoint was used. The repository still must not claim absolute anti-reverse protection: the
design makes the client and copied artifact insufficient for server-authorized operation, while
an administrator/root/debugger can still inspect code that is legitimately decrypted in memory.
