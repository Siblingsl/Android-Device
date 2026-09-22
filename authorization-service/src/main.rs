use rdc_authorization_service::{crypto::SigningAuthority, router, store::AuthStore, AppState};
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

fn validate_loopback_bind(bind: &str) -> Result<(), String> {
    let address: SocketAddr = bind.parse().map_err(|_| {
        "RDC_AUTH_BIND must be a literal loopback socket address such as 127.0.0.1:8787".to_owned()
    })?;
    if !address.ip().is_loopback() {
        return Err(
            "RDC_AUTH_BIND must use a loopback address; expose the service through the managed TLS edge"
                .to_owned(),
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let signing_secret = env::var("RDC_AUTH_SIGNING_KEY")
        .map_err(|_| "RDC_AUTH_SIGNING_KEY is required; refusing to start without a signing key")?;
    let key_id = env::var("RDC_AUTH_SIGNING_KEY_ID").unwrap_or_else(|_| "auth-2026-01".into());
    let database =
        env::var("RDC_AUTH_DATABASE_URL").map_err(|_| "RDC_AUTH_DATABASE_URL is required")?;
    let artifact_root =
        env::var("RDC_AUTH_ARTIFACT_ROOT").map_err(|_| "RDC_AUTH_ARTIFACT_ROOT is required")?;
    let bind = env::var("RDC_AUTH_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    validate_loopback_bind(&bind)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;

    let authority = SigningAuthority::from_base64url(key_id, &signing_secret)?;
    let store = AuthStore::open(database)?;
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("rdc authorization service listening on {bind}");
    axum::serve(
        listener,
        router(AppState::new(
            store,
            authority,
            PathBuf::from(artifact_root),
        )),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_loopback_bind;

    #[test]
    fn accepts_literal_loopback_socket_addresses() {
        assert!(validate_loopback_bind("127.0.0.1:8787").is_ok());
        assert!(validate_loopback_bind("[::1]:8787").is_ok());
    }

    #[test]
    fn rejects_non_loopback_and_hostname_bindings() {
        assert!(validate_loopback_bind("0.0.0.0:8787").is_err());
        assert!(validate_loopback_bind("192.0.2.10:8787").is_err());
        assert!(validate_loopback_bind("localhost:8787").is_err());
    }
}
