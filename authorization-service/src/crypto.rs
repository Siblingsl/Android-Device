use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use p256::ecdsa::{
    signature::hazmat::PrehashVerifier, Signature as P256Signature,
    VerifyingKey as P256VerifyingKey,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

pub const LEASE_MAX_SECS: i64 = 15 * 60;
pub const ARTIFACT_CHUNK_SIZE: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKeyAlgorithm {
    Ed25519DpapiV1,
    EcdsaP256CngV1,
}

impl Default for ClientKeyAlgorithm {
    fn default() -> Self {
        Self::Ed25519DpapiV1
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectedCapability {
    ProtectedPreset,
    ProtectedArtifact,
    ProtectedAlgorithm,
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
    /// Device proof over the exact encoded payload. It is attached by the
    /// client after receiving the server-signed grant and is verified on
    /// consume, so copying the artifact and grant alone is insufficient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_proof: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SigningAuthority {
    key_id: String,
    signing_key: Arc<SigningKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    Malformed(String),
    InvalidSignature,
    Io(String),
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(detail) => write!(f, "malformed cryptographic value: {detail}"),
            Self::InvalidSignature => f.write_str("signature is invalid"),
            Self::Io(detail) => write!(f, "artifact hash failed: {detail}"),
        }
    }
}

impl std::error::Error for CryptoError {}

impl SigningAuthority {
    pub fn from_base64url(key_id: impl Into<String>, secret: &str) -> Result<Self, CryptoError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(secret)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        let secret: [u8; 32] = bytes
            .try_into()
            .map_err(|_| CryptoError::Malformed("signing key must be 32 bytes".into()))?;
        Ok(Self {
            key_id: key_id.into(),
            signing_key: Arc::new(SigningKey::from_bytes(&secret)),
        })
    }

    pub fn for_tests() -> Self {
        Self {
            key_id: "test-key".into(),
            signing_key: Arc::new(SigningKey::from_bytes(&[9; 32])),
        }
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn public_key_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.verifying_key().to_bytes())
    }

    pub fn sign_claims(&self, claims: LeaseClaims) -> SignedLease {
        let signature = self.sign_bytes(&claims);
        SignedLease {
            key_id: self.key_id.clone(),
            claims,
            signature,
        }
    }

    pub fn sign_manifest(&self, manifest: ArtifactManifest) -> SignedArtifactManifest {
        let signature = self.sign_bytes(&manifest);
        SignedArtifactManifest {
            key_id: self.key_id.clone(),
            manifest,
            signature,
        }
    }

    pub fn sign_execution_grant(&self, claims: ExecutionGrantClaims) -> SignedExecutionGrant {
        let payload =
            canonical_json(&claims).expect("authorization protocol values are serializable");
        let signature = URL_SAFE_NO_PAD.encode(self.signing_key.sign(&payload).to_bytes());
        SignedExecutionGrant {
            key_id: self.key_id.clone(),
            payload: URL_SAFE_NO_PAD.encode(payload),
            signature,
            device_proof: None,
        }
    }

    pub fn verify_execution_grant(
        &self,
        grant: &SignedExecutionGrant,
    ) -> Result<ExecutionGrantClaims, CryptoError> {
        if grant.key_id != self.key_id {
            return Err(CryptoError::InvalidSignature);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(&grant.payload)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        let signature = URL_SAFE_NO_PAD
            .decode(&grant.signature)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        let signature = ed25519_dalek::Signature::from_slice(&signature)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        self.signing_key
            .verifying_key()
            .verify(&payload, &signature)
            .map_err(|_| CryptoError::InvalidSignature)?;
        decode_execution_grant_payload(&grant.payload)
    }

    fn sign_bytes<T: Serialize>(&self, value: &T) -> String {
        let bytes =
            serde_json::to_vec(value).expect("authorization protocol values are serializable");
        URL_SAFE_NO_PAD.encode(self.signing_key.sign(&bytes).to_bytes())
    }

    pub fn verify_client_signature(
        &self,
        algorithm: ClientKeyAlgorithm,
        public_key_base64url: &str,
        payload: &[u8],
        signature_base64url: &str,
    ) -> Result<(), CryptoError> {
        let key_bytes = URL_SAFE_NO_PAD
            .decode(public_key_base64url)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature_base64url)
            .map_err(|error| CryptoError::Malformed(error.to_string()))?;
        match algorithm {
            ClientKeyAlgorithm::Ed25519DpapiV1 => {
                let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
                    CryptoError::Malformed("client public key must be 32 bytes".into())
                })?;
                let key = VerifyingKey::from_bytes(&key_bytes)
                    .map_err(|error| CryptoError::Malformed(error.to_string()))?;
                let signature = ed25519_dalek::Signature::from_slice(&signature)
                    .map_err(|error| CryptoError::Malformed(error.to_string()))?;
                key.verify(payload, &signature)
                    .map_err(|_| CryptoError::InvalidSignature)
            }
            ClientKeyAlgorithm::EcdsaP256CngV1 => {
                if key_bytes.len() != 65 || key_bytes[0] != 0x04 {
                    return Err(CryptoError::Malformed(
                        "ECDSA P-256 public key must be an uncompressed SEC1 key".into(),
                    ));
                }
                let key = P256VerifyingKey::from_sec1_bytes(&key_bytes)
                    .map_err(|error| CryptoError::Malformed(error.to_string()))?;
                let signature = P256Signature::from_slice(&signature)
                    .map_err(|error| CryptoError::Malformed(error.to_string()))?;
                let digest = Sha256::digest(payload);
                key.verify_prehash(&digest, &signature)
                    .map_err(|_| CryptoError::InvalidSignature)
            }
        }
    }

    pub fn random_nonce() -> String {
        let mut bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }
}

pub fn validate_public_key_base64url(
    algorithm: ClientKeyAlgorithm,
    value: &str,
) -> Result<(), CryptoError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|error| CryptoError::Malformed(error.to_string()))?;
    match algorithm {
        ClientKeyAlgorithm::Ed25519DpapiV1 => {
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| CryptoError::Malformed("client public key must be 32 bytes".into()))?;
            VerifyingKey::from_bytes(&bytes)
                .map(|_| ())
                .map_err(|error| CryptoError::Malformed(error.to_string()))
        }
        ClientKeyAlgorithm::EcdsaP256CngV1 => {
            if bytes.len() != 65 || bytes[0] != 0x04 {
                return Err(CryptoError::Malformed(
                    "ECDSA P-256 public key must be an uncompressed SEC1 key".into(),
                ));
            }
            P256VerifyingKey::from_sec1_bytes(&bytes)
                .map(|_| ())
                .map_err(|error| CryptoError::Malformed(error.to_string()))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SignedArtifactManifest {
    pub key_id: String,
    pub manifest: ArtifactManifest,
    pub signature: String,
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

pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, CryptoError> {
    serde_json::to_vec(value).map_err(|error| CryptoError::Malformed(error.to_string()))
}

pub fn decode_execution_grant_payload(payload: &str) -> Result<ExecutionGrantClaims, CryptoError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|error| CryptoError::Malformed(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| CryptoError::Malformed(error.to_string()))
}

pub fn sha256_file(path: &Path) -> Result<(u64, String), CryptoError> {
    let mut file = std::fs::File::open(path).map_err(|error| CryptoError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| CryptoError::Io("artifact size overflow".into()))?;
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

pub fn random_x25519_keypair() -> ([u8; 32], String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = X25519PublicKey::from(&secret);
    (secret.to_bytes(), URL_SAFE_NO_PAD.encode(public.as_bytes()))
}

pub fn derive_x25519_shared_secret(
    secret_bytes: &[u8; 32],
    peer_public_base64url: &str,
) -> Result<[u8; 32], CryptoError> {
    let peer_bytes = URL_SAFE_NO_PAD
        .decode(peer_public_base64url)
        .map_err(|error| CryptoError::Malformed(error.to_string()))?;
    let peer_bytes: [u8; 32] = peer_bytes
        .try_into()
        .map_err(|_| CryptoError::Malformed("ephemeral public key must be 32 bytes".into()))?;
    let peer = X25519PublicKey::from(peer_bytes);
    Ok(StaticSecret::from(*secret_bytes)
        .diffie_hellman(&peer)
        .to_bytes())
}

pub fn random_nonce_prefix() -> String {
    let mut bytes = [0_u8; 8];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn derive_artifact_key(
    shared_secret: &[u8; 32],
    manifest: &ArtifactManifest,
) -> Result<[u8; 32], CryptoError> {
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
        .map_err(|_| CryptoError::Malformed("artifact key derivation failed".into()))?;
    Ok(key)
}

pub fn artifact_nonce(manifest: &ArtifactManifest, index: u32) -> Result<[u8; 12], CryptoError> {
    let prefix = URL_SAFE_NO_PAD
        .decode(&manifest.nonce_prefix)
        .map_err(|error| CryptoError::Malformed(error.to_string()))?;
    let prefix: [u8; 8] = prefix
        .try_into()
        .map_err(|_| CryptoError::Malformed("artifact nonce prefix must be 8 bytes".into()))?;
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

pub fn encrypt_artifact_chunk(
    key: &[u8; 32],
    manifest: &ArtifactManifest,
    index: u32,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = artifact_nonce(manifest, index)?;
    let aad = artifact_aad(manifest, index);
    cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Malformed("artifact encryption failed".into()))
}

pub fn decrypt_artifact_chunk(
    key: &[u8; 32],
    manifest: &ArtifactManifest,
    index: u32,
    ciphertext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
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
        .map_err(|_| CryptoError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey as P256SigningKey};

    #[test]
    fn artifact_manifest_signature_changes_when_hash_changes() {
        let authority = SigningAuthority::for_tests();
        let first = authority.sign_manifest(ArtifactManifest {
            artifact_id: "artifact-a".into(),
            version: "1".into(),
            target_abi: "x86_64".into(),
            target_android: "android-13".into(),
            session_id: "session-a".into(),
            device_id: "device-a".into(),
            size_bytes: 1,
            sha256: "a".repeat(64),
            expires_at: 2_000,
            key_id: authority.key_id().into(),
            transfer_id: "transfer-a".into(),
            server_ephemeral_public_key: "server-key".into(),
            chunk_size_bytes: 256 * 1024,
            chunk_count: 1,
            nonce_prefix: "nonce".into(),
        });
        let mut second_manifest = first.manifest.clone();
        second_manifest.sha256 = "b".repeat(64);
        let second = authority.sign_manifest(second_manifest);
        assert_ne!(first.signature, second.signature);
    }

    #[test]
    fn generated_public_key_can_verify_a_client_signature() {
        let authority = SigningAuthority::for_tests();
        let client = SigningKey::from_bytes(&[4; 32]);
        let payload = b"challenge";
        let signature = URL_SAFE_NO_PAD.encode(client.sign(payload).to_bytes());
        assert_eq!(
            authority.verify_client_signature(
                ClientKeyAlgorithm::Ed25519DpapiV1,
                &URL_SAFE_NO_PAD.encode(client.verifying_key().to_bytes()),
                payload,
                &signature
            ),
            Ok(())
        );
    }

    #[test]
    fn p256_client_signature_requires_the_explicit_algorithm_and_raw_signature() {
        let authority = SigningAuthority::for_tests();
        let client = P256SigningKey::from_bytes((&[5_u8; 32]).into()).unwrap();
        let payload = b"challenge";
        let digest = Sha256::digest(payload);
        let signature: p256::ecdsa::Signature = client.sign_prehash(&digest).unwrap();
        let public_key =
            URL_SAFE_NO_PAD.encode(client.verifying_key().to_encoded_point(false).as_bytes());
        let raw_signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());

        assert_eq!(
            authority.verify_client_signature(
                ClientKeyAlgorithm::EcdsaP256CngV1,
                &public_key,
                payload,
                &raw_signature,
            ),
            Ok(())
        );
        assert!(matches!(
            authority.verify_client_signature(
                ClientKeyAlgorithm::Ed25519DpapiV1,
                &public_key,
                payload,
                &raw_signature,
            ),
            Err(CryptoError::Malformed(_))
        ));
        let der_signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
        assert!(matches!(
            authority.verify_client_signature(
                ClientKeyAlgorithm::EcdsaP256CngV1,
                &public_key,
                payload,
                &der_signature,
            ),
            Err(CryptoError::Malformed(_))
        ));
    }

    #[test]
    fn execution_grant_signs_a_canonical_payload_without_exposing_claim_fields_to_mutation() {
        let authority = SigningAuthority::for_tests();
        let claims = ExecutionGrantClaims {
            iss: "rdc-auth".into(),
            aud: "rdc-guest-runner".into(),
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            session_id: "session-a".into(),
            client_version: "1.0.0".into(),
            artifact_id: "qemu-guest-script-universal".into(),
            artifact_sha256: "a".repeat(64),
            action: "preset_apply".into(),
            vm: "node1".into(),
            instance: "r13".into(),
            iat: 1_000,
            exp: 1_120,
            jti: "grant-a".into(),
            nonce: "nonce-a".into(),
        };

        let signed = authority.sign_execution_grant(claims.clone());
        assert_eq!(signed.key_id, authority.key_id());
        assert_ne!(signed.payload, serde_json::to_string(&claims).unwrap());
        assert_eq!(
            decode_execution_grant_payload(&signed.payload).unwrap(),
            claims
        );
        assert!(authority.verify_execution_grant(&signed).is_ok());
    }
}
