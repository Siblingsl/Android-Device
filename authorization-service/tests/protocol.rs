use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use rdc_authorization_service::crypto::{
    canonical_json, decrypt_artifact_chunk, derive_artifact_key, derive_x25519_shared_secret,
    random_x25519_keypair, ClientKeyAlgorithm, ProtectedCapability, RegistrationProof,
    SessionProof, SignedArtifactManifest, SigningAuthority,
};
use rdc_authorization_service::routes::{
    ArtifactChunkResponse, ArtifactPrepareRequest, SessionRequest, SessionResponse,
};
use rdc_authorization_service::store::{AuthStore, ClientRecord};
use rdc_authorization_service::{router, AppState};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;
use tower::ServiceExt;

fn client_fixture() -> (SigningKey, ClientRecord) {
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

fn app_fixture(
    root: &Path,
    authority: SigningAuthority,
) -> (axum::Router, Arc<AuthStore>, SigningKey) {
    let store = AuthStore::in_memory().unwrap();
    let (key, client) = client_fixture();
    store
        .create_pending_client(
            &client.client_id,
            &client.account_id,
            &client.device_id,
            &client.device_public_key,
            client.client_key_algorithm,
            &client.client_version,
            1_000,
        )
        .unwrap();
    store
        .approve_client_for_account(&client.client_id, &client.account_id)
        .unwrap();
    store
        .grant_entitlement("account-a", ProtectedCapability::ProtectedArtifact)
        .unwrap();
    let artifact = root.join("core.py");
    std::fs::write(&artifact, b"server-delivered-core\n").unwrap();
    store
        .publish_artifact("core", "1", "x86_64", "android-13", &artifact)
        .unwrap();
    let state = AppState::new(store, authority, root.to_path_buf());
    let store = state.store.clone();
    (router(state), store, key)
}

fn session_request(key: &SigningKey, nonce: &str) -> SessionRequest {
    session_request_for(key, "client-a", "device-a", "1.0.0", nonce)
}

fn session_request_for(
    key: &SigningKey,
    client_id: &str,
    device_id: &str,
    client_version: &str,
    nonce: &str,
) -> SessionRequest {
    let capabilities = vec![ProtectedCapability::ProtectedArtifact];
    let proof = SessionProof {
        client_id,
        device_id,
        client_version,
        nonce,
        capabilities: &capabilities,
    };
    let payload = canonical_json(&proof).unwrap();
    SessionRequest {
        client_id: client_id.into(),
        device_id: device_id.into(),
        client_version: client_version.into(),
        nonce: nonce.into(),
        capabilities,
        signature: URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes()),
    }
}

async fn post_json<T: Serialize>(
    app: &axum::Router,
    uri: &str,
    value: &T,
    bearer: Option<&str>,
) -> axum::response::Response {
    let mut request = Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(value).unwrap()))
        .unwrap();
    if let Some(session_id) = bearer {
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {session_id}").parse().unwrap(),
        );
    }
    app.clone().oneshot(request).await.unwrap()
}

async fn response_json<T: DeserializeOwned>(response: axum::response::Response) -> T {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn revoked_session_cannot_receive_a_new_artifact_chunk() {
    let temp = tempdir().unwrap();
    let (app, store, key) = app_fixture(temp.path(), SigningAuthority::for_tests());
    let session_response = post_json(
        &app,
        "/v1/sessions",
        &session_request(&key, "nonce-a"),
        None,
    )
    .await;
    assert_eq!(session_response.status(), StatusCode::OK);
    let session: SessionResponse = response_json(session_response).await;
    let (secret, public_key) = random_x25519_keypair();
    let _secret = secret;
    let prepare_response = post_json(
        &app,
        "/v1/artifacts/core/prepare",
        &ArtifactPrepareRequest {
            device_id: "device-a".into(),
            target_abi: "x86_64".into(),
            target_android: "android-13".into(),
            ephemeral_public_key: public_key,
        },
        Some(&session.lease.claims.session_id),
    )
    .await;
    assert_eq!(prepare_response.status(), StatusCode::OK);
    let manifest: SignedArtifactManifest = response_json(prepare_response).await;
    store.revoke_client("client-a").unwrap();

    let chunk_response = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/artifacts/core/transfers/{}/chunks/0",
                manifest.manifest.transfer_id
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
    assert_eq!(chunk_response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn registration_stays_pending_until_approval_then_delivers_an_artifact() {
    let root = tempdir().unwrap();
    let artifact = root.path().join("registered-core.py");
    let plaintext = b"registered server-delivered core\n";
    std::fs::write(&artifact, plaintext).unwrap();
    let store = AuthStore::in_memory().unwrap();
    store
        .publish_artifact("registered-core", "1", "x86_64", "android-13", &artifact)
        .unwrap();
    let authority = SigningAuthority::for_tests();
    let client_key = SigningKey::from_bytes(&[9; 32]);
    let state = AppState::new(store, authority, root.path().to_path_buf());
    let store = state.store.clone();
    let app = router(state);

    let registration = post_json(
        &app,
        "/v1/clients/register",
        &serde_json::json!({
            "install_id": "install-a",
            "device_id": "device-registered",
            "client_version": "2.0.0",
            "platform": "windows-x64",
            "device_public_key": URL_SAFE_NO_PAD.encode(client_key.verifying_key().to_bytes()),
            "requested_product": "redroid-device-center",
        }),
        None,
    )
    .await;
    assert_eq!(registration.status(), StatusCode::OK);
    let registration: serde_json::Value = response_json(registration).await;
    let client_id = registration["client_id"].as_str().unwrap().to_owned();
    let challenge = registration["challenge"].as_str().unwrap().to_owned();

    let registration_proof = RegistrationProof {
        client_id: &client_id,
        challenge: &challenge,
    };
    let complete = post_json(
        &app,
        "/v1/clients/register/complete",
        &serde_json::json!({
            "client_id": client_id,
            "challenge": challenge,
            "signature": URL_SAFE_NO_PAD.encode(
                client_key
                    .sign(&canonical_json(&registration_proof).unwrap())
                    .to_bytes(),
            ),
        }),
        None,
    )
    .await;
    assert_eq!(complete.status(), StatusCode::OK);
    let complete: serde_json::Value = response_json(complete).await;
    assert_eq!(complete["status"], "pending");

    let pending_session = post_json(
        &app,
        "/v1/sessions",
        &session_request_for(
            &client_key,
            &client_id,
            "device-registered",
            "2.0.0",
            "pending-nonce",
        ),
        None,
    )
    .await;
    assert_eq!(pending_session.status(), StatusCode::FORBIDDEN);

    store
        .approve_client_for_account(&client_id, "account-registered")
        .unwrap();
    store
        .grant_entitlement("account-registered", ProtectedCapability::ProtectedArtifact)
        .unwrap();
    let session = post_json(
        &app,
        "/v1/sessions",
        &session_request_for(
            &client_key,
            &client_id,
            "device-registered",
            "2.0.0",
            "approved-nonce",
        ),
        None,
    )
    .await;
    assert_eq!(session.status(), StatusCode::OK);
    let session: SessionResponse = response_json(session).await;

    let (client_secret, client_public_key) = random_x25519_keypair();
    let prepared = post_json(
        &app,
        "/v1/artifacts/registered-core/prepare",
        &ArtifactPrepareRequest {
            device_id: "device-registered".into(),
            target_abi: "x86_64".into(),
            target_android: "android-13".into(),
            ephemeral_public_key: client_public_key,
        },
        Some(&session.lease.claims.session_id),
    )
    .await;
    assert_eq!(prepared.status(), StatusCode::OK);
    let manifest: SignedArtifactManifest = response_json(prepared).await;

    let wrong_device = post_json(
        &app,
        "/v1/artifacts/registered-core/prepare",
        &ArtifactPrepareRequest {
            device_id: "copied-device".into(),
            target_abi: "x86_64".into(),
            target_android: "android-13".into(),
            ephemeral_public_key: random_x25519_keypair().1,
        },
        Some(&session.lease.claims.session_id),
    )
    .await;
    assert_eq!(wrong_device.status(), StatusCode::FORBIDDEN);

    let shared = derive_x25519_shared_secret(
        &client_secret,
        &manifest.manifest.server_ephemeral_public_key,
    )
    .unwrap();
    let key = derive_artifact_key(&shared, &manifest.manifest).unwrap();
    let chunk = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/artifacts/registered-core/transfers/{}/chunks/0",
                manifest.manifest.transfer_id
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
    assert_eq!(chunk.status(), StatusCode::OK);
    let chunk: ArtifactChunkResponse = response_json(chunk).await;
    let ciphertext = URL_SAFE_NO_PAD.decode(chunk.ciphertext).unwrap();
    let decrypted = decrypt_artifact_chunk(&key, &manifest.manifest, 0, &ciphertext).unwrap();
    assert_eq!(decrypted, plaintext);

    let mut tampered_ciphertext = ciphertext.clone();
    tampered_ciphertext[0] ^= 1;
    assert!(decrypt_artifact_chunk(&key, &manifest.manifest, 0, &tampered_ciphertext).is_err());

    let invalid_index = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/artifacts/registered-core/transfers/{}/chunks/1",
                manifest.manifest.transfer_id
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
    assert_eq!(invalid_index.status(), StatusCode::BAD_REQUEST);

    let wrong_bearer = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/artifacts/registered-core/transfers/{}/chunks/0",
                manifest.manifest.transfer_id
            ))
            .header("authorization", "Bearer copied-session")
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong_bearer.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn restarted_service_uses_the_new_signing_key_id() {
    let temp = tempdir().unwrap();
    let next_secret = URL_SAFE_NO_PAD.encode([8; 32]);
    let authority = SigningAuthority::from_base64url("auth-2026-02", &next_secret).unwrap();
    let (app, _store, key) = app_fixture(temp.path(), authority);
    let response = post_json(
        &app,
        "/v1/sessions",
        &session_request(&key, "nonce-next"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let session: SessionResponse = response_json(response).await;
    assert_eq!(session.lease.key_id, "auth-2026-02");
}
