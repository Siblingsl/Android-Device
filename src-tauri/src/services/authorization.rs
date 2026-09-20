//! Server-issued authorization contracts and local verification.
//!
//! This module deliberately verifies values; it does not mint leases. The
//! signing private key stays in the authorization service and is never part
//! of the desktop client.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fmt;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

const EXPECTED_ISSUER: &str = "rdc-auth";
const EXPECTED_AUDIENCE: &str = "rdc-client";
const MAX_CLOCK_SKEW_SECS: i64 = 300;
pub const ARTIFACT_CHUNK_SIZE: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectedCapability {
    ProtectedPreset,
    ProtectedArtifact,
    ProtectedAlgorithm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKeyAlgorithm {
    Ed25519DpapiV1,
    EcdsaP256CngV1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationStatus {
    NotConfigured,
    NotRegistered,
    AuthenticationRequired,
    LeaseExpired,
    ServerUnreachable,
    ClientOutdated,
    BindingMismatch,
    ArtifactIntegrityFailed,
    Revoked,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct LeaseClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub client_id: String,
    pub device_id: String,
    pub session_id: String,
    pub capabilities: Vec<ProtectedCapability>,
    pub client_version: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SignedLease {
    pub key_id: String,
    pub claims: LeaseClaims,
    /// Ed25519 signature over the canonical JSON bytes of `claims`.
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactManifest {
    pub artifact_id: String,
    pub version: String,
    pub target_abi: String,
    pub target_android: String,
    pub session_id: String,
    pub device_id: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub expires_at: i64,
    pub key_id: String,
    pub transfer_id: String,
    pub server_ephemeral_public_key: String,
    pub chunk_size_bytes: u32,
    pub chunk_count: u32,
    pub nonce_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ExecutionGrantClaims {
    pub iss: String,
    pub aud: String,
    pub client_id: String,
    pub device_id: String,
    pub session_id: String,
    pub client_version: String,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub action: String,
    pub vm: String,
    pub instance: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SignedExecutionGrant {
    pub key_id: String,
    /// URL-safe base64 of the canonical JSON payload signed by the service.
    pub payload: String,
    pub signature: String,
    /// Device signature over the exact server-signed payload. This field is
    /// attached after the server response and verified again on consume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_proof: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionGrantContext<'a> {
    pub device_id: &'a str,
    pub session_id: &'a str,
    pub client_version: &'a str,
    pub artifact_id: &'a str,
    pub artifact_sha256: &'a str,
    pub action: &'a str,
    pub vm: &'a str,
    pub instance: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationError {
    Malformed(String),
    InvalidSignature,
    InvalidIssuer,
    InvalidAudience,
    LeaseExpired,
    LeaseNotYetValid,
    BindingMismatch,
    MissingCapability,
    ArtifactIntegrityFailed,
    NotRegistered,
    ServerUnreachable,
    Revoked,
    UnknownKey,
    Replay,
    TargetMismatch,
    Transport(String),
    SecureStore(String),
    AuthenticationRequired,
}

impl fmt::Display for AuthorizationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Malformed(value) => value.as_str(),
            Self::InvalidSignature => "authorization signature is invalid",
            Self::InvalidIssuer => "authorization issuer is invalid",
            Self::InvalidAudience => "authorization audience is invalid",
            Self::LeaseExpired => "authorization lease has expired",
            Self::LeaseNotYetValid => "authorization lease is not yet valid",
            Self::BindingMismatch => "authorization is bound to another device or session",
            Self::MissingCapability => "authorization does not include the requested capability",
            Self::ArtifactIntegrityFailed => "artifact manifest integrity check failed",
            Self::NotRegistered => "this device is not registered",
            Self::ServerUnreachable => "authorization server is unreachable",
            Self::Revoked => "authorization has been revoked",
            Self::UnknownKey => "authorization signing key is unknown",
            Self::Replay => "authorization request was already used",
            Self::TargetMismatch => "artifact target does not match the runtime",
            Self::Transport(detail) => detail.as_str(),
            Self::SecureStore(detail) => detail.as_str(),
            Self::AuthenticationRequired => "authentication is required",
        };
        f.write_str(text)
    }
}

impl std::error::Error for AuthorizationError {}

pub fn validate_claims(claims: &LeaseClaims, now: i64) -> Result<(), AuthorizationError> {
    if claims.iss != EXPECTED_ISSUER {
        return Err(AuthorizationError::InvalidIssuer);
    }
    if claims.aud != EXPECTED_AUDIENCE {
        return Err(AuthorizationError::InvalidAudience);
    }
    if claims.sub.is_empty()
        || claims.client_id.is_empty()
        || claims.device_id.is_empty()
        || claims.session_id.is_empty()
        || claims.jti.is_empty()
        || claims.nonce.is_empty()
        || claims.capabilities.is_empty()
    {
        return Err(AuthorizationError::Malformed(
            "lease contains an empty required field".into(),
        ));
    }
    if claims.exp <= now {
        return Err(AuthorizationError::LeaseExpired);
    }
    if claims.iat > now.saturating_add(MAX_CLOCK_SKEW_SECS) {
        return Err(AuthorizationError::LeaseNotYetValid);
    }
    if claims.exp <= claims.iat {
        return Err(AuthorizationError::Malformed(
            "lease expiry must be after issue time".into(),
        ));
    }
    Ok(())
}

pub fn validate_device_binding(
    claims: &LeaseClaims,
    device_id: &str,
) -> Result<(), AuthorizationError> {
    if claims.device_id == device_id {
        Ok(())
    } else {
        Err(AuthorizationError::BindingMismatch)
    }
}

pub fn validate_session_binding(
    claims: &LeaseClaims,
    device_id: &str,
    session_id: &str,
) -> Result<(), AuthorizationError> {
    validate_device_binding(claims, device_id)?;
    if claims.session_id == session_id {
        Ok(())
    } else {
        Err(AuthorizationError::BindingMismatch)
    }
}

pub fn require_capability(
    claims: &LeaseClaims,
    capability: ProtectedCapability,
) -> Result<(), AuthorizationError> {
    if claims.capabilities.contains(&capability) {
        Ok(())
    } else {
        Err(AuthorizationError::MissingCapability)
    }
}

pub fn verify_signed_lease(
    lease: &SignedLease,
    public_key_base64url: &str,
    now: i64,
) -> Result<(), AuthorizationError> {
    let key_bytes = URL_SAFE_NO_PAD.decode(public_key_base64url).map_err(|e| {
        AuthorizationError::Malformed(format!("invalid authorization public key: {e}"))
    })?;
    let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
        AuthorizationError::Malformed("authorization public key must be 32 bytes".into())
    })?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| {
        AuthorizationError::Malformed(format!("invalid authorization public key: {e}"))
    })?;
    let signature_bytes = URL_SAFE_NO_PAD.decode(&lease.signature).map_err(|e| {
        AuthorizationError::Malformed(format!("invalid authorization signature: {e}"))
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|e| {
        AuthorizationError::Malformed(format!("invalid authorization signature: {e}"))
    })?;
    let signed = serde_json::to_vec(&lease.claims)
        .map_err(|e| AuthorizationError::Malformed(format!("serialize lease claims: {e}")))?;
    key.verify(&signed, &signature)
        .map_err(|_| AuthorizationError::InvalidSignature)?;
    validate_claims(&lease.claims, now)
}

pub fn verify_signed_artifact_manifest(
    manifest: &ArtifactManifest,
    signature_base64url: &str,
    public_key_base64url: &str,
    now: i64,
) -> Result<(), AuthorizationError> {
    let key_bytes = URL_SAFE_NO_PAD
        .decode(public_key_base64url)
        .map_err(|error| {
            AuthorizationError::Malformed(format!("invalid authorization public key: {error}"))
        })?;
    let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
        AuthorizationError::Malformed("authorization public key must be 32 bytes".into())
    })?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid authorization public key: {error}"))
    })?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_base64url)
        .map_err(|error| {
            AuthorizationError::Malformed(format!("invalid artifact signature: {error}"))
        })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid artifact signature: {error}"))
    })?;
    let signed = serde_json::to_vec(manifest).map_err(|error| {
        AuthorizationError::Malformed(format!("serialize artifact manifest: {error}"))
    })?;
    key.verify(&signed, &signature)
        .map_err(|_| AuthorizationError::InvalidSignature)?;
    if manifest.expires_at <= now {
        return Err(AuthorizationError::LeaseExpired);
    }
    Ok(())
}

pub fn verify_signed_execution_grant(
    grant: &SignedExecutionGrant,
    public_key_base64url: &str,
    now: i64,
) -> Result<ExecutionGrantClaims, AuthorizationError> {
    let key_bytes = URL_SAFE_NO_PAD
        .decode(public_key_base64url)
        .map_err(|error| {
            AuthorizationError::Malformed(format!("invalid authorization public key: {error}"))
        })?;
    let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
        AuthorizationError::Malformed("authorization public key must be 32 bytes".into())
    })?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid authorization public key: {error}"))
    })?;
    let payload = URL_SAFE_NO_PAD.decode(&grant.payload).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid execution grant payload: {error}"))
    })?;
    let signature_bytes = URL_SAFE_NO_PAD.decode(&grant.signature).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid execution grant signature: {error}"))
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        AuthorizationError::Malformed(format!("invalid execution grant signature: {error}"))
    })?;
    key.verify(&payload, &signature)
        .map_err(|_| AuthorizationError::InvalidSignature)?;
    let claims = serde_json::from_slice::<ExecutionGrantClaims>(&payload).map_err(|error| {
        AuthorizationError::Malformed(format!("execution grant payload is invalid: {error}"))
    })?;
    validate_execution_grant_claims(&claims, now)?;
    Ok(claims)
}

fn validate_execution_grant_claims(
    claims: &ExecutionGrantClaims,
    now: i64,
) -> Result<(), AuthorizationError> {
    if claims.iss != EXPECTED_ISSUER {
        return Err(AuthorizationError::InvalidIssuer);
    }
    if claims.aud != "rdc-guest-runner" {
        return Err(AuthorizationError::InvalidAudience);
    }
    if claims.client_id.is_empty()
        || claims.device_id.is_empty()
        || claims.session_id.is_empty()
        || claims.client_version.is_empty()
        || claims.artifact_id.is_empty()
        || claims.artifact_sha256.len() != 64
        || !claims
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || claims.action.is_empty()
        || claims.vm.is_empty()
        || claims.instance.is_empty()
        || claims.jti.is_empty()
        || claims.nonce.is_empty()
    {
        return Err(AuthorizationError::Malformed(
            "execution grant contains an empty or invalid required field".into(),
        ));
    }
    if claims.exp <= now {
        return Err(AuthorizationError::LeaseExpired);
    }
    if claims.iat > now.saturating_add(MAX_CLOCK_SKEW_SECS) {
        return Err(AuthorizationError::LeaseNotYetValid);
    }
    if claims.exp <= claims.iat {
        return Err(AuthorizationError::Malformed(
            "execution grant expiry must be after issue time".into(),
        ));
    }
    Ok(())
}

pub fn validate_execution_grant(
    claims: &ExecutionGrantClaims,
    lease: &LeaseClaims,
    context: &ExecutionGrantContext<'_>,
    now: i64,
) -> Result<(), AuthorizationError> {
    validate_execution_grant_claims(claims, now)?;
    validate_claims(lease, now)?;
    require_capability(lease, ProtectedCapability::ProtectedPreset)?;
    if claims.exp > lease.exp
        || claims.client_id != lease.client_id
        || claims.device_id != context.device_id
        || claims.session_id != context.session_id
        || claims.client_version != context.client_version
        || claims.artifact_id != context.artifact_id
        || claims.artifact_sha256 != context.artifact_sha256
        || claims.action != context.action
        || claims.vm != context.vm
        || claims.instance != context.instance
    {
        return Err(AuthorizationError::BindingMismatch);
    }
    validate_session_binding(lease, context.device_id, context.session_id)
}

pub fn validate_artifact_manifest(
    manifest: &ArtifactManifest,
    claims: &LeaseClaims,
    device_id: &str,
    session_id: &str,
    now: i64,
) -> Result<(), AuthorizationError> {
    validate_claims(claims, now)?;
    validate_session_binding(claims, device_id, session_id)?;
    if manifest.device_id != device_id
        || manifest.session_id != session_id
        || manifest.expires_at <= now
        || manifest.expires_at > claims.exp
        || manifest.size_bytes == 0
        || manifest.sha256.len() != 64
        || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.transfer_id.is_empty()
        || manifest.server_ephemeral_public_key.is_empty()
        || u64::from(manifest.chunk_size_bytes) != ARTIFACT_CHUNK_SIZE
        || manifest.chunk_count == 0
        || u64::from(manifest.chunk_count)
            != (manifest.size_bytes.saturating_add(ARTIFACT_CHUNK_SIZE - 1) / ARTIFACT_CHUNK_SIZE)
        || manifest.nonce_prefix.is_empty()
    {
        return Err(AuthorizationError::ArtifactIntegrityFailed);
    }
    require_capability(claims, ProtectedCapability::ProtectedArtifact)
}

pub fn random_x25519_keypair() -> ([u8; 32], String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = X25519PublicKey::from(&secret);
    (secret.to_bytes(), URL_SAFE_NO_PAD.encode(public.as_bytes()))
}

pub fn derive_x25519_shared_secret(
    secret_bytes: &[u8; 32],
    peer_public_base64url: &str,
) -> Result<[u8; 32], AuthorizationError> {
    let peer_bytes = URL_SAFE_NO_PAD
        .decode(peer_public_base64url)
        .map_err(|error| AuthorizationError::Malformed(error.to_string()))?;
    let peer_bytes: [u8; 32] = peer_bytes.try_into().map_err(|_| {
        AuthorizationError::Malformed("ephemeral public key must be 32 bytes".into())
    })?;
    Ok(StaticSecret::from(*secret_bytes)
        .diffie_hellman(&X25519PublicKey::from(peer_bytes))
        .to_bytes())
}

pub fn derive_artifact_key(
    shared_secret: &[u8; 32],
    manifest: &ArtifactManifest,
) -> Result<[u8; 32], AuthorizationError> {
    let mut context = Vec::with_capacity(256);
    context.extend_from_slice(b"rdc-artifact-key-v1\0");
    for value in [
        &manifest.transfer_id,
        &manifest.artifact_id,
        &manifest.version,
        &manifest.session_id,
        &manifest.device_id,
        &manifest.sha256,
    ] {
        context.extend_from_slice(value.as_bytes());
        context.push(0);
    }
    let hk = Hkdf::<Sha256>::new(Some(b"rdc-artifact-v1"), shared_secret);
    let mut key = [0_u8; 32];
    hk.expand(&context, &mut key)
        .map_err(|_| AuthorizationError::Malformed("artifact key derivation failed".into()))?;
    Ok(key)
}

pub fn artifact_nonce(
    manifest: &ArtifactManifest,
    index: u32,
) -> Result<[u8; 12], AuthorizationError> {
    let prefix = URL_SAFE_NO_PAD
        .decode(&manifest.nonce_prefix)
        .map_err(|error| AuthorizationError::Malformed(error.to_string()))?;
    let prefix: [u8; 8] = prefix.try_into().map_err(|_| {
        AuthorizationError::Malformed("artifact nonce prefix must be 8 bytes".into())
    })?;
    let mut nonce = [0_u8; 12];
    nonce[..8].copy_from_slice(&prefix);
    nonce[8..].copy_from_slice(&index.to_be_bytes());
    Ok(nonce)
}

pub fn artifact_aad(manifest: &ArtifactManifest, index: u32) -> Vec<u8> {
    format!(
        "rdc-artifact-chunk-v1\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.transfer_id,
        manifest.artifact_id,
        manifest.version,
        manifest.session_id,
        manifest.device_id,
        index
    )
    .into_bytes()
}

pub fn decrypt_artifact_chunk(
    key: &[u8; 32],
    manifest: &ArtifactManifest,
    index: u32,
    ciphertext: &[u8],
) -> Result<Vec<u8>, AuthorizationError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = artifact_nonce(manifest, index)?;
    let aad = artifact_aad(manifest, index);
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| AuthorizationError::ArtifactIntegrityFailed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RegistrationProof<'a> {
    pub client_id: &'a str,
    pub challenge: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionProof<'a> {
    pub client_id: &'a str,
    pub device_id: &'a str,
    pub client_version: &'a str,
    pub nonce: &'a str,
    pub capabilities: &'a [ProtectedCapability],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HeartbeatProof<'a> {
    pub session_id: &'a str,
    pub client_id: &'a str,
    pub device_id: &'a str,
    pub nonce: &'a str,
}

pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, AuthorizationError> {
    serde_json::to_vec(value).map_err(|error| {
        AuthorizationError::Malformed(format!("serialize authorization proof: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_claims_with_expiry(exp: i64) -> LeaseClaims {
        LeaseClaims {
            iss: EXPECTED_ISSUER.into(),
            aud: EXPECTED_AUDIENCE.into(),
            sub: "account-a".into(),
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            session_id: "session-a".into(),
            capabilities: vec![ProtectedCapability::ProtectedArtifact],
            client_version: "1.0.0".into(),
            iat: 900,
            exp,
            jti: "jti-a".into(),
            nonce: "nonce-a".into(),
        }
    }

    fn signed_claims(claims: LeaseClaims) -> (SignedLease, String) {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let signature = signing.sign(&serde_json::to_vec(&claims).unwrap());
        (
            SignedLease {
                key_id: "auth-2026-01".into(),
                claims,
                signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            },
            URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
        )
    }

    #[test]
    fn expired_lease_is_rejected_even_when_the_signature_is_valid() {
        let claims = test_claims_with_expiry(1_000);
        assert_eq!(
            validate_claims(&claims, 1_001),
            Err(AuthorizationError::LeaseExpired)
        );
    }

    #[test]
    fn a_lease_for_another_device_is_rejected() {
        let claims = test_claims_with_expiry(2_000);
        assert_eq!(
            validate_device_binding(&claims, "device-b"),
            Err(AuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn valid_signature_and_claims_are_accepted() {
        let (lease, public_key) = signed_claims(test_claims_with_expiry(2_000));
        assert_eq!(verify_signed_lease(&lease, &public_key, 1_001), Ok(()));
    }

    #[test]
    fn tampering_with_claims_invalidates_the_signature() {
        let (mut lease, public_key) = signed_claims(test_claims_with_expiry(2_000));
        lease.claims.device_id = "device-b".into();
        assert_eq!(
            verify_signed_lease(&lease, &public_key, 1_001),
            Err(AuthorizationError::InvalidSignature)
        );
    }

    #[test]
    fn artifact_manifest_is_bound_to_the_lease_context() {
        let claims = test_claims_with_expiry(2_000);
        let manifest = ArtifactManifest {
            artifact_id: "core-a".into(),
            version: "1".into(),
            target_abi: "x86_64".into(),
            target_android: "13".into(),
            session_id: "session-a".into(),
            device_id: "device-a".into(),
            size_bytes: 1,
            sha256: "a".repeat(64),
            expires_at: 1_500,
            key_id: "auth-2026-01".into(),
            transfer_id: "transfer-a".into(),
            server_ephemeral_public_key: "server-key".into(),
            chunk_size_bytes: 256 * 1024,
            chunk_count: 1,
            nonce_prefix: "nonce".into(),
        };
        assert_eq!(
            validate_artifact_manifest(&manifest, &claims, "device-a", "session-a", 1_001),
            Ok(())
        );
        assert_eq!(
            validate_artifact_manifest(&manifest, &claims, "device-b", "session-a", 1_001),
            Err(AuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn execution_grant_is_accepted_only_for_the_exact_lease_and_workflow_context() {
        let mut lease = test_claims_with_expiry(2_000);
        lease.capabilities = vec![ProtectedCapability::ProtectedPreset];
        let artifact_sha256 = "a".repeat(64);
        let claims = ExecutionGrantClaims {
            iss: "rdc-auth".into(),
            aud: "rdc-guest-runner".into(),
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            session_id: "session-a".into(),
            client_version: "1.0.0".into(),
            artifact_id: "core-a".into(),
            artifact_sha256: artifact_sha256.clone(),
            action: "preset_apply".into(),
            vm: "node1".into(),
            instance: "r13".into(),
            iat: 1_000,
            exp: 1_120,
            jti: "grant-a".into(),
            nonce: "nonce-a".into(),
        };
        let context = ExecutionGrantContext {
            device_id: "device-a",
            session_id: "session-a",
            client_version: "1.0.0",
            artifact_id: "core-a",
            artifact_sha256: &artifact_sha256,
            action: "preset_apply",
            vm: "node1",
            instance: "r13",
        };

        assert_eq!(
            validate_execution_grant(&claims, &lease, &context, 1_001),
            Ok(())
        );
        let mut wrong_device = claims.clone();
        wrong_device.device_id = "device-b".into();
        assert_eq!(
            validate_execution_grant(&wrong_device, &lease, &context, 1_001),
            Err(AuthorizationError::BindingMismatch)
        );
        let mut wrong_action = claims;
        wrong_action.action = "preset_restore".into();
        assert_eq!(
            validate_execution_grant(&wrong_action, &lease, &context, 1_001),
            Err(AuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn expired_execution_grant_is_rejected_before_context_binding() {
        let lease = test_claims_with_expiry(2_000);
        let artifact_sha256 = "a".repeat(64);
        let claims = ExecutionGrantClaims {
            iss: EXPECTED_ISSUER.into(),
            aud: "rdc-guest-runner".into(),
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            session_id: "session-a".into(),
            client_version: "1.0.0".into(),
            artifact_id: "core-a".into(),
            artifact_sha256: artifact_sha256.clone(),
            action: "preset_apply".into(),
            vm: "node1".into(),
            instance: "r13".into(),
            iat: 900,
            exp: 1_000,
            jti: "grant-expired".into(),
            nonce: "nonce-expired".into(),
        };
        let context = ExecutionGrantContext {
            device_id: "device-a",
            session_id: "session-a",
            client_version: "1.0.0",
            artifact_id: "core-a",
            artifact_sha256: &artifact_sha256,
            action: "preset_apply",
            vm: "node1",
            instance: "r13",
        };

        assert_eq!(
            validate_execution_grant(&claims, &lease, &context, 1_001),
            Err(AuthorizationError::LeaseExpired)
        );
    }

    #[test]
    fn tampering_with_execution_grant_signature_is_rejected() {
        let signing = SigningKey::from_bytes(&[8_u8; 32]);
        let claims = ExecutionGrantClaims {
            iss: EXPECTED_ISSUER.into(),
            aud: "rdc-guest-runner".into(),
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            session_id: "session-a".into(),
            client_version: "1.0.0".into(),
            artifact_id: "core-a".into(),
            artifact_sha256: "a".repeat(64),
            action: "preset_apply".into(),
            vm: "node1".into(),
            instance: "r13".into(),
            iat: 1_000,
            exp: 2_000,
            jti: "grant-signed".into(),
            nonce: "nonce-signed".into(),
        };
        let payload = serde_json::to_vec(&claims).unwrap();
        let mut signature = signing.sign(&payload).to_bytes();
        signature[0] ^= 1;
        let grant = SignedExecutionGrant {
            key_id: "auth-2026-01".into(),
            payload: URL_SAFE_NO_PAD.encode(payload),
            signature: URL_SAFE_NO_PAD.encode(signature),
            device_proof: None,
        };

        assert_eq!(
            verify_signed_execution_grant(
                &grant,
                &URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
                1_001,
            ),
            Err(AuthorizationError::InvalidSignature)
        );
    }
}
