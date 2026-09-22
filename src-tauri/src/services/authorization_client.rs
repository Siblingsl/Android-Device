//! Server-facing authorization client.
//!
//! All protected operations should call this layer immediately before doing
//! work. The React layer never owns a bearer token or decides that a lease is
//! valid. The generic transport boundary keeps protocol behavior testable
//! without making network calls from unit tests.

use crate::services::authorization::{
    canonical_json, decrypt_artifact_chunk, derive_artifact_key, derive_x25519_shared_secret,
    random_x25519_keypair, require_capability, validate_artifact_manifest,
    validate_execution_grant, validate_session_binding, verify_signed_artifact_manifest,
    verify_signed_execution_grant, verify_signed_lease, ArtifactManifest, AuthorizationError,
    AuthorizationStatus, ClientKeyAlgorithm, ExecutionGrantContext, ExecutionGrantProof,
    HeartbeatProof,
    ProtectedCapability, RegistrationProof, SessionProof, SignedExecutionGrant, SignedLease,
};
use crate::services::secure_store::{
    load_or_create_device_material_with, DeviceAuthMaterial, DeviceIdentity, DeviceSecurityLevel,
    DeviceSecurityPolicy, DeviceSigner, SecureStore, SecureStoreError, WindowsSecureStore,
};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;
use once_cell::sync::Lazy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroizing;

const REGISTRATION_STORE_KEY: &str = "authorization-client-registration";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct RegisterRequest {
    pub install_id: String,
    pub device_id: String,
    pub client_version: String,
    pub platform: String,
    pub device_public_key: String,
    pub client_key_algorithm: ClientKeyAlgorithm,
    pub requested_product: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct RegisterResponse {
    pub client_id: String,
    pub device_id: String,
    pub challenge: String,
    pub key_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CompleteRegistrationRequest {
    pub client_id: String,
    pub challenge: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CompleteRegistrationResponse {
    pub client_id: String,
    pub device_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SessionRequest {
    pub client_id: String,
    pub device_id: String,
    pub client_version: String,
    pub nonce: String,
    pub iat: i64,
    pub capabilities: Vec<ProtectedCapability>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SessionResponse {
    pub lease: SignedLease,
    pub server_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct HeartbeatRequest {
    pub client_id: String,
    pub device_id: String,
    pub nonce: String,
    pub iat: i64,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactPrepareRequest {
    pub device_id: String,
    pub target_abi: String,
    pub target_android: String,
    pub ephemeral_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SignedArtifactManifest {
    pub key_id: String,
    pub manifest: ArtifactManifest,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactChunkResponse {
    pub index: u32,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ExecutionGrantRequest {
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub action: String,
    pub vm: String,
    pub instance: String,
    pub nonce: String,
    pub iat: i64,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
struct RegistrationRecord {
    client_id: String,
    device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationSession {
    pub lease: SignedLease,
    pub server_time: i64,
    lease_clock: LeaseClock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LeaseClock {
    anchor_unix: i64,
    anchor_instant: Instant,
}

impl LeaseClock {
    fn new(anchor_unix: i64) -> Self {
        Self {
            anchor_unix,
            anchor_instant: Instant::now(),
        }
    }

    fn now(&self) -> Result<i64, AuthorizationError> {
        self.now_at(Instant::now())
    }

    fn now_at(&self, instant: Instant) -> Result<i64, AuthorizationError> {
        let elapsed = i64::try_from(instant.duration_since(self.anchor_instant).as_secs())
            .map_err(|_| AuthorizationError::Malformed("lease clock overflow".into()))?;
        self.anchor_unix
            .checked_add(elapsed)
            .ok_or_else(|| AuthorizationError::Malformed("lease clock overflow".into()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedAuthorizationKey {
    pub key_id: String,
    pub public_key_base64url: String,
}

#[async_trait]
pub trait AuthTransport: Send + Sync {
    async fn register(
        &self,
        request: RegisterRequest,
    ) -> Result<RegisterResponse, AuthorizationError>;
    async fn complete_registration(
        &self,
        request: CompleteRegistrationRequest,
    ) -> Result<CompleteRegistrationResponse, AuthorizationError>;
    async fn acquire_session(
        &self,
        request: SessionRequest,
    ) -> Result<SessionResponse, AuthorizationError>;
    async fn heartbeat(
        &self,
        session_id: &str,
        request: HeartbeatRequest,
    ) -> Result<SessionResponse, AuthorizationError>;
    async fn prepare_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
        request: ArtifactPrepareRequest,
    ) -> Result<SignedArtifactManifest, AuthorizationError>;
    async fn fetch_artifact_chunk(
        &self,
        session_id: &str,
        artifact_id: &str,
        transfer_id: &str,
        index: u32,
    ) -> Result<ArtifactChunkResponse, AuthorizationError>;
    async fn issue_execution_grant(
        &self,
        session_id: &str,
        request: ExecutionGrantRequest,
    ) -> Result<SignedExecutionGrant, AuthorizationError>;
}

pub struct AuthorizationClient<T, S> {
    transport: T,
    store: S,
    trusted_keys: Vec<TrustedAuthorizationKey>,
    client_version: String,
    platform: String,
    product: String,
    security_policy: DeviceSecurityPolicy,
    session: Option<AuthorizationSession>,
}

impl<T, S> AuthorizationClient<T, S>
where
    T: AuthTransport,
    S: SecureStore,
{
    pub fn new(
        transport: T,
        store: S,
        trusted_keys: Vec<TrustedAuthorizationKey>,
        client_version: impl Into<String>,
        platform: impl Into<String>,
        product: impl Into<String>,
    ) -> Self {
        Self::new_with_security_policy(
            transport,
            store,
            trusted_keys,
            client_version,
            platform,
            product,
            DeviceSecurityPolicy::default(),
        )
    }

    pub fn new_with_security_policy(
        transport: T,
        store: S,
        trusted_keys: Vec<TrustedAuthorizationKey>,
        client_version: impl Into<String>,
        platform: impl Into<String>,
        product: impl Into<String>,
        security_policy: DeviceSecurityPolicy,
    ) -> Self {
        Self {
            transport,
            store,
            trusted_keys,
            client_version: client_version.into(),
            platform: platform.into(),
            product: product.into(),
            security_policy,
            session: None,
        }
    }

    pub async fn register_client(
        &mut self,
    ) -> Result<CompleteRegistrationResponse, AuthorizationError> {
        let identity = self.identity()?;
        let signer = self.signer()?;
        ensure_signer_matches_identity(&identity, &signer)?;
        let response = self
            .transport
            .register(RegisterRequest {
                install_id: identity.install_id,
                device_id: identity.device_id.clone(),
                client_version: self.client_version.clone(),
                platform: self.platform.clone(),
                device_public_key: signer.public_key_base64url(),
                client_key_algorithm: signer.algorithm(),
                requested_product: self.product.clone(),
            })
            .await?;
        if response.device_id != identity.device_id {
            return Err(AuthorizationError::BindingMismatch);
        }
        let proof = RegistrationProof {
            client_id: &response.client_id,
            challenge: &response.challenge,
        };
        let payload = canonical_json(&proof)?;
        let complete = self
            .transport
            .complete_registration(CompleteRegistrationRequest {
                client_id: response.client_id.clone(),
                challenge: response.challenge,
                signature: URL_SAFE_NO_PAD
                    .encode(signer.sign_canonical(&payload).map_err(map_store_error)?),
            })
            .await?;
        if complete.client_id != response.client_id || complete.device_id != identity.device_id {
            return Err(AuthorizationError::BindingMismatch);
        }
        self.save_registration(&RegistrationRecord {
            client_id: complete.client_id.clone(),
            device_id: complete.device_id.clone(),
        })?;
        Ok(complete)
    }

    pub async fn acquire_session(
        &mut self,
        capabilities: Vec<ProtectedCapability>,
    ) -> Result<AuthorizationSession, AuthorizationError> {
        let identity = self.identity()?;
        let signer = self.signer()?;
        ensure_signer_matches_identity(&identity, &signer)?;
        let registration = self
            .registration()?
            .ok_or(AuthorizationError::NotRegistered)?;
        ensure_registration_matches(&registration, &identity)?;
        let iat = current_unix_time()?;
        let nonce = Uuid::new_v4().to_string();
        let proof = SessionProof {
            client_id: &registration.client_id,
            device_id: &identity.device_id,
            client_version: &self.client_version,
            nonce: &nonce,
            iat,
            capabilities: &capabilities,
        };
        let payload = canonical_json(&proof)?;
        let response = self
            .transport
            .acquire_session(SessionRequest {
                client_id: registration.client_id,
                device_id: identity.device_id.clone(),
                client_version: self.client_version.clone(),
                nonce,
                iat,
                capabilities: capabilities.clone(),
                signature: URL_SAFE_NO_PAD
                    .encode(signer.sign_canonical(&payload).map_err(map_store_error)?),
            })
            .await?;
        let lease_clock = self.verify_lease(
            &response.lease,
            response.server_time,
            &identity,
            &capabilities,
            None,
        )?;
        self.session = Some(AuthorizationSession {
            lease: response.lease,
            server_time: response.server_time,
            lease_clock,
        });
        Ok(self.session.clone().expect("session was just stored"))
    }

    pub async fn heartbeat(&mut self) -> Result<AuthorizationSession, AuthorizationError> {
        let current = self
            .session
            .clone()
            .ok_or(AuthorizationError::NotRegistered)?;
        let identity = self.identity()?;
        let signer = self.signer()?;
        ensure_signer_matches_identity(&identity, &signer)?;
        let registration = self
            .registration()?
            .ok_or(AuthorizationError::NotRegistered)?;
        ensure_registration_matches(&registration, &identity)?;
        let iat = current_unix_time()?;
        let nonce = Uuid::new_v4().to_string();
        let proof = HeartbeatProof {
            session_id: &current.lease.claims.session_id,
            client_id: &registration.client_id,
            device_id: &identity.device_id,
            nonce: &nonce,
            iat,
        };
        let payload = canonical_json(&proof)?;
        let response = self
            .transport
            .heartbeat(
                &current.lease.claims.session_id,
                HeartbeatRequest {
                    client_id: registration.client_id,
                    device_id: identity.device_id.clone(),
                    nonce,
                    iat,
                    signature: URL_SAFE_NO_PAD
                        .encode(signer.sign_canonical(&payload).map_err(map_store_error)?),
                },
            )
            .await?;
        let previous_now = current.lease_clock.now()?;
        let lease_clock = self.verify_lease(
            &response.lease,
            response.server_time,
            &identity,
            &current.lease.claims.capabilities,
            Some(previous_now),
        )?;
        self.session = Some(AuthorizationSession {
            lease: response.lease,
            server_time: response.server_time,
            lease_clock,
        });
        Ok(self.session.clone().expect("session was just stored"))
    }

    pub async fn prepare_artifact(
        &self,
        artifact_id: &str,
        target_abi: &str,
        target_android: &str,
        ephemeral_public_key: &str,
    ) -> Result<SignedArtifactManifest, AuthorizationError> {
        let session = self
            .session
            .as_ref()
            .ok_or(AuthorizationError::NotRegistered)?;
        let identity = self.identity()?;
        validate_session_binding(
            &session.lease.claims,
            &identity.device_id,
            &session.lease.claims.session_id,
        )?;
        require_capability(
            &session.lease.claims,
            ProtectedCapability::ProtectedArtifact,
        )?;
        if session.lease.claims.exp <= session.lease_clock.now()? {
            return Err(AuthorizationError::LeaseExpired);
        }
        let response = self
            .transport
            .prepare_artifact(
                &session.lease.claims.session_id,
                artifact_id,
                ArtifactPrepareRequest {
                    device_id: identity.device_id.clone(),
                    target_abi: target_abi.into(),
                    target_android: target_android.into(),
                    ephemeral_public_key: ephemeral_public_key.into(),
                },
            )
            .await?;
        if response.manifest.key_id != response.key_id {
            return Err(AuthorizationError::UnknownKey);
        }
        let key = self.trusted_key(&response.key_id)?;
        let now = session.lease_clock.now()?;
        verify_signed_artifact_manifest(
            &response.manifest,
            &response.signature,
            &key.public_key_base64url,
            now,
        )?;
        if response.manifest.artifact_id != artifact_id
            || response.manifest.target_abi != target_abi
            || response.manifest.target_android != target_android
        {
            return Err(AuthorizationError::TargetMismatch);
        }
        validate_artifact_manifest(
            &response.manifest,
            &session.lease.claims,
            &identity.device_id,
            &session.lease.claims.session_id,
            now,
        )?;
        Ok(response)
    }

    pub async fn request_execution_grant(
        &self,
        artifact_id: &str,
        artifact_sha256: &str,
        action: &str,
        vm: &str,
        instance: &str,
    ) -> Result<SignedExecutionGrant, AuthorizationError> {
        let session = self
            .session
            .as_ref()
            .ok_or(AuthorizationError::NotRegistered)?;
        let identity = self.identity()?;
        let signer = self.signer()?;
        ensure_signer_matches_identity(&identity, &signer)?;
        let session_id = &session.lease.claims.session_id;
        validate_session_binding(&session.lease.claims, &identity.device_id, session_id)?;
        require_capability(&session.lease.claims, ProtectedCapability::ProtectedPreset)?;
        require_capability(
            &session.lease.claims,
            ProtectedCapability::ProtectedArtifact,
        )?;
        let now = session.lease_clock.now()?;
        if session.lease.claims.exp <= now {
            return Err(AuthorizationError::LeaseExpired);
        }
        let iat = current_unix_time()?;
        let nonce = Uuid::new_v4().to_string();
        let proof = ExecutionGrantProof {
            artifact_id,
            artifact_sha256,
            action,
            vm,
            instance,
            nonce: &nonce,
            iat,
        };
        let payload = canonical_json(&proof)?;
        let response = self
            .transport
            .issue_execution_grant(
                session_id,
                ExecutionGrantRequest {
                    artifact_id: artifact_id.into(),
                    artifact_sha256: artifact_sha256.into(),
                    action: action.into(),
                    vm: vm.into(),
                    instance: instance.into(),
                    nonce,
                    iat,
                    signature: URL_SAFE_NO_PAD
                        .encode(signer.sign_canonical(&payload).map_err(map_store_error)?),
                },
            )
            .await?;
        let key = self.trusted_key(&response.key_id)?;
        let claims = verify_signed_execution_grant(&response, &key.public_key_base64url, now)?;
        let expected_artifact_sha256 = if artifact_sha256.trim().is_empty() {
            claims.artifact_sha256.as_str()
        } else {
            artifact_sha256
        };
        validate_execution_grant(
            &claims,
            &session.lease.claims,
            &ExecutionGrantContext {
                device_id: &identity.device_id,
                session_id,
                client_version: &self.client_version,
                artifact_id,
                artifact_sha256: expected_artifact_sha256,
                action,
                vm,
                instance,
            },
            now,
        )?;
        let mut response = response;
        response.device_proof = Some(
            URL_SAFE_NO_PAD.encode(
                signer
                    .sign_canonical(response.payload.as_bytes())
                    .map_err(map_store_error)?,
            ),
        );
        Ok(response)
    }

    /// Download an authorized artifact into a new file. The artifact is
    /// encrypted end-to-end between this process and the authorization
    /// service; the session key and partial plaintext are never persisted.
    pub async fn download_artifact_to(
        &self,
        artifact_id: &str,
        target_abi: &str,
        target_android: &str,
        destination: &Path,
    ) -> Result<ArtifactManifest, AuthorizationError> {
        let ephemeral = random_x25519_keypair();
        let signed = self
            .prepare_artifact(artifact_id, target_abi, target_android, &ephemeral.1)
            .await?;
        let manifest = signed.manifest;
        let shared = Zeroizing::new(derive_x25519_shared_secret(
            &ephemeral.0,
            &manifest.server_ephemeral_public_key,
        )?);
        let key = Zeroizing::new(derive_artifact_key(&shared, &manifest)?);
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        if !parent.is_dir() || destination.exists() {
            return Err(AuthorizationError::ArtifactIntegrityFailed);
        }
        let temporary = parent.join(format!(
            ".{}.part-{}",
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| AuthorizationError::Malformed(
                    "artifact destination is invalid".into()
                ))?,
            Uuid::new_v4().simple()
        ));
        let result = async {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| AuthorizationError::SecureStore(error.to_string()))?;
            let mut hasher = Sha256::new();
            let mut written = 0_u64;
            for index in 0..manifest.chunk_count {
                let chunk = self
                    .transport
                    .fetch_artifact_chunk(
                        &manifest.session_id,
                        artifact_id,
                        &manifest.transfer_id,
                        index,
                    )
                    .await?;
                if chunk.index != index {
                    return Err(AuthorizationError::ArtifactIntegrityFailed);
                }
                let ciphertext = URL_SAFE_NO_PAD
                    .decode(&chunk.ciphertext)
                    .map_err(|_| AuthorizationError::ArtifactIntegrityFailed)?;
                let plaintext = decrypt_artifact_chunk(&key, &manifest, index, &ciphertext)?;
                let expected = (manifest.size_bytes.saturating_sub(written))
                    .min(u64::from(manifest.chunk_size_bytes));
                if expected == 0 || plaintext.len() as u64 != expected {
                    return Err(AuthorizationError::ArtifactIntegrityFailed);
                }
                file.write_all(&plaintext)
                    .map_err(|error| AuthorizationError::SecureStore(error.to_string()))?;
                hasher.update(&plaintext);
                written = written.saturating_add(plaintext.len() as u64);
            }
            let digest = format!("{:x}", hasher.finalize());
            if written != manifest.size_bytes || digest != manifest.sha256 {
                return Err(AuthorizationError::ArtifactIntegrityFailed);
            }
            file.sync_all()
                .map_err(|error| AuthorizationError::SecureStore(error.to_string()))?;
            fs::rename(&temporary, destination)
                .map_err(|error| AuthorizationError::SecureStore(error.to_string()))?;
            Ok::<(), AuthorizationError>(())
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map(|()| manifest)
    }

    pub fn session(&self) -> Option<&AuthorizationSession> {
        self.session.as_ref()
    }

    pub fn adopt_session(&mut self, session: AuthorizationSession) {
        self.session = Some(session);
    }

    pub fn has_registration(&self) -> Result<bool, AuthorizationError> {
        Ok(self.registration()?.is_some())
    }

    pub fn clear_registration(&self) -> Result<(), AuthorizationError> {
        self.store
            .delete(REGISTRATION_STORE_KEY)
            .map_err(map_store_error)
    }

    fn material(&self) -> Result<DeviceAuthMaterial, AuthorizationError> {
        load_or_create_device_material_with(&self.store, self.security_policy)
            .map_err(map_store_error)
    }

    fn identity(&self) -> Result<DeviceIdentity, AuthorizationError> {
        Ok(self.material()?.identity)
    }

    fn signer(&self) -> Result<DeviceSigner, AuthorizationError> {
        Ok(self.material()?.signer)
    }

    fn security_snapshot(
        &self,
    ) -> Result<(DeviceSecurityLevel, ClientKeyAlgorithm), AuthorizationError> {
        let material = self.material()?;
        Ok((material.security_level, material.signer.algorithm()))
    }

    fn registration(&self) -> Result<Option<RegistrationRecord>, AuthorizationError> {
        let bytes = self
            .store
            .load(REGISTRATION_STORE_KEY)
            .map_err(map_store_error)?;
        bytes
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|error| {
                    AuthorizationError::SecureStore(format!(
                        "authorization registration is corrupt: {error}"
                    ))
                })
            })
            .transpose()
    }

    fn save_registration(
        &self,
        registration: &RegistrationRecord,
    ) -> Result<(), AuthorizationError> {
        let bytes = serde_json::to_vec(registration).map_err(|error| {
            AuthorizationError::SecureStore(format!(
                "serialize authorization registration: {error}"
            ))
        })?;
        self.store
            .save(REGISTRATION_STORE_KEY, &bytes)
            .map_err(map_store_error)
    }

    fn trusted_key(&self, key_id: &str) -> Result<&TrustedAuthorizationKey, AuthorizationError> {
        self.trusted_keys
            .iter()
            .find(|key| key.key_id == key_id)
            .ok_or(AuthorizationError::UnknownKey)
    }

    fn verify_lease(
        &self,
        lease: &SignedLease,
        server_time: i64,
        identity: &DeviceIdentity,
        requested: &[ProtectedCapability],
        minimum_now: Option<i64>,
    ) -> Result<LeaseClock, AuthorizationError> {
        let key = self.trusted_key(&lease.key_id)?;
        let now = lease_validation_now(server_time, current_unix_time()?, minimum_now);
        verify_signed_lease(lease, &key.public_key_base64url, now)?;
        if lease.claims.device_id != identity.device_id
            || lease.claims.client_version != self.client_version
            || lease.claims.capabilities != requested
        {
            return Err(AuthorizationError::BindingMismatch);
        }
        Ok(LeaseClock::new(now))
    }
}

fn lease_validation_now(server_time: i64, local_time: i64, minimum_now: Option<i64>) -> i64 {
    let response_now = server_time.max(local_time);
    minimum_now.map_or(response_now, |minimum| response_now.max(minimum))
}

fn ensure_registration_matches(
    registration: &RegistrationRecord,
    identity: &DeviceIdentity,
) -> Result<(), AuthorizationError> {
    if registration.device_id == identity.device_id {
        Ok(())
    } else {
        Err(AuthorizationError::BindingMismatch)
    }
}

fn ensure_signer_matches_identity(
    identity: &DeviceIdentity,
    signer: &DeviceSigner,
) -> Result<(), AuthorizationError> {
    if identity.public_key == signer.public_key_base64url() {
        Ok(())
    } else {
        Err(AuthorizationError::BindingMismatch)
    }
}

fn map_store_error(error: SecureStoreError) -> AuthorizationError {
    AuthorizationError::SecureStore(error.to_string())
}

fn current_unix_time() -> Result<i64, AuthorizationError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| AuthorizationError::Malformed("system clock is before Unix epoch".into()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationRuntimeStatus {
    pub status: AuthorizationStatus,
    pub device_id: Option<String>,
    pub session_id: Option<String>,
    pub expires_at: Option<i64>,
    pub detail: Option<String>,
    pub security_level: Option<DeviceSecurityLevel>,
    pub key_algorithm: Option<ClientKeyAlgorithm>,
    pub hardware_required: bool,
}

pub type RuntimeAuthorizationClient =
    AuthorizationClient<HttpAuthorizationTransport, WindowsSecureStore>;

static ACTIVE_SESSION: Lazy<Mutex<Option<AuthorizationSession>>> = Lazy::new(|| Mutex::new(None));

const BUILT_AUTH_BASE_URL: Option<&str> = option_env!("RDC_AUTH_BASE_URL");
const BUILT_AUTH_KEY_ID: Option<&str> = option_env!("RDC_AUTH_PUBLIC_KEY_ID");
const BUILT_AUTH_PUBLIC_KEY: Option<&str> = option_env!("RDC_AUTH_PUBLIC_KEY");
const BUILT_AUTH_PUBLIC_KEYS: Option<&str> = option_env!("RDC_AUTH_PUBLIC_KEYS");
const UNIVERSAL_CORE_ARTIFACT_ID: &str = "qemu-guest-script-universal";
const RESTORE_CORE_ANDROID_TARGET: &str = "any";

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuiltAuthorizationConfig {
    base_url: String,
    trusted_keys: Vec<TrustedAuthorizationKey>,
}

fn restore_core_artifact_spec() -> (&'static str, &'static str) {
    universal_core_artifact_spec()
}

fn universal_core_artifact_spec() -> (&'static str, &'static str) {
    (UNIVERSAL_CORE_ARTIFACT_ID, RESTORE_CORE_ANDROID_TARGET)
}

fn trusted_authorization_keys_from_env(
    value: &str,
) -> Result<Vec<TrustedAuthorizationKey>, AuthorizationError> {
    let mut keys = Vec::new();
    for entry in value.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err(AuthorizationError::Malformed(
                "authorization public-key ring contains an empty entry".into(),
            ));
        }
        let (key_id, public_key) = entry.split_once('=').ok_or_else(|| {
            AuthorizationError::Malformed(
                "authorization public-key ring entries must be key_id=public_key".into(),
            )
        })?;
        let key_id = key_id.trim();
        let public_key = public_key.trim();
        if key_id.is_empty() || public_key.is_empty() || key_id.contains(',') {
            return Err(AuthorizationError::Malformed(
                "authorization public-key ring entry is invalid".into(),
            ));
        }
        if keys
            .iter()
            .any(|key: &TrustedAuthorizationKey| key.key_id == key_id)
        {
            return Err(AuthorizationError::Malformed(
                "authorization public-key ring contains duplicate key_id".into(),
            ));
        }
        let key_bytes = URL_SAFE_NO_PAD.decode(public_key).map_err(|_| {
            AuthorizationError::Malformed("authorization public key is invalid".into())
        })?;
        let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
            AuthorizationError::Malformed("authorization public key must be 32 bytes".into())
        })?;
        VerifyingKey::from_bytes(&key_bytes).map_err(|_| {
            AuthorizationError::Malformed("authorization public key is invalid".into())
        })?;
        keys.push(TrustedAuthorizationKey {
            key_id: key_id.into(),
            public_key_base64url: public_key.into(),
        });
    }
    if keys.is_empty() {
        return Err(AuthorizationError::Malformed(
            "authorization public-key ring is empty".into(),
        ));
    }
    Ok(keys)
}

fn validate_authorization_base_url(base_url: &str) -> Result<(), AuthorizationError> {
    let url = reqwest::Url::parse(base_url)
        .map_err(|_| AuthorizationError::Transport("authorization URL is invalid".into()))?;
    let local_http = matches!(
        (url.scheme(), url.host_str()),
        ("http", Some("127.0.0.1" | "localhost" | "::1"))
    );
    if url.scheme() != "https" && !local_http {
        return Err(AuthorizationError::Transport(
            "authorization service must use HTTPS (HTTP is allowed only on loopback)".into(),
        ));
    }
    Ok(())
}

fn resolve_built_authorization_config(
    base_url: Option<&str>,
    public_keys: Option<&str>,
    legacy_key_id: Option<&str>,
    legacy_public_key: Option<&str>,
) -> Result<BuiltAuthorizationConfig, AuthorizationError> {
    let base_url = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AuthorizationError::Transport(
                "authorization service is not configured in this build".into(),
            )
        })?;
    validate_authorization_base_url(base_url)?;

    let trusted_keys = match public_keys {
        Some(value) => trusted_authorization_keys_from_env(value)?,
        None => {
            let key_id = legacy_key_id.ok_or(AuthorizationError::UnknownKey)?;
            let public_key = legacy_public_key.ok_or(AuthorizationError::UnknownKey)?;
            trusted_authorization_keys_from_env(&format!("{key_id}={public_key}"))?
        }
    };
    Ok(BuiltAuthorizationConfig {
        base_url: base_url.into(),
        trusted_keys,
    })
}

pub fn configured_runtime_client() -> Result<RuntimeAuthorizationClient, AuthorizationError> {
    let config = resolve_built_authorization_config(
        BUILT_AUTH_BASE_URL,
        BUILT_AUTH_PUBLIC_KEYS,
        BUILT_AUTH_KEY_ID,
        BUILT_AUTH_PUBLIC_KEY,
    )?;
    let transport = HttpAuthorizationTransport::new(&config.base_url)?;
    let store = WindowsSecureStore::from_app_data().map_err(map_store_error)?;
    Ok(AuthorizationClient::new_with_security_policy(
        transport,
        store,
        config.trusted_keys,
        env!("CARGO_PKG_VERSION"),
        "windows-x64",
        "redroid-device-center",
        configured_security_policy(),
    ))
}

fn configured_security_policy() -> DeviceSecurityPolicy {
    let require_hardware_backed = std::env::var("RDC_REQUIRE_HARDWARE_BACKED_KEYS")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false);
    DeviceSecurityPolicy {
        prefer_cng: true,
        require_hardware_backed,
    }
}

pub fn runtime_authorization_status() -> AuthorizationRuntimeStatus {
    let hardware_required = configured_security_policy().require_hardware_backed;
    let configured_client = configured_runtime_client();
    let security_result = configured_client
        .as_ref()
        .ok()
        .map(|client| client.security_snapshot());
    let security_level = security_result
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .map(|(level, _)| *level);
    let key_algorithm = security_result
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .map(|(_, algorithm)| *algorithm);
    let security_error = security_result
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .map(ToString::to_string);
    let active = ACTIVE_SESSION.lock().unwrap().clone();
    if let Some(session) = active {
        match session.lease_clock.now() {
            Ok(now) if session.lease.claims.exp > now => {
                return AuthorizationRuntimeStatus {
                    status: AuthorizationStatus::Ready,
                    device_id: Some(session.lease.claims.device_id),
                    session_id: Some(session.lease.claims.session_id),
                    expires_at: Some(session.lease.claims.exp),
                    detail: security_error.clone(),
                    security_level,
                    key_algorithm,
                    hardware_required,
                };
            }
            Ok(_) => {
                return AuthorizationRuntimeStatus {
                    status: AuthorizationStatus::LeaseExpired,
                    device_id: Some(session.lease.claims.device_id),
                    session_id: None,
                    expires_at: Some(session.lease.claims.exp),
                    detail: Some("authorization lease has expired".into()),
                    security_level,
                    key_algorithm,
                    hardware_required,
                };
            }
            Err(error) => {
                return AuthorizationRuntimeStatus {
                    status: AuthorizationStatus::ServerUnreachable,
                    device_id: None,
                    session_id: None,
                    expires_at: None,
                    detail: Some(error.to_string()),
                    security_level,
                    key_algorithm,
                    hardware_required,
                };
            }
        }
    }
    let mut status = AuthorizationRuntimeStatus {
        status: AuthorizationStatus::NotConfigured,
        device_id: None,
        session_id: None,
        expires_at: None,
        detail: security_error,
        security_level,
        key_algorithm,
        hardware_required,
    };
    let Ok(client) = configured_client else {
        status.detail = Some("authorization service is not configured in this build".into());
        return status;
    };
    match (client.identity(), client.has_registration()) {
        (Ok(identity), Ok(true)) => {
            status.status = AuthorizationStatus::AuthenticationRequired;
            status.device_id = Some(identity.device_id);
        }
        (Ok(identity), Ok(false)) => {
            status.status = AuthorizationStatus::NotRegistered;
            status.device_id = Some(identity.device_id);
        }
        (Err(error), _) | (_, Err(error)) => {
            status.detail = Some(error.to_string());
        }
    }
    status
}

pub async fn runtime_register() -> Result<CompleteRegistrationResponse, AuthorizationError> {
    let mut client = configured_runtime_client()?;
    client.register_client().await
}

pub async fn runtime_acquire(
    capability: ProtectedCapability,
) -> Result<AuthorizationSession, AuthorizationError> {
    runtime_acquire_capabilities(vec![capability]).await
}

pub async fn runtime_acquire_capabilities(
    capabilities: Vec<ProtectedCapability>,
) -> Result<AuthorizationSession, AuthorizationError> {
    let mut client = configured_runtime_client()?;
    let session = client.acquire_session(capabilities).await?;
    *ACTIVE_SESSION.lock().unwrap() = Some(session.clone());
    Ok(session)
}

pub async fn runtime_ensure(
    capability: ProtectedCapability,
) -> Result<AuthorizationSession, AuthorizationError> {
    runtime_ensure_capabilities(vec![capability]).await
}

pub async fn runtime_ensure_capabilities(
    capabilities: Vec<ProtectedCapability>,
) -> Result<AuthorizationSession, AuthorizationError> {
    if let Some(session) = ACTIVE_SESSION.lock().unwrap().clone() {
        if session.lease.claims.exp > session.lease_clock.now()? {
            if capabilities
                .iter()
                .all(|capability| session.lease.claims.capabilities.contains(capability))
            {
                return Ok(session);
            }
        }
    }
    runtime_acquire_capabilities(capabilities).await
}

#[derive(Debug, Clone)]
pub struct AuthorizedCoreArtifact {
    pub execution_grant: SignedExecutionGrant,
}

#[derive(Debug, Clone)]
pub struct AuthorizedCoreWorkflow {
    pub execution_grants: Vec<SignedExecutionGrant>,
}

pub async fn runtime_download_core_with_execution_grant(
    target_android: &str,
    vm: &str,
    instance: &str,
) -> Result<AuthorizedCoreArtifact, AuthorizationError> {
    runtime_download_core_artifact_with_execution_grant(
        "qemu-guest-script",
        target_android,
        "preset_apply",
        vm,
        instance,
    )
    .await
}

/// Download one protected runner and issue one single-use grant for each
/// runner stage. A create workflow invokes the runner three times
/// (build/seed/activate); reusing one JTI would either fail on stage two or
/// force the server to weaken its replay protection.
pub async fn runtime_download_core_with_execution_grants(
    target_android: &str,
    vm: &str,
    instance: &str,
    stage_count: usize,
) -> Result<AuthorizedCoreWorkflow, AuthorizationError> {
    runtime_download_core_artifact_with_execution_grants(
        "qemu-guest-script",
        target_android,
        "preset_apply",
        vm,
        instance,
        stage_count,
    )
    .await
}

pub async fn runtime_download_restore_core_with_execution_grant(
    vm: &str,
    instance: &str,
) -> Result<AuthorizedCoreArtifact, AuthorizationError> {
    let (artifact_id, target_android) = restore_core_artifact_spec();
    runtime_download_core_artifact_with_execution_grant(
        artifact_id,
        target_android,
        "preset_restore",
        vm,
        instance,
    )
    .await
}

pub async fn runtime_download_metadata_core_with_execution_grant(
    vm: &str,
) -> Result<AuthorizedCoreArtifact, AuthorizationError> {
    let (artifact_id, target_android) = universal_core_artifact_spec();
    runtime_download_core_artifact_with_execution_grant(
        artifact_id,
        target_android,
        "preset_details",
        vm,
        "batch",
    )
    .await
}

async fn runtime_download_core_artifact_with_execution_grant(
    artifact_id: &str,
    target_android: &str,
    action: &str,
    vm: &str,
    instance: &str,
) -> Result<AuthorizedCoreArtifact, AuthorizationError> {
    let workflow = runtime_download_core_artifact_with_execution_grants(
        artifact_id,
        target_android,
        action,
        vm,
        instance,
        1,
    )
    .await?;
    let mut execution_grants = workflow.execution_grants.into_iter();
    Ok(AuthorizedCoreArtifact {
        execution_grant: execution_grants
            .next()
            .expect("one execution grant was requested"),
    })
}

async fn runtime_download_core_artifact_with_execution_grants(
    artifact_id: &str,
    _target_android: &str,
    action: &str,
    vm: &str,
    instance: &str,
    stage_count: usize,
) -> Result<AuthorizedCoreWorkflow, AuthorizationError> {
    if stage_count == 0 {
        return Err(AuthorizationError::Malformed(
            "protected workflow must contain at least one execution stage".into(),
        ));
    }
    let session = runtime_ensure_capabilities(vec![
        ProtectedCapability::ProtectedPreset,
        ProtectedCapability::ProtectedArtifact,
    ])
    .await?;
    let mut client = configured_runtime_client()?;
    client.adopt_session(session);
    let mut execution_grants = Vec::with_capacity(stage_count);
    for _ in 0..stage_count {
        execution_grants.push(
            client
                .request_execution_grant(artifact_id, "", action, vm, instance)
                .await?,
        );
    }
    Ok(AuthorizedCoreWorkflow { execution_grants })
}

#[cfg(test)]
async fn download_artifact_with_session<T, S>(
    client: &mut AuthorizationClient<T, S>,
    session: AuthorizationSession,
    artifact_id: &str,
    target_abi: &str,
    target_android: &str,
    destination: &Path,
) -> Result<ArtifactManifest, AuthorizationError>
where
    T: AuthTransport,
    S: SecureStore,
{
    client.adopt_session(session);
    client
        .download_artifact_to(artifact_id, target_abi, target_android, destination)
        .await
}

pub async fn runtime_heartbeat() -> Result<AuthorizationSession, AuthorizationError> {
    let current = ACTIVE_SESSION
        .lock()
        .unwrap()
        .clone()
        .ok_or(AuthorizationError::LeaseExpired)?;
    let mut client = configured_runtime_client()?;
    client.adopt_session(current);
    let session = client.heartbeat().await?;
    *ACTIVE_SESSION.lock().unwrap() = Some(session.clone());
    Ok(session)
}

pub fn runtime_revoke_local() {
    ACTIVE_SESSION.lock().unwrap().take();
}

#[derive(Debug, Clone)]
pub struct HttpAuthorizationTransport {
    base_url: String,
    client: reqwest::Client,
}

impl HttpAuthorizationTransport {
    pub fn new(base_url: &str) -> Result<Self, AuthorizationError> {
        validate_authorization_base_url(base_url)?;
        let client = reqwest::Client::builder()
            .min_tls_version(reqwest::tls::Version::TLS_1_3)
            .build()
            .map_err(|_| {
                AuthorizationError::Transport("authorization HTTP client unavailable".into())
            })?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            client,
        })
    }

    async fn post_json<Req, Resp>(
        &self,
        path: &str,
        request: &Req,
    ) -> Result<Resp, AuthorizationError>
    where
        Req: Serialize + ?Sized,
        Resp: DeserializeOwned,
    {
        let response = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .json(request)
            .send()
            .await
            .map_err(|_| AuthorizationError::ServerUnreachable)?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        response
            .json::<Resp>()
            .await
            .map_err(|_| AuthorizationError::Transport("authorization response is invalid".into()))
    }
}

#[async_trait]
impl AuthTransport for HttpAuthorizationTransport {
    async fn register(
        &self,
        request: RegisterRequest,
    ) -> Result<RegisterResponse, AuthorizationError> {
        self.post_json("/v1/clients/register", &request).await
    }

    async fn complete_registration(
        &self,
        request: CompleteRegistrationRequest,
    ) -> Result<CompleteRegistrationResponse, AuthorizationError> {
        self.post_json("/v1/clients/register/complete", &request)
            .await
    }

    async fn acquire_session(
        &self,
        request: SessionRequest,
    ) -> Result<SessionResponse, AuthorizationError> {
        self.post_json("/v1/sessions", &request).await
    }

    async fn heartbeat(
        &self,
        session_id: &str,
        request: HeartbeatRequest,
    ) -> Result<SessionResponse, AuthorizationError> {
        self.post_json(&format!("/v1/sessions/{session_id}/heartbeat"), &request)
            .await
    }

    async fn prepare_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
        request: ArtifactPrepareRequest,
    ) -> Result<SignedArtifactManifest, AuthorizationError> {
        let response = self
            .client
            .post(format!(
                "{}{}",
                self.base_url,
                format!("/v1/artifacts/{artifact_id}/prepare")
            ))
            .bearer_auth(session_id)
            .json(&request)
            .send()
            .await
            .map_err(|_| AuthorizationError::ServerUnreachable)?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        response
            .json::<SignedArtifactManifest>()
            .await
            .map_err(|_| {
                AuthorizationError::Transport("artifact authorization response is invalid".into())
            })
    }

    async fn fetch_artifact_chunk(
        &self,
        session_id: &str,
        artifact_id: &str,
        transfer_id: &str,
        index: u32,
    ) -> Result<ArtifactChunkResponse, AuthorizationError> {
        let response = self
            .client
            .get(format!(
                "{}/v1/artifacts/{}/transfers/{}/chunks/{}",
                self.base_url, artifact_id, transfer_id, index
            ))
            .bearer_auth(session_id)
            .send()
            .await
            .map_err(|_| AuthorizationError::ServerUnreachable)?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        response
            .json::<ArtifactChunkResponse>()
            .await
            .map_err(|_| AuthorizationError::Transport("artifact chunk response is invalid".into()))
    }

    async fn issue_execution_grant(
        &self,
        session_id: &str,
        request: ExecutionGrantRequest,
    ) -> Result<SignedExecutionGrant, AuthorizationError> {
        let response = self
            .client
            .post(format!("{}/v1/execution-grants", self.base_url))
            .bearer_auth(session_id)
            .json(&request)
            .send()
            .await
            .map_err(|_| AuthorizationError::ServerUnreachable)?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        response.json::<SignedExecutionGrant>().await.map_err(|_| {
            AuthorizationError::Transport("execution grant response is invalid".into())
        })
    }
}

fn map_http_error(status: reqwest::StatusCode) -> AuthorizationError {
    match status {
        reqwest::StatusCode::CONFLICT => AuthorizationError::Replay,
        reqwest::StatusCode::UNAUTHORIZED => AuthorizationError::AuthenticationRequired,
        reqwest::StatusCode::FORBIDDEN => AuthorizationError::Revoked,
        _ => AuthorizationError::Transport(format!(
            "authorization server returned HTTP {}",
            status.as_u16()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::authorization::ExecutionGrantClaims;
    use crate::services::secure_store::{
        ensure_device_identity_with, load_device_signer_with, MemorySecureStore,
    };
    use async_trait::async_trait;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const TEST_KEY: [u8; 32] = [9; 32];

    #[test]
    fn registration_payload_declares_the_client_key_algorithm() {
        let request = RegisterRequest {
            install_id: "install-a".into(),
            device_id: "device-a".into(),
            client_version: "1.0.0".into(),
            platform: "windows-x64".into(),
            device_public_key: "public-key".into(),
            client_key_algorithm: ClientKeyAlgorithm::Ed25519DpapiV1,
            requested_product: "redroid-device-center".into(),
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["client_key_algorithm"], "ed25519-dpapi-v1");
    }

    #[test]
    fn runtime_security_status_serializes_only_public_security_metadata() {
        let status = AuthorizationRuntimeStatus {
            status: AuthorizationStatus::NotRegistered,
            device_id: Some("device-a".into()),
            session_id: None,
            expires_at: None,
            detail: None,
            security_level: Some(DeviceSecurityLevel::DpapiSoftwareFallback),
            key_algorithm: Some(ClientKeyAlgorithm::Ed25519DpapiV1),
            hardware_required: false,
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["securityLevel"], "dpapi_software_fallback");
        assert_eq!(value["keyAlgorithm"], "ed25519-dpapi-v1");
        assert!(!serde_json::to_string(&value).unwrap().contains("private"));
        assert!(!serde_json::to_string(&value).unwrap().contains("DPAPI"));
    }

    #[test]
    fn signer_public_key_must_match_the_stable_device_identity() {
        let store = MemorySecureStore::default();
        ensure_device_identity_with(&store).unwrap();
        let signer = load_device_signer_with(&store).unwrap();
        let identity = DeviceIdentity {
            install_id: "install-a".into(),
            device_id: "device-a".into(),
            public_key: "different-public-key".into(),
        };
        assert_eq!(
            ensure_signer_matches_identity(&identity, &signer),
            Err(AuthorizationError::BindingMismatch)
        );
    }

    #[derive(Default)]
    struct FakeTransport {
        lease: Mutex<Option<SessionResponse>>,
        registrations: Mutex<Vec<CompleteRegistrationResponse>>,
        execution_grant: Mutex<Option<SignedExecutionGrant>>,
    }

    #[async_trait]
    impl AuthTransport for FakeTransport {
        async fn register(
            &self,
            request: RegisterRequest,
        ) -> Result<RegisterResponse, AuthorizationError> {
            Ok(RegisterResponse {
                client_id: "client-a".into(),
                device_id: request.device_id,
                challenge: "challenge-a".into(),
                key_id: "test-key".into(),
                status: "pending".into(),
            })
        }

        async fn complete_registration(
            &self,
            request: CompleteRegistrationRequest,
        ) -> Result<CompleteRegistrationResponse, AuthorizationError> {
            let response = CompleteRegistrationResponse {
                client_id: request.client_id,
                device_id: "device-placeholder".into(),
                status: "pending".into(),
            };
            self.registrations.lock().unwrap().push(response.clone());
            Ok(response)
        }

        async fn acquire_session(
            &self,
            _request: SessionRequest,
        ) -> Result<SessionResponse, AuthorizationError> {
            self.lease
                .lock()
                .unwrap()
                .clone()
                .ok_or(AuthorizationError::ServerUnreachable)
        }

        async fn heartbeat(
            &self,
            _session_id: &str,
            _request: HeartbeatRequest,
        ) -> Result<SessionResponse, AuthorizationError> {
            self.lease
                .lock()
                .unwrap()
                .clone()
                .ok_or(AuthorizationError::ServerUnreachable)
        }

        async fn prepare_artifact(
            &self,
            _session_id: &str,
            _artifact_id: &str,
            _request: ArtifactPrepareRequest,
        ) -> Result<SignedArtifactManifest, AuthorizationError> {
            Err(AuthorizationError::ServerUnreachable)
        }

        async fn fetch_artifact_chunk(
            &self,
            _session_id: &str,
            _artifact_id: &str,
            _transfer_id: &str,
            _index: u32,
        ) -> Result<ArtifactChunkResponse, AuthorizationError> {
            Err(AuthorizationError::ServerUnreachable)
        }

        async fn issue_execution_grant(
            &self,
            _session_id: &str,
            _request: ExecutionGrantRequest,
        ) -> Result<SignedExecutionGrant, AuthorizationError> {
            self.execution_grant
                .lock()
                .unwrap()
                .clone()
                .ok_or(AuthorizationError::ServerUnreachable)
        }
    }

    fn test_client() -> AuthorizationClient<FakeTransport, MemorySecureStore> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        test_client_with_capabilities(now + 900, now, vec![ProtectedCapability::ProtectedPreset])
    }

    fn test_client_with_lease(
        exp: i64,
        server_time: i64,
    ) -> AuthorizationClient<FakeTransport, MemorySecureStore> {
        test_client_with_capabilities(exp, server_time, vec![ProtectedCapability::ProtectedPreset])
    }

    fn test_client_with_capabilities(
        exp: i64,
        server_time: i64,
        capabilities: Vec<ProtectedCapability>,
    ) -> AuthorizationClient<FakeTransport, MemorySecureStore> {
        let store = MemorySecureStore::default();
        let identity = ensure_device_identity_with(&store).unwrap();
        let registration = RegistrationRecord {
            client_id: "client-a".into(),
            device_id: identity.device_id.clone(),
        };
        store
            .save(
                REGISTRATION_STORE_KEY,
                &serde_json::to_vec(&registration).unwrap(),
            )
            .unwrap();
        let signing = SigningKey::from_bytes(&TEST_KEY);
        let claims = crate::services::authorization::LeaseClaims {
            iss: "rdc-auth".into(),
            aud: "rdc-client".into(),
            sub: "account-a".into(),
            client_id: "client-a".into(),
            device_id: identity.device_id,
            session_id: "session-a".into(),
            capabilities,
            client_version: "1.0.0".into(),
            iat: server_time - 1,
            exp,
            jti: "jti-a".into(),
            nonce: "nonce-a".into(),
        };
        let signature = URL_SAFE_NO_PAD.encode(
            signing
                .sign(&serde_json::to_vec(&claims).unwrap())
                .to_bytes(),
        );
        let fake = FakeTransport {
            lease: Mutex::new(Some(SessionResponse {
                lease: SignedLease {
                    key_id: "test-key".into(),
                    claims,
                    signature,
                },
                server_time,
            })),
            ..Default::default()
        };
        AuthorizationClient::new(
            fake,
            store,
            vec![TrustedAuthorizationKey {
                key_id: "test-key".into(),
                public_key_base64url: URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
            }],
            "1.0.0",
            "windows-x64",
            "redroid-device-center",
        )
    }

    #[tokio::test]
    async fn client_accepts_a_signed_lease_only_for_the_registered_device() {
        let mut client = test_client();
        let session = client
            .acquire_session(vec![ProtectedCapability::ProtectedPreset])
            .await
            .unwrap();
        assert_eq!(session.lease.claims.session_id, "session-a");
    }

    #[tokio::test]
    async fn download_path_adopts_the_active_session_before_requesting_artifact() {
        let capabilities = vec![
            ProtectedCapability::ProtectedPreset,
            ProtectedCapability::ProtectedArtifact,
        ];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let mut source = test_client_with_capabilities(now + 900, now, capabilities.clone());
        let session = source.acquire_session(capabilities).await.unwrap();
        let mut download_client = source;
        download_client.session = None;
        assert!(download_client.session().is_none());

        let result = download_artifact_with_session(
            &mut download_client,
            session.clone(),
            "artifact-a",
            "x86_64",
            "android-13",
            Path::new("artifact-a"),
        )
        .await;

        assert_eq!(result, Err(AuthorizationError::ServerUnreachable));
        assert_eq!(download_client.session(), Some(&session));
    }

    #[tokio::test]
    async fn client_accepts_an_execution_grant_only_after_binding_it_to_the_active_session() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let mut client = test_client_with_capabilities(
            now + 900,
            now,
            vec![
                ProtectedCapability::ProtectedPreset,
                ProtectedCapability::ProtectedArtifact,
            ],
        );
        let session = client
            .acquire_session(vec![
                ProtectedCapability::ProtectedPreset,
                ProtectedCapability::ProtectedArtifact,
            ])
            .await
            .unwrap();
        let identity = client.identity().unwrap();
        let artifact_sha256 = "a".repeat(64);
        let claims = ExecutionGrantClaims {
            iss: "rdc-auth".into(),
            aud: "rdc-guest-runner".into(),
            client_id: "client-a".into(),
            device_id: identity.device_id,
            session_id: session.lease.claims.session_id.clone(),
            client_version: "1.0.0".into(),
            artifact_id: "core-a".into(),
            artifact_sha256: artifact_sha256.clone(),
            action: "preset_apply".into(),
            vm: "node1".into(),
            instance: "r13".into(),
            iat: now,
            exp: now + 120,
            jti: "grant-a".into(),
            nonce: "nonce-grant-a".into(),
        };
        let signing = SigningKey::from_bytes(&TEST_KEY);
        let payload = serde_json::to_vec(&claims).unwrap();
        client
            .transport
            .execution_grant
            .lock()
            .unwrap()
            .replace(SignedExecutionGrant {
                key_id: "test-key".into(),
                payload: URL_SAFE_NO_PAD.encode(payload.clone()),
                signature: URL_SAFE_NO_PAD.encode(signing.sign(&payload).to_bytes()),
                device_proof: None,
            });

        let grant = client
            .request_execution_grant("core-a", &artifact_sha256, "preset_apply", "node1", "r13")
            .await
            .unwrap();
        assert_eq!(grant.key_id, "test-key");
        assert!(grant.device_proof.is_some());
    }

    #[tokio::test]
    async fn client_rejects_an_expired_lease_even_when_server_time_is_stale() {
        let local_now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let mut client = test_client_with_lease(local_now - 1, local_now - 600);

        assert_eq!(
            client
                .acquire_session(vec![ProtectedCapability::ProtectedPreset])
                .await,
            Err(AuthorizationError::LeaseExpired)
        );
    }

    #[test]
    fn active_lease_clock_uses_monotonic_elapsed_time() {
        let clock = LeaseClock::new(1_000);
        let anchor = clock.anchor_instant;

        assert_eq!(
            clock.now_at(anchor + Duration::from_secs(60)).unwrap(),
            1_060
        );
        assert_eq!(
            clock.now_at(anchor + Duration::from_secs(60)).unwrap(),
            1_060
        );
        assert_eq!(clock.now_at(anchor).unwrap(), 1_000);
    }

    #[test]
    fn lease_validation_clock_keeps_the_existing_session_floor() {
        assert_eq!(lease_validation_now(900, 800, Some(1_000)), 1_000);
        assert_eq!(lease_validation_now(1_200, 800, Some(1_000)), 1_200);
    }

    #[tokio::test]
    async fn client_refuses_a_session_before_registration() {
        let store = MemorySecureStore::default();
        let client = AuthorizationClient::new(
            FakeTransport::default(),
            store,
            vec![],
            "1.0.0",
            "windows-x64",
            "redroid-device-center",
        );
        let mut client = client;
        assert_eq!(
            client
                .acquire_session(vec![ProtectedCapability::ProtectedPreset])
                .await,
            Err(AuthorizationError::NotRegistered)
        );
    }

    #[test]
    fn restore_core_artifact_is_version_independent() {
        assert_eq!(
            restore_core_artifact_spec(),
            ("qemu-guest-script-universal", "any")
        );
    }

    #[test]
    fn metadata_core_artifact_is_the_same_universal_version_independent_runner() {
        assert_eq!(
            universal_core_artifact_spec(),
            ("qemu-guest-script-universal", "any")
        );
    }

    #[test]
    fn public_key_ring_accepts_old_and_new_keys_for_rotation() {
        let old = SigningKey::from_bytes(&[9; 32]);
        let next = SigningKey::from_bytes(&[8; 32]);
        let value = format!(
            "auth-2026-01={},auth-2026-02={}",
            URL_SAFE_NO_PAD.encode(old.verifying_key().to_bytes()),
            URL_SAFE_NO_PAD.encode(next.verifying_key().to_bytes())
        );
        let keys = trusted_authorization_keys_from_env(&value).unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].key_id, "auth-2026-01");
        assert_eq!(keys[1].key_id, "auth-2026-02");
    }

    #[test]
    fn public_key_ring_rejects_duplicate_ids_and_malformed_keys() {
        let key =
            URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[9; 32]).verifying_key().to_bytes());
        assert!(trusted_authorization_keys_from_env(&format!(
            "auth-2026-01={key},auth-2026-01={key}"
        ))
        .is_err());
        assert!(trusted_authorization_keys_from_env("auth-2026-01=not-a-key").is_err());
        assert!(trusted_authorization_keys_from_env(" ").is_err());
    }

    #[test]
    fn release_configuration_requires_service_and_verifier_keys() {
        let key =
            URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&TEST_KEY).verifying_key().to_bytes());

        assert!(matches!(
            resolve_built_authorization_config(
                None,
                Some(&format!("auth-2026-01={key}")),
                None,
                None
            ),
            Err(AuthorizationError::Transport(_))
        ));
        assert!(matches!(
            resolve_built_authorization_config(Some("https://auth.example.test"), None, None, None),
            Err(AuthorizationError::UnknownKey)
        ));
        let config = resolve_built_authorization_config(
            Some("https://auth.example.test"),
            Some(&format!("auth-2026-01={key}")),
            None,
            None,
        )
        .unwrap();
        assert_eq!(config.base_url, "https://auth.example.test");
        assert_eq!(config.trusted_keys.len(), 1);
    }

    #[test]
    fn release_configuration_rejects_non_loopback_http() {
        let key =
            URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&TEST_KEY).verifying_key().to_bytes());
        assert!(matches!(
            resolve_built_authorization_config(
                Some("http://auth.example.test"),
                Some(&format!("auth-2026-01={key}")),
                None,
                None,
            ),
            Err(AuthorizationError::Transport(_))
        ));
    }

    #[test]
    fn release_configuration_rejects_an_explicitly_empty_key_ring() {
        let key =
            URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&TEST_KEY).verifying_key().to_bytes());
        assert!(matches!(
            resolve_built_authorization_config(
                Some("https://auth.example.test"),
                Some(" "),
                Some("legacy-key"),
                Some(&key),
            ),
            Err(AuthorizationError::Malformed(_))
        ));
    }
}
