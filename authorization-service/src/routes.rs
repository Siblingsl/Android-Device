use crate::crypto::{
    canonical_json, derive_x25519_shared_secret, encrypt_artifact_chunk, random_nonce_prefix,
    random_x25519_keypair, sha256_file, validate_public_key_base64url, ArtifactManifest,
    ClientKeyAlgorithm, ExecutionGrantClaims, HeartbeatProof, LeaseClaims, ProtectedCapability,
    RegistrationProof, SessionProof, SignedArtifactManifest, SignedExecutionGrant, SignedLease,
    SigningAuthority, ARTIFACT_CHUNK_SIZE, LEASE_MAX_SECS,
};
use crate::store::{ArtifactRecord, AuthStore, ClientRecord, SessionRecord, StoreError};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    sync::Mutex,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const CHALLENGE_TTL_SECS: i64 = 5 * 60;
const ARTIFACT_TTL_SECS: i64 = 5 * 60;
const EXECUTION_GRANT_TTL_SECS: i64 = 2 * 60;
const DEFAULT_MAX_ACTIVE_TRANSFERS: usize = 128;
const MAX_CONTROL_PLANE_BODY_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct ArtifactTransfer {
    artifact_id: String,
    session_id: String,
    device_id: String,
    path: PathBuf,
    manifest: ArtifactManifest,
    shared_secret: Zeroizing<[u8; 32]>,
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<AuthStore>,
    pub authority: SigningAuthority,
    pub artifact_root: PathBuf,
    transfers: Arc<Mutex<HashMap<String, ArtifactTransfer>>>,
    max_active_transfers: usize,
}

async fn no_store_sensitive_responses(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

impl AppState {
    pub fn new(store: AuthStore, authority: SigningAuthority, artifact_root: PathBuf) -> Self {
        Self::with_transfer_limit(
            store,
            authority,
            artifact_root,
            DEFAULT_MAX_ACTIVE_TRANSFERS,
        )
    }

    pub fn with_transfer_limit(
        store: AuthStore,
        authority: SigningAuthority,
        artifact_root: PathBuf,
        max_active_transfers: usize,
    ) -> Self {
        Self {
            store: Arc::new(store),
            authority,
            artifact_root,
            transfers: Arc::new(Mutex::new(HashMap::new())),
            max_active_transfers: max_active_transfers.max(1),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/clients/register", post(register_client))
        .route("/v1/clients/register/complete", post(complete_registration))
        .route("/v1/sessions", post(create_session))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/sessions/{session_id}/heartbeat", post(heartbeat))
        .route("/v1/sessions/{session_id}/close", post(close_session))
        .route("/v1/execution-grants", post(issue_execution_grant))
        .route(
            "/v1/execution-grants/consume",
            post(consume_execution_grant),
        )
        .route(
            "/v1/artifacts/{artifact_id}/prepare",
            post(prepare_artifact),
        )
        .route(
            "/v1/artifacts/{artifact_id}/transfers/{transfer_id}/chunks/{index}",
            get(artifact_chunk),
        )
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_CONTROL_PLANE_BODY_BYTES))
        .layer(middleware::from_fn(no_store_sensitive_responses))
}

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    fn bad_request(message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    fn unauthorized(message: &'static str) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn forbidden(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    fn conflict(message: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, "replay", message)
    }

    fn service_unavailable(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
    }

    fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "authorization service failed",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(_: StoreError) -> Self {
        Self::internal()
    }
}

fn now() -> Result<i64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| ApiError::internal())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RegisterRequest {
    pub install_id: String,
    pub device_id: String,
    pub client_version: String,
    pub platform: String,
    pub device_public_key: String,
    #[serde(default)]
    pub client_key_algorithm: ClientKeyAlgorithm,
    pub requested_product: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RegisterResponse {
    pub client_id: String,
    pub device_id: String,
    pub challenge: String,
    pub key_id: String,
    pub status: &'static str,
}

async fn register_client(
    State(state): State<AppState>,
    Json(request): Json<RegisterRequest>,
) -> Result<Json<RegisterResponse>, ApiError> {
    if request.install_id.trim().is_empty()
        || request.device_id.trim().is_empty()
        || request.client_version.trim().is_empty()
        || request.platform.trim().is_empty()
        || request.requested_product.trim().is_empty()
    {
        return Err(ApiError::bad_request("registration fields are required"));
    }
    validate_public_key_base64url(request.client_key_algorithm, &request.device_public_key)
        .map_err(|_| ApiError::bad_request("device public key is invalid"))?;
    let now = now()?;
    let device_id = request.device_id;
    let client_id = match state.store.client_by_device(&device_id)? {
        Some(client) => {
            if client.revoked {
                return Err(ApiError::forbidden("revoked", "client has been revoked"));
            }
            if client.device_public_key != request.device_public_key {
                return Err(ApiError::forbidden(
                    "binding_mismatch",
                    "device key is already registered to another identity",
                ));
            }
            if client.client_key_algorithm != request.client_key_algorithm {
                return Err(ApiError::forbidden(
                    "binding_mismatch",
                    "device key algorithm is already registered to another identity",
                ));
            }
            client.client_id
        }
        None => {
            let client_id = Uuid::new_v4().to_string();
            let account_id = format!("pending:{client_id}");
            state.store.create_pending_client(
                &client_id,
                &account_id,
                &device_id,
                &request.device_public_key,
                request.client_key_algorithm,
                &request.client_version,
                now,
            )?;
            client_id
        }
    };
    let challenge = SigningAuthority::random_nonce();
    state.store.set_registration_challenge(
        &client_id,
        &challenge,
        &request.client_version,
        now.saturating_add(CHALLENGE_TTL_SECS),
    )?;
    Ok(Json(RegisterResponse {
        client_id,
        device_id,
        challenge,
        key_id: state.authority.key_id().to_owned(),
        status: "pending",
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CompleteRegistrationRequest {
    pub client_id: String,
    pub challenge: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CompleteRegistrationResponse {
    pub client_id: String,
    pub device_id: String,
    pub status: &'static str,
}

async fn complete_registration(
    State(state): State<AppState>,
    Json(request): Json<CompleteRegistrationRequest>,
) -> Result<Json<CompleteRegistrationResponse>, ApiError> {
    let client = state
        .store
        .client(&request.client_id)?
        .ok_or_else(|| ApiError::unauthorized("registration client is unknown"))?;
    let now = now()?;
    let Some(_) =
        state
            .store
            .registration_challenge(&request.client_id, &request.challenge, now)?
    else {
        return Err(ApiError::unauthorized("registration challenge is invalid"));
    };
    let proof = RegistrationProof {
        client_id: &request.client_id,
        challenge: &request.challenge,
    };
    let payload = canonical_json(&proof).map_err(|_| ApiError::internal())?;
    state
        .authority
        .verify_client_signature(
            client.client_key_algorithm,
            &client.device_public_key,
            &payload,
            &request.signature,
        )
        .map_err(|_| ApiError::unauthorized("registration signature is invalid"))?;
    let Some(requested_client_version) =
        state
            .store
            .take_registration_challenge(&request.client_id, &request.challenge, now)?
    else {
        return Err(ApiError::unauthorized("registration challenge is invalid"));
    };
    let requested_client_version = if requested_client_version.trim().is_empty() {
        client.client_version.clone()
    } else {
        requested_client_version
    };
    state.store.update_client_registration(
        &client.client_id,
        &client.device_public_key,
        client.client_key_algorithm,
        &requested_client_version,
    )?;
    Ok(Json(CompleteRegistrationResponse {
        client_id: client.client_id,
        device_id: client.device_id,
        status: if client.approved {
            "approved"
        } else {
            "pending"
        },
    }))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionRequest {
    pub client_id: String,
    pub device_id: String,
    pub client_version: String,
    pub nonce: String,
    pub capabilities: Vec<ProtectedCapability>,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionResponse {
    pub lease: SignedLease,
    pub server_time: i64,
}

async fn create_session(
    State(state): State<AppState>,
    Json(request): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    let now = now()?;
    if request.client_id.trim().is_empty()
        || request.device_id.trim().is_empty()
        || request.client_version.trim().is_empty()
        || request.nonce.trim().is_empty()
        || request.capabilities.is_empty()
    {
        return Err(ApiError::bad_request("session fields are required"));
    }
    let client = state
        .store
        .client(&request.client_id)?
        .ok_or_else(|| ApiError::unauthorized("client is unknown"))?;
    ensure_client_usable(&client, &request.device_id)?;
    if client.client_version != request.client_version {
        return Err(ApiError::forbidden(
            "client_outdated",
            "client version does not match the registered version",
        ));
    }
    let proof = SessionProof {
        client_id: &request.client_id,
        device_id: &request.device_id,
        client_version: &request.client_version,
        nonce: &request.nonce,
        capabilities: &request.capabilities,
    };
    let payload = canonical_json(&proof).map_err(|_| ApiError::internal())?;
    state
        .authority
        .verify_client_signature(
            client.client_key_algorithm,
            &client.device_public_key,
            &payload,
            &request.signature,
        )
        .map_err(|_| ApiError::unauthorized("session signature is invalid"))?;
    if !state.store.consume_nonce(&request.nonce, now)? {
        return Err(ApiError::conflict("session nonce has already been used"));
    }
    for capability in &request.capabilities {
        if !state
            .store
            .has_entitlement(&client.account_id, *capability)?
        {
            return Err(ApiError::forbidden(
                "capability_not_entitled",
                "requested capability is not entitled",
            ));
        }
    }
    state
        .store
        .revoke_active_sessions_for_client(&client.client_id, now)?;
    let session_id = Uuid::new_v4().to_string();
    let jti = Uuid::new_v4().to_string();
    let exp = now.saturating_add(LEASE_MAX_SECS);
    let lease = make_lease(
        &state,
        &client,
        &session_id,
        request.capabilities.clone(),
        &request.nonce,
        &jti,
        now,
        exp,
    );
    state
        .store
        .create_session(&session_id, &client, &request.capabilities, &jti, exp, now)?;
    Ok(Json(SessionResponse {
        lease,
        server_time: now,
    }))
}

fn ensure_client_usable(client: &ClientRecord, device_id: &str) -> Result<(), ApiError> {
    if client.revoked {
        return Err(ApiError::forbidden("revoked", "client has been revoked"));
    }
    if !client.approved {
        return Err(ApiError::forbidden(
            "authentication_required",
            "client registration is pending approval",
        ));
    }
    if client.device_id != device_id {
        return Err(ApiError::forbidden(
            "binding_mismatch",
            "device binding does not match",
        ));
    }
    Ok(())
}

// These arguments map one-to-one to the signed protocol claims; keeping them
// explicit makes it harder to omit a binding field when issuing a lease.
#[allow(clippy::too_many_arguments)]
fn make_lease(
    state: &AppState,
    client: &ClientRecord,
    session_id: &str,
    capabilities: Vec<ProtectedCapability>,
    nonce: &str,
    jti: &str,
    iat: i64,
    exp: i64,
) -> SignedLease {
    state.authority.sign_claims(LeaseClaims {
        iss: "rdc-auth".into(),
        aud: "rdc-client".into(),
        sub: client.account_id.clone(),
        client_id: client.client_id.clone(),
        device_id: client.device_id.clone(),
        session_id: session_id.into(),
        capabilities,
        client_version: client.client_version.clone(),
        iat,
        exp,
        jti: jti.into(),
        nonce: nonce.into(),
    })
}

fn session_from_headers(
    state: &AppState,
    headers: &HeaderMap,
    now: i64,
) -> Result<SessionRecord, ApiError> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("session authorization is required"))?;
    let session_id = value
        .strip_prefix("Bearer ")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::unauthorized("session authorization is invalid"))?;
    let session = state
        .store
        .session(session_id)?
        .ok_or_else(|| ApiError::unauthorized("session is unknown"))?;
    if session.revoked {
        return Err(ApiError::forbidden("revoked", "session has been revoked"));
    }
    if session.exp <= now {
        return Err(ApiError::unauthorized("session lease has expired"));
    }
    let client = state
        .store
        .client(&session.client_id)?
        .ok_or_else(|| ApiError::unauthorized("client is unknown"))?;
    ensure_client_usable(&client, &session.device_id)?;
    for capability in &session.capabilities {
        if !state
            .store
            .has_entitlement(&client.account_id, *capability)?
        {
            state.store.revoke_session(&session.session_id)?;
            return Err(ApiError::forbidden(
                "revoked",
                "a session capability has been revoked",
            ));
        }
    }
    Ok(session)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CapabilitiesResponse {
    pub session_id: String,
    pub capabilities: Vec<ProtectedCapability>,
    pub expires_at: i64,
}

async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CapabilitiesResponse>, ApiError> {
    let session = session_from_headers(&state, &headers, now()?)?;
    Ok(Json(CapabilitiesResponse {
        session_id: session.session_id,
        capabilities: session.capabilities,
        expires_at: session.exp,
    }))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HeartbeatRequest {
    pub client_id: String,
    pub device_id: String,
    pub nonce: String,
    pub signature: String,
}

async fn heartbeat(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(request): Json<HeartbeatRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    let now = now()?;
    let session = state
        .store
        .session(&session_id)?
        .ok_or_else(|| ApiError::unauthorized("session is unknown"))?;
    if session.revoked || session.exp <= now {
        return Err(ApiError::forbidden(
            if session.revoked {
                "revoked"
            } else {
                "lease_expired"
            },
            "session cannot be renewed",
        ));
    }
    if session.client_id != request.client_id || session.device_id != request.device_id {
        return Err(ApiError::forbidden(
            "binding_mismatch",
            "heartbeat binding does not match",
        ));
    }
    let client = state
        .store
        .client(&session.client_id)?
        .ok_or_else(|| ApiError::unauthorized("client is unknown"))?;
    ensure_client_usable(&client, &request.device_id)?;
    let proof = HeartbeatProof {
        session_id: &session_id,
        client_id: &request.client_id,
        device_id: &request.device_id,
        nonce: &request.nonce,
    };
    let payload = canonical_json(&proof).map_err(|_| ApiError::internal())?;
    state
        .authority
        .verify_client_signature(
            client.client_key_algorithm,
            &client.device_public_key,
            &payload,
            &request.signature,
        )
        .map_err(|_| ApiError::unauthorized("heartbeat signature is invalid"))?;
    if !state.store.consume_nonce(&request.nonce, now)? {
        return Err(ApiError::conflict("heartbeat nonce has already been used"));
    }
    for capability in &session.capabilities {
        if !state
            .store
            .has_entitlement(&client.account_id, *capability)?
        {
            state.store.revoke_session(&session_id)?;
            return Err(ApiError::forbidden(
                "revoked",
                "a session capability has been revoked",
            ));
        }
    }
    let jti = Uuid::new_v4().to_string();
    let exp = now.saturating_add(LEASE_MAX_SECS);
    let lease = make_lease(
        &state,
        &client,
        &session_id,
        session.capabilities.clone(),
        &request.nonce,
        &jti,
        now,
        exp,
    );
    if !state
        .store
        .refresh_session(&session_id, &session.capabilities, &jti, exp)?
    {
        return Err(ApiError::forbidden("revoked", "session has been revoked"));
    }
    Ok(Json(SessionResponse {
        lease,
        server_time: now,
    }))
}

async fn close_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let session = session_from_headers(&state, &headers, now()?)?;
    if session.session_id != session_id {
        return Err(ApiError::forbidden(
            "binding_mismatch",
            "session binding does not match",
        ));
    }
    state.store.revoke_session(&session_id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExecutionGrantRequest {
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub action: String,
    pub vm: String,
    pub instance: String,
    pub nonce: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConsumeExecutionGrantRequest {
    pub grant: SignedExecutionGrant,
}

fn valid_execution_action(action: &str) -> bool {
    matches!(action, "preset_apply" | "preset_restore" | "preset_details")
}

fn artifact_allows_execution_action(artifact_id: &str, action: &str) -> bool {
    matches!(
        (artifact_id, action),
        ("qemu-guest-script", "preset_apply")
            | (
                "qemu-guest-script-universal",
                "preset_restore" | "preset_details"
            )
    )
}

async fn issue_execution_grant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ExecutionGrantRequest>,
) -> Result<Json<SignedExecutionGrant>, ApiError> {
    let now = now()?;
    let session = session_from_headers(&state, &headers, now)?;
    if !session
        .capabilities
        .contains(&ProtectedCapability::ProtectedPreset)
        || !session
            .capabilities
            .contains(&ProtectedCapability::ProtectedArtifact)
    {
        return Err(ApiError::forbidden(
            "missing_capability",
            "preset capability is not present",
        ));
    }
    if request.artifact_id.trim().is_empty()
        || request.artifact_sha256.len() != 64
        || !request
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.action.trim().is_empty()
        || !valid_execution_action(&request.action)
        || request.vm.trim().is_empty()
        || request.instance.trim().is_empty()
        || request.nonce.trim().is_empty()
    {
        return Err(ApiError::bad_request("execution grant fields are invalid"));
    }
    let artifact = state
        .store
        .artifact(&request.artifact_id)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found", "artifact is unknown"))?;
    if !artifact_allows_execution_action(&artifact.artifact_id, &request.action) {
        return Err(ApiError::forbidden(
            "artifact_workflow_mismatch",
            "execution artifact is not approved for this workflow",
        ));
    }
    let path = safe_artifact_path(&state.artifact_root, &artifact)?;
    let (_, actual_sha256) = sha256_file(&path).map_err(|_| ApiError::internal())?;
    if actual_sha256 != request.artifact_sha256 {
        return Err(ApiError::forbidden(
            "artifact_integrity",
            "execution artifact hash does not match the published artifact",
        ));
    }
    if !state.store.consume_nonce(&request.nonce, now)? {
        return Err(ApiError::conflict(
            "execution grant nonce has already been used",
        ));
    }
    let client = state
        .store
        .client(&session.client_id)?
        .ok_or_else(|| ApiError::unauthorized("client is unknown"))?;
    let exp = session
        .exp
        .min(now.saturating_add(EXECUTION_GRANT_TTL_SECS));
    if exp <= now {
        return Err(ApiError::unauthorized("session lease has expired"));
    }
    Ok(Json(state.authority.sign_execution_grant(
        ExecutionGrantClaims {
            iss: "rdc-auth".into(),
            aud: "rdc-guest-runner".into(),
            client_id: client.client_id,
            device_id: session.device_id,
            session_id: session.session_id,
            client_version: client.client_version,
            artifact_id: request.artifact_id,
            artifact_sha256: request.artifact_sha256,
            action: request.action,
            vm: request.vm,
            instance: request.instance,
            iat: now,
            exp,
            jti: Uuid::new_v4().to_string(),
            nonce: request.nonce,
        },
    )))
}

async fn consume_execution_grant(
    State(state): State<AppState>,
    Json(request): Json<ConsumeExecutionGrantRequest>,
) -> Result<StatusCode, ApiError> {
    let now = now()?;
    let claims = state
        .authority
        .verify_execution_grant(&request.grant)
        .map_err(|_| {
            ApiError::forbidden("invalid_grant", "execution grant signature is invalid")
        })?;
    if claims.iss != "rdc-auth"
        || claims.aud != "rdc-guest-runner"
        || claims.client_id.trim().is_empty()
        || claims.device_id.trim().is_empty()
        || claims.session_id.trim().is_empty()
        || claims.client_version.trim().is_empty()
        || claims.artifact_id.trim().is_empty()
        || claims.artifact_sha256.len() != 64
        || !claims
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !valid_execution_action(&claims.action)
        || claims.vm.trim().is_empty()
        || claims.instance.trim().is_empty()
        || claims.jti.trim().is_empty()
        || claims.nonce.trim().is_empty()
        || claims.exp <= now
        || claims.iat > now.saturating_add(300)
        || claims.exp <= claims.iat
    {
        return Err(ApiError::forbidden(
            "invalid_grant",
            "execution grant claims are invalid or expired",
        ));
    }
    if !artifact_allows_execution_action(&claims.artifact_id, &claims.action) {
        return Err(ApiError::forbidden(
            "artifact_workflow_mismatch",
            "execution artifact is not approved for this workflow",
        ));
    }
    let session = state
        .store
        .session(&claims.session_id)?
        .ok_or_else(|| ApiError::forbidden("revoked", "execution grant session is unknown"))?;
    if session.revoked
        || session.exp <= now
        || session.client_id != claims.client_id
        || session.device_id != claims.device_id
        || !session
            .capabilities
            .contains(&ProtectedCapability::ProtectedPreset)
        || !session
            .capabilities
            .contains(&ProtectedCapability::ProtectedArtifact)
    {
        return Err(ApiError::forbidden(
            "revoked",
            "execution grant session is no longer usable",
        ));
    }
    let client = state
        .store
        .client(&session.client_id)?
        .ok_or_else(|| ApiError::forbidden("revoked", "execution grant client is unknown"))?;
    ensure_client_usable(&client, &session.device_id)?;
    let device_proof = request
        .grant
        .device_proof
        .as_deref()
        .filter(|proof| !proof.trim().is_empty())
        .ok_or_else(|| {
            ApiError::forbidden(
                "device_proof_required",
                "execution grant is missing device proof",
            )
        })?;
    state
        .authority
        .verify_client_signature(
            client.client_key_algorithm,
            &client.device_public_key,
            request.grant.payload.as_bytes(),
            device_proof,
        )
        .map_err(|_| {
            ApiError::forbidden(
                "device_proof_invalid",
                "execution grant device proof is invalid",
            )
        })?;
    if client.client_version != claims.client_version {
        return Err(ApiError::forbidden(
            "client_outdated",
            "execution grant client version does not match",
        ));
    }
    for capability in &session.capabilities {
        if !state
            .store
            .has_entitlement(&client.account_id, *capability)?
        {
            state.store.revoke_session(&session.session_id)?;
            return Err(ApiError::forbidden(
                "revoked",
                "execution grant entitlement has been revoked",
            ));
        }
    }
    let artifact = state.store.artifact(&claims.artifact_id)?.ok_or_else(|| {
        ApiError::forbidden("artifact_integrity", "execution artifact is unavailable")
    })?;
    let path = safe_artifact_path(&state.artifact_root, &artifact)?;
    let (_, actual_sha256) = sha256_file(&path).map_err(|_| ApiError::internal())?;
    if actual_sha256 != claims.artifact_sha256 {
        return Err(ApiError::forbidden(
            "artifact_integrity",
            "execution artifact hash no longer matches",
        ));
    }
    let reservation = format!("execution-grant-jti:{}", claims.jti);
    if !state.store.consume_nonce(&reservation, now)? {
        return Err(ApiError::conflict(
            "execution grant has already been consumed",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactPrepareRequest {
    pub device_id: String,
    pub target_abi: String,
    pub target_android: String,
    pub ephemeral_public_key: String,
}

async fn prepare_artifact(
    State(state): State<AppState>,
    Path(artifact_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ArtifactPrepareRequest>,
) -> Result<Json<SignedArtifactManifest>, ApiError> {
    let session = session_from_headers(&state, &headers, now()?)?;
    if session.device_id != request.device_id {
        return Err(ApiError::forbidden(
            "binding_mismatch",
            "artifact device binding does not match",
        ));
    }
    if !session
        .capabilities
        .contains(&ProtectedCapability::ProtectedArtifact)
    {
        return Err(ApiError::forbidden(
            "missing_capability",
            "artifact capability is not present",
        ));
    }
    if request.ephemeral_public_key.trim().is_empty() {
        return Err(ApiError::bad_request("ephemeral artifact key is required"));
    }
    let now = now()?;
    let mut transfers = state.transfers.lock().unwrap();
    transfers.retain(|_, transfer| transfer.manifest.expires_at > now);
    if transfers.len() >= state.max_active_transfers {
        return Err(ApiError::service_unavailable(
            "transfer_capacity_exhausted",
            "artifact transfer capacity is exhausted",
        ));
    }
    let artifact = state
        .store
        .artifact(&artifact_id)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found", "artifact is unknown"))?;
    if artifact.target_abi != request.target_abi
        || artifact.target_android != request.target_android
    {
        return Err(ApiError::forbidden(
            "target_mismatch",
            "artifact target does not match the request",
        ));
    }
    let (server_secret, server_public_key) = random_x25519_keypair();
    let shared_secret = derive_x25519_shared_secret(&server_secret, &request.ephemeral_public_key)
        .map_err(|_| ApiError::bad_request("ephemeral artifact key is invalid"))?;
    let path = safe_artifact_path(&state.artifact_root, &artifact)?;
    let (size_bytes, sha256) = sha256_file(&path).map_err(|_| ApiError::internal())?;
    let chunk_count = (size_bytes.saturating_add(ARTIFACT_CHUNK_SIZE - 1) / ARTIFACT_CHUNK_SIZE)
        .try_into()
        .map_err(|_| ApiError::internal())?;
    let transfer_id = Uuid::new_v4().to_string();
    let manifest = ArtifactManifest {
        artifact_id: artifact.artifact_id.clone(),
        version: artifact.version,
        target_abi: artifact.target_abi,
        target_android: artifact.target_android,
        session_id: session.session_id.clone(),
        device_id: session.device_id.clone(),
        size_bytes,
        sha256,
        expires_at: session.exp.min(now.saturating_add(ARTIFACT_TTL_SECS)),
        key_id: state.authority.key_id().to_owned(),
        transfer_id: transfer_id.clone(),
        server_ephemeral_public_key: server_public_key,
        chunk_size_bytes: ARTIFACT_CHUNK_SIZE as u32,
        chunk_count,
        nonce_prefix: random_nonce_prefix(),
    };
    transfers.insert(
        transfer_id,
        ArtifactTransfer {
            artifact_id: artifact.artifact_id.clone(),
            session_id: session.session_id.clone(),
            device_id: session.device_id.clone(),
            path,
            manifest: manifest.clone(),
            shared_secret: Zeroizing::new(shared_secret),
        },
    );
    Ok(Json(state.authority.sign_manifest(manifest)))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactChunkResponse {
    pub index: u32,
    pub ciphertext: String,
}

async fn artifact_chunk(
    State(state): State<AppState>,
    Path((artifact_id, transfer_id, index)): Path<(String, String, u32)>,
    headers: HeaderMap,
) -> Result<Json<ArtifactChunkResponse>, ApiError> {
    let now = now()?;
    let session = session_from_headers(&state, &headers, now)?;
    let transfer = {
        let mut transfers = state.transfers.lock().unwrap();
        transfers.retain(|_, transfer| transfer.manifest.expires_at > now);
        transfers.get(&transfer_id).cloned()
    }
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "artifact transfer is unknown",
        )
    })?;
    if transfer.artifact_id != artifact_id
        || transfer.session_id != session.session_id
        || transfer.device_id != session.device_id
    {
        return Err(ApiError::forbidden(
            "binding_mismatch",
            "artifact transfer binding does not match",
        ));
    }
    let manifest = &transfer.manifest;
    if index >= manifest.chunk_count {
        return Err(ApiError::bad_request("artifact chunk index is invalid"));
    }
    let offset = u64::from(index) * u64::from(manifest.chunk_size_bytes);
    let remaining = manifest.size_bytes.saturating_sub(offset);
    let length = remaining.min(u64::from(manifest.chunk_size_bytes));
    if length == 0 {
        return Err(ApiError::bad_request("artifact chunk is empty"));
    }
    let mut file = std::fs::File::open(&transfer.path).map_err(|_| ApiError::internal())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| ApiError::internal())?;
    let mut plaintext = vec![0_u8; length as usize];
    file.read_exact(&mut plaintext)
        .map_err(|_| ApiError::internal())?;
    let key = crate::crypto::derive_artifact_key(&transfer.shared_secret, manifest)
        .map_err(|_| ApiError::internal())?;
    let ciphertext = encrypt_artifact_chunk(&key, manifest, index, &plaintext)
        .map_err(|_| ApiError::internal())?;
    Ok(Json(ArtifactChunkResponse {
        index,
        ciphertext: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ciphertext),
    }))
}

fn safe_artifact_path(root: &FsPath, artifact: &ArtifactRecord) -> Result<PathBuf, ApiError> {
    let root = std::fs::canonicalize(root).map_err(|_| ApiError::internal())?;
    let path = std::fs::canonicalize(&artifact.path).map_err(|_| ApiError::internal())?;
    if !path.starts_with(&root) {
        return Err(ApiError::forbidden(
            "artifact_path_invalid",
            "artifact is outside the configured artifact root",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{
        decrypt_artifact_chunk, derive_artifact_key, derive_x25519_shared_secret,
        random_x25519_keypair, ExecutionGrantClaims, HeartbeatProof, SessionProof,
    };
    use crate::store::ClientRecord;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use std::fs;
    use tempfile::tempdir;
    use tower::ServiceExt;

    fn test_client() -> (SigningKey, ClientRecord) {
        let key = SigningKey::from_bytes(&[4; 32]);
        (
            key.clone(),
            ClientRecord {
                client_id: "client-a".into(),
                account_id: "account-a".into(),
                device_id: "device-a".into(),
                device_public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
                client_key_algorithm: ClientKeyAlgorithm::Ed25519DpapiV1,
                client_version: "1.0.0".into(),
                approved: true,
                revoked: false,
            },
        )
    }

    fn test_app() -> (Router, Arc<AuthStore>, SigningKey) {
        let store = AuthStore::in_memory().unwrap();
        let (key, client) = test_client();
        store.seed_approved_client(&client).unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        let state = AppState::new(
            store,
            SigningAuthority::for_tests(),
            tempdir().unwrap().path().to_path_buf(),
        );
        let store = state.store.clone();
        (router(state), store, key)
    }

    fn session_request(key: &SigningKey, nonce: &str) -> SessionRequest {
        let capabilities = vec![
            ProtectedCapability::ProtectedPreset,
            ProtectedCapability::ProtectedArtifact,
        ];
        let proof = SessionProof {
            client_id: "client-a",
            device_id: "device-a",
            client_version: "1.0.0",
            nonce,
            capabilities: &capabilities,
        };
        let payload = canonical_json(&proof).unwrap();
        let signature = URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes());
        SessionRequest {
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            client_version: "1.0.0".into(),
            nonce: nonce.into(),
            capabilities,
            signature,
        }
    }

    async fn post_json<T: Serialize>(
        app: &mut Router,
        uri: &str,
        value: &T,
    ) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::post(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(value).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn protected_responses_are_not_cacheable() {
        let (mut app, _, key) = test_app();
        let response = post_json(
            &mut app,
            "/v1/sessions",
            &session_request(&key, "nonce-cache"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        assert_eq!(response.headers().get("pragma").unwrap(), "no-cache");
    }

    #[tokio::test]
    async fn control_plane_request_body_limit_is_enforced() {
        let (mut app, _, _key) = test_app();
        let oversized_padding = "x".repeat(70 * 1024);
        let body = serde_json::json!({
            "client_id": "client-a",
            "device_id": "device-a",
            "client_version": "1.0.0",
            "nonce": "oversized",
            "capabilities": [],
            "signature": "invalid",
            "padding": oversized_padding,
        });

        let response = post_json(&mut app, "/v1/sessions", &body).await;

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn transfer_capacity_is_enforced_before_new_transfer() {
        let root = tempdir().unwrap();
        let artifact = root.path().join("core.bin");
        fs::write(&artifact, b"core").unwrap();
        let store = AuthStore::in_memory().unwrap();
        let (key, client) = test_client();
        store.seed_approved_client(&client).unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        store
            .publish_artifact("core-a", "1", "x86_64", "android-13", &artifact)
            .unwrap();
        let state = AppState::with_transfer_limit(
            store,
            SigningAuthority::for_tests(),
            root.path().to_path_buf(),
            1,
        );
        let transfer_store = state.transfers.clone();
        let mut app = router(state);
        let session = post_json(
            &mut app,
            "/v1/sessions",
            &session_request(&key, "nonce-capacity"),
        )
        .await;
        let session: SessionResponse = {
            let body = to_bytes(session.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice(&body).unwrap()
        };
        let (_, first_public_key) = random_x25519_keypair();
        let first = app
            .clone()
            .oneshot(
                Request::post("/v1/artifacts/core-a/prepare")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ArtifactPrepareRequest {
                            device_id: "device-a".into(),
                            target_abi: "x86_64".into(),
                            target_android: "android-13".into(),
                            ephemeral_public_key: first_public_key,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let (_, second_public_key) = random_x25519_keypair();
        let second = app
            .clone()
            .oneshot(
                Request::post("/v1/artifacts/core-a/prepare")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ArtifactPrepareRequest {
                            device_id: "device-a".into(),
                            target_abi: "x86_64".into(),
                            target_android: "android-13".into(),
                            ephemeral_public_key: second_public_key,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "transfer_capacity_exhausted");

        {
            let mut transfers = transfer_store.lock().unwrap();
            for transfer in transfers.values_mut() {
                transfer.manifest.expires_at = 0;
            }
        }
        let (_, third_public_key) = random_x25519_keypair();
        let third = app
            .oneshot(
                Request::post("/v1/artifacts/core-a/prepare")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ArtifactPrepareRequest {
                            device_id: "device-a".into(),
                            target_abi: "x86_64".into(),
                            target_android: "android-13".into(),
                            ephemeral_public_key: third_public_key,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(third.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn sessions_reject_a_replayed_nonce() {
        let (mut app, _, key) = test_app();
        let request = session_request(&key, "nonce-1");
        let first = post_json(&mut app, "/v1/sessions", &request).await;
        assert_eq!(first.status(), StatusCode::OK);
        let request = session_request(&key, "nonce-1");
        let second = post_json(&mut app, "/v1/sessions", &request).await;
        assert_eq!(second.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn revoked_client_cannot_create_a_new_session() {
        let (mut app, store, key) = test_app();
        store.revoke_client("client-a").unwrap();
        let response = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-2")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn registration_requires_proof_before_updating_version_or_revoking_session() {
        let (mut app, store, key) = test_app();
        let client = store.client("client-a").unwrap().unwrap();
        store
            .create_session(
                "session-registration",
                &client,
                &[ProtectedCapability::ProtectedPreset],
                "jti-registration",
                10_000,
                1,
            )
            .unwrap();
        let registration = serde_json::json!({
            "install_id": "install-a",
            "device_id": "device-a",
            "client_version": "2.0.0",
            "platform": "windows-x64",
            "device_public_key": client.device_public_key,
            "requested_product": "redroid-device-center"
        });
        let response = post_json(&mut app, "/v1/clients/register", &registration).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            store.client("client-a").unwrap().unwrap().client_version,
            "1.0.0"
        );
        assert!(
            !store
                .session("session-registration")
                .unwrap()
                .unwrap()
                .revoked
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let challenge: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let invalid = serde_json::json!({
            "client_id": challenge["client_id"].as_str().unwrap(),
            "challenge": challenge["challenge"].as_str().unwrap(),
            "signature": URL_SAFE_NO_PAD.encode([0_u8; 64])
        });
        let response = post_json(&mut app, "/v1/clients/register/complete", &invalid).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            store.client("client-a").unwrap().unwrap().client_version,
            "1.0.0"
        );
        assert!(
            !store
                .session("session-registration")
                .unwrap()
                .unwrap()
                .revoked
        );

        let response = post_json(&mut app, "/v1/clients/register", &registration).await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let challenge: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let proof = RegistrationProof {
            client_id: challenge["client_id"].as_str().unwrap(),
            challenge: challenge["challenge"].as_str().unwrap(),
        };
        let valid = serde_json::json!({
            "client_id": challenge["client_id"].as_str().unwrap(),
            "challenge": challenge["challenge"].as_str().unwrap(),
            "signature": URL_SAFE_NO_PAD.encode(key.sign(&canonical_json(&proof).unwrap()).to_bytes()),
        });
        let response = post_json(&mut app, "/v1/clients/register/complete", &valid).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            store.client("client-a").unwrap().unwrap().client_version,
            "2.0.0"
        );
        assert!(
            store
                .session("session-registration")
                .unwrap()
                .unwrap()
                .revoked
        );
    }

    #[tokio::test]
    async fn invalid_registration_proof_does_not_consume_the_challenge() {
        let (mut app, store, key) = test_app();
        let registration = serde_json::json!({
            "install_id": "install-a",
            "device_id": "device-a",
            "client_version": "1.0.0",
            "platform": "windows-x64",
            "device_public_key": URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            "requested_product": "redroid-device-center"
        });
        let response = post_json(&mut app, "/v1/clients/register", &registration).await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let challenge: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let client_id = challenge["client_id"].as_str().unwrap();
        let challenge_value = challenge["challenge"].as_str().unwrap();
        let invalid = serde_json::json!({
            "client_id": client_id,
            "challenge": challenge_value,
            "signature": URL_SAFE_NO_PAD.encode([0_u8; 64])
        });
        let response = post_json(&mut app, "/v1/clients/register/complete", &invalid).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let proof = RegistrationProof {
            client_id,
            challenge: challenge_value,
        };
        let valid = serde_json::json!({
            "client_id": client_id,
            "challenge": challenge_value,
            "signature": URL_SAFE_NO_PAD.encode(key.sign(&canonical_json(&proof).unwrap()).to_bytes()),
        });
        let response = post_json(&mut app, "/v1/clients/register/complete", &valid).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(store.client(client_id).unwrap().is_some());
    }

    #[tokio::test]
    async fn session_rejects_a_client_version_that_is_not_registered() {
        let (mut app, _, key) = test_app();
        let mut request = session_request(&key, "nonce-version");
        request.client_version = "0.9.0".into();
        let response = post_json(&mut app, "/v1/sessions", &request).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn heartbeat_renews_a_valid_session_and_rejects_replay() {
        let (mut app, _, key) = test_app();
        let response = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-3")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let session: SessionResponse = serde_json::from_slice(&body).unwrap();
        let nonce = "heartbeat-1";
        let proof = HeartbeatProof {
            session_id: &session.lease.claims.session_id,
            client_id: "client-a",
            device_id: "device-a",
            nonce,
        };
        let heartbeat = HeartbeatRequest {
            client_id: "client-a".into(),
            device_id: "device-a".into(),
            nonce: nonce.into(),
            signature: URL_SAFE_NO_PAD
                .encode(key.sign(&canonical_json(&proof).unwrap()).to_bytes()),
        };
        let response = post_json(
            &mut app,
            &format!("/v1/sessions/{}/heartbeat", session.lease.claims.session_id),
            &heartbeat,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let replay = post_json(
            &mut app,
            &format!("/v1/sessions/{}/heartbeat", session.lease.claims.session_id),
            &heartbeat,
        )
        .await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn creating_a_new_session_revokes_the_previous_device_session() {
        let (mut app, _, key) = test_app();
        let first = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-6")).await;
        let first_body = to_bytes(first.into_body(), usize::MAX).await.unwrap();
        let first: SessionResponse = serde_json::from_slice(&first_body).unwrap();
        let second = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-7")).await;
        assert_eq!(second.status(), StatusCode::OK);
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/capabilities")
                    .header(
                        "authorization",
                        format!("Bearer {}", first.lease.claims.session_id),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn artifact_prepare_rejects_a_target_mismatch_before_file_access() {
        let (mut app, store, key) = test_app();
        let dir = tempdir().unwrap();
        let artifact = dir.path().join("core.bin");
        fs::write(&artifact, b"core").unwrap();
        store
            .publish_artifact("core-a", "1", "x86_64", "android-13", &artifact)
            .unwrap();
        let response = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-4")).await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let session: SessionResponse = serde_json::from_slice(&body).unwrap();
        let request = ArtifactPrepareRequest {
            device_id: "device-a".into(),
            target_abi: "x86_64".into(),
            target_android: "android-14".into(),
            ephemeral_public_key: "ephemeral".into(),
        };
        let response = app
            .oneshot(
                Request::post("/v1/artifacts/core-a/prepare")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn authorized_artifact_chunks_are_encrypted_and_bound_to_the_manifest() {
        let root = tempdir().unwrap();
        let artifact = root.path().join("core.bin");
        let plaintext = b"server-delivered core payload";
        fs::write(&artifact, plaintext).unwrap();
        let store = AuthStore::in_memory().unwrap();
        let (key, client) = test_client();
        store.seed_approved_client(&client).unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        store
            .publish_artifact("core-a", "1", "x86_64", "android-13", &artifact)
            .unwrap();
        let state = AppState::new(
            store,
            SigningAuthority::for_tests(),
            root.path().to_path_buf(),
        );
        let store = state.store.clone();
        let mut app = router(state);
        let response = post_json(&mut app, "/v1/sessions", &session_request(&key, "nonce-5")).await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let session: SessionResponse = serde_json::from_slice(&body).unwrap();
        let (client_secret, client_public_key) = random_x25519_keypair();
        let request = ArtifactPrepareRequest {
            device_id: "device-a".into(),
            target_abi: "x86_64".into(),
            target_android: "android-13".into(),
            ephemeral_public_key: client_public_key,
        };
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/artifacts/core-a/prepare")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let signed: SignedArtifactManifest = serde_json::from_slice(&body).unwrap();
        let shared = derive_x25519_shared_secret(
            &client_secret,
            &signed.manifest.server_ephemeral_public_key,
        )
        .unwrap();
        let key_bytes = derive_artifact_key(&shared, &signed.manifest).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/artifacts/core-a/transfers/{}/chunks/0",
                    signed.manifest.transfer_id
                ))
                .header(
                    "authorization",
                    format!("Bearer {}", session.lease.claims.session_id),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let chunk: ArtifactChunkResponse = serde_json::from_slice(&body).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(chunk.ciphertext).unwrap();
        let decrypted =
            decrypt_artifact_chunk(&key_bytes, &signed.manifest, 0, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);

        store
            .revoke_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        let capabilities_response = app
            .clone()
            .oneshot(
                Request::get("/v1/capabilities")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed.manifest.session_id),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities_response.status(), StatusCode::FORBIDDEN);
        let revoked_response = app
            .oneshot(
                Request::get(format!(
                    "/v1/artifacts/core-a/transfers/{}/chunks/0",
                    signed.manifest.transfer_id
                ))
                .header(
                    "authorization",
                    format!("Bearer {}", signed.manifest.session_id),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked_response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn execution_grant_is_signed_and_bound_to_the_published_artifact_and_workflow() {
        let root = tempdir().unwrap();
        let artifact = root.path().join("core.bin");
        fs::write(&artifact, b"core").unwrap();
        let store = AuthStore::in_memory().unwrap();
        let (key, client) = test_client();
        store.seed_approved_client(&client).unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        store
            .publish_artifact("qemu-guest-script", "1", "x86_64", "android-13", &artifact)
            .unwrap();
        let state = AppState::new(
            store,
            SigningAuthority::for_tests(),
            root.path().to_path_buf(),
        );
        let mut app = router(state);
        let response = post_json(
            &mut app,
            "/v1/sessions",
            &session_request(&key, "nonce-grant-session"),
        )
        .await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let session: SessionResponse = serde_json::from_slice(&body).unwrap();
        let (_, sha256) = sha256_file(&artifact).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/execution-grants")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ExecutionGrantRequest {
                            artifact_id: "qemu-guest-script".into(),
                            artifact_sha256: sha256.clone(),
                            action: "preset_apply".into(),
                            vm: "node1".into(),
                            instance: "r13".into(),
                            nonce: "nonce-grant-1".into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let grant: SignedExecutionGrant = serde_json::from_slice(&body).unwrap();
        let claims = SigningAuthority::for_tests()
            .verify_execution_grant(&grant)
            .unwrap();
        assert_eq!(claims.device_id, "device-a");
        assert_eq!(claims.session_id, session.lease.claims.session_id);
        assert_eq!(claims.artifact_id, "qemu-guest-script");
        assert_eq!(claims.action, "preset_apply");
        assert_eq!(claims.vm, "node1");
        assert_eq!(claims.instance, "r13");

        let consume_payload = ConsumeExecutionGrantRequest {
            grant: grant.clone(),
        };
        let consume_response =
            post_json(&mut app, "/v1/execution-grants/consume", &consume_payload).await;
        assert_eq!(consume_response.status(), StatusCode::FORBIDDEN);
        let wrong_device_key = SigningKey::from_bytes(&[5; 32]);
        let mut copied_grant = grant.clone();
        copied_grant.device_proof = Some(
            URL_SAFE_NO_PAD.encode(
                wrong_device_key
                    .sign(copied_grant.payload.as_bytes())
                    .to_bytes(),
            ),
        );
        let copied_response = post_json(
            &mut app,
            "/v1/execution-grants/consume",
            &ConsumeExecutionGrantRequest {
                grant: copied_grant,
            },
        )
        .await;
        assert_eq!(copied_response.status(), StatusCode::FORBIDDEN);
        let mut valid_grant = grant.clone();
        valid_grant.device_proof =
            Some(URL_SAFE_NO_PAD.encode(key.sign(valid_grant.payload.as_bytes()).to_bytes()));
        let consume_payload = ConsumeExecutionGrantRequest {
            grant: valid_grant.clone(),
        };
        let consume_response =
            post_json(&mut app, "/v1/execution-grants/consume", &consume_payload).await;
        assert_eq!(consume_response.status(), StatusCode::NO_CONTENT);
        let replay_consume_response =
            post_json(&mut app, "/v1/execution-grants/consume", &consume_payload).await;
        assert_eq!(replay_consume_response.status(), StatusCode::CONFLICT);

        let wrong_hash_response = app
            .clone()
            .oneshot(
                Request::post("/v1/execution-grants")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ExecutionGrantRequest {
                            artifact_id: "qemu-guest-script".into(),
                            artifact_sha256: "0".repeat(64),
                            action: "preset_apply".into(),
                            vm: "node1".into(),
                            instance: "r13".into(),
                            nonce: "nonce-grant-wrong-hash".into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_hash_response.status(), StatusCode::FORBIDDEN);

        let replay_response = app
            .oneshot(
                Request::post("/v1/execution-grants")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ExecutionGrantRequest {
                            artifact_id: "qemu-guest-script".into(),
                            artifact_sha256: sha256.clone(),
                            action: "preset_apply".into(),
                            vm: "node1".into(),
                            instance: "r13".into(),
                            nonce: "nonce-grant-1".into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay_response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn execution_grant_rejects_an_artifact_workflow_mismatch() {
        let root = tempdir().unwrap();
        let artifact = root.path().join("universal.py");
        fs::write(&artifact, b"universal runner").unwrap();
        let store = AuthStore::in_memory().unwrap();
        let (key, client) = test_client();
        store.seed_approved_client(&client).unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
            .unwrap();
        store
            .publish_artifact(
                "qemu-guest-script-universal",
                "1",
                "x86_64",
                "any",
                &artifact,
            )
            .unwrap();
        let state = AppState::new(
            store,
            SigningAuthority::for_tests(),
            root.path().to_path_buf(),
        );
        let mut app = router(state);
        let response = post_json(
            &mut app,
            "/v1/sessions",
            &session_request(&key, "nonce-policy-session"),
        )
        .await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let session: SessionResponse = serde_json::from_slice(&body).unwrap();
        let (_, sha256) = sha256_file(&artifact).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/execution-grants")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ExecutionGrantRequest {
                            artifact_id: "qemu-guest-script-universal".into(),
                            artifact_sha256: sha256.clone(),
                            action: "preset_apply".into(),
                            vm: "node1".into(),
                            instance: "r13".into(),
                            nonce: "nonce-policy-mismatch".into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // The policy rejection must happen before nonce reservation. Reusing
        // the same request nonce for the approved universal workflow is the
        // regression check for that fail-closed ordering.
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/execution-grants")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!("Bearer {}", session.lease.claims.session_id),
                    )
                    .body(Body::from(
                        serde_json::to_vec(&ExecutionGrantRequest {
                            artifact_id: "qemu-guest-script-universal".into(),
                            artifact_sha256: sha256.clone(),
                            action: "preset_restore".into(),
                            vm: "node1".into(),
                            instance: "r13".into(),
                            nonce: "nonce-policy-mismatch".into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let now = now().unwrap();
        let mismatched_grant =
            SigningAuthority::for_tests().sign_execution_grant(ExecutionGrantClaims {
                iss: "rdc-auth".into(),
                aud: "rdc-guest-runner".into(),
                client_id: "client-a".into(),
                device_id: "device-a".into(),
                session_id: session.lease.claims.session_id.clone(),
                client_version: "1.0.0".into(),
                artifact_id: "qemu-guest-script-universal".into(),
                artifact_sha256: sha256,
                action: "preset_apply".into(),
                vm: "node1".into(),
                instance: "r13".into(),
                iat: now,
                exp: now + 60,
                jti: "mismatched-grant".into(),
                nonce: "mismatched-grant-nonce".into(),
            });
        let response = post_json(
            &mut app,
            "/v1/execution-grants/consume",
            &ConsumeExecutionGrantRequest {
                grant: mismatched_grant,
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn execution_artifact_policy_is_fail_closed_for_unknown_pairs() {
        assert!(artifact_allows_execution_action(
            "qemu-guest-script",
            "preset_apply"
        ));
        assert!(artifact_allows_execution_action(
            "qemu-guest-script-universal",
            "preset_restore"
        ));
        assert!(artifact_allows_execution_action(
            "qemu-guest-script-universal",
            "preset_details"
        ));
        assert!(!artifact_allows_execution_action(
            "qemu-guest-script-universal",
            "preset_apply"
        ));
        assert!(!artifact_allows_execution_action("unknown", "preset_apply"));
    }
}
