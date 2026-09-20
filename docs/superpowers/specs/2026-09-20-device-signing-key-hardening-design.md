# Device signing key hardening design

## Goal

Make the client proof key non-exportable on supported Windows installations so a
copied client binary, copied app-data directory, or copied authorization
registration cannot authenticate from another machine. Keep the current DPAPI +
Ed25519 path available for existing installations and for systems where the
hardware-backed provider is unavailable, but expose the resulting security
level instead of silently treating both paths as equivalent.

## Security model

- The authorization service remains the trust anchor. The client never receives
  the server signing secret or a long-lived artifact decryption key.
- New Windows installations first try the Microsoft Platform Crypto Provider
  with an ECDSA P-256 signing key. The private key is created in the provider,
  never exported, and only the public SEC1 key is sent to the service.
- The provider is opened as a current-user key by default. If TPM/VBS support is
  available, the implementation requests VBS protection; deployment can require
  that mode and reject software-only fallback for high-value accounts.
- If the platform provider cannot create the key, the client falls back to the
  current DPAPI-protected Ed25519 key only when policy permits it. The server
  stores the declared algorithm with the client registration and verifies the
  matching signature format.
- A copied public key, lease, encrypted artifact, or execution grant is still
  insufficient without the private key and a fresh one-time server check.
- This does not prevent a privileged attacker on the original machine from
  asking the legitimate client or key provider to sign while it is running.

## Protocol

Add `client_key_algorithm` to registration and persist it with the client:

- `ed25519-dpapi-v1`: existing 32-byte public key and 64-byte Ed25519
  signatures over canonical JSON bytes.
- `ecdsa-p256-cng-v1`: 65-byte uncompressed SEC1 public key and 64-byte raw
  `r || s` ECDSA signature over the SHA-256 prehash of canonical JSON bytes.

Registration, session, heartbeat, and device-proof verification all dispatch on
the stored algorithm. The server rejects an algorithm/key-format mismatch; it
does not infer the algorithm from attacker-controlled signature length.

## Key lifecycle

1. On first install, attempt to open/create a named P-256 key in the Platform
   Crypto Provider. The key name and public key are stored as metadata, while
   the private key remains inside CNG.
2. Export only the public blob, convert it to SEC1 form, and register it with
   `client_key_algorithm=ecdsa-p256-cng-v1`.
3. On every proof, hash the canonical payload with SHA-256 and call
   `NCryptSignHash`; the client API must not expose private key bytes.
4. On restart, reopen the named key and compare its public key with stored
   metadata. A mismatch is corruption and must not silently generate a new
   identity.
5. Existing DPAPI identities remain Ed25519 until an explicit re-registration
   migration. No automatic rotation may invalidate a currently approved client.

## References

- [NCryptCreatePersistedKey](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptcreatepersistedkey)
- [How Windows uses the TPM](https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/how-windows-uses-the-tpm)
- [CNG key storage providers](https://learn.microsoft.com/en-us/windows/win32/seccertenroll/cng-key-storage-providers)

## Acceptance criteria

- The production Windows path never serializes or returns a CNG private key.
- A copied CNG key name, public key, registration record, lease, grant, and
  encrypted artifact fail on a different Windows installation.
- Existing Ed25519 registrations continue to work unchanged.
- The server rejects wrong algorithm, malformed SEC1 key, malformed raw
  signature, prehash mismatch, and public-key replacement attempts.
- Tests cover both algorithm branches, registration persistence, key mismatch,
  and fail-closed fallback policy. Real TPM/VBS availability remains a manual
  acceptance item.
