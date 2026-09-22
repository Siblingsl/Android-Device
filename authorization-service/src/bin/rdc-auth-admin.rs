use rdc_authorization_service::crypto::ProtectedCapability;
use rdc_authorization_service::crypto::SigningAuthority;
use rdc_authorization_service::store::AuthStore;
use std::env;
use std::path::PathBuf;

fn usage() -> &'static str {
    "usage: rdc-auth-admin <client approve|revoke> <client-id> [account-id]\n\
     rdc-auth-admin entitlement grant <account-id> <protected-preset|protected-artifact|protected-algorithm>\n\
     rdc-auth-admin entitlement revoke <account-id> <protected-preset|protected-artifact|protected-algorithm>\n\
     rdc-auth-admin artifact publish <id> <version> <abi> <android> <path>\n\
     rdc-auth-admin artifact publish-runner <id> <version> <abi> <android> <source> <output>"
}

fn capability(value: &str) -> Result<ProtectedCapability, String> {
    match value {
        "protected-preset" => Ok(ProtectedCapability::ProtectedPreset),
        "protected-artifact" => Ok(ProtectedCapability::ProtectedArtifact),
        "protected-algorithm" => Ok(ProtectedCapability::ProtectedAlgorithm),
        _ => Err(format!("unknown capability: {value}")),
    }
}

fn store() -> Result<AuthStore, Box<dyn std::error::Error>> {
    let database = env::var("RDC_AUTH_DATABASE_URL")?;
    Ok(AuthStore::open(database)?)
}

fn render_runner_source(
    source: &str,
    authority: &SigningAuthority,
    consume_url: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    if !source.contains("__RDC_EXECUTION_KEY_ID__")
        || !source.contains("__RDC_EXECUTION_PUBLIC_KEY__")
        || !source.contains("__RDC_EXECUTION_CONSUME_URL__")
    {
        return Err("runner source is missing execution authorization placeholders".into());
    }
    let consume_url = consume_url.trim();
    if !(consume_url.starts_with("https://")
        || consume_url.starts_with("http://127.0.0.1")
        || consume_url.starts_with("http://localhost"))
    {
        return Err(
            "execution consume URL must use HTTPS, except for localhost development".into(),
        );
    }
    let rendered = source
        .replace("__RDC_EXECUTION_KEY_ID__", authority.key_id())
        .replace(
            "__RDC_EXECUTION_PUBLIC_KEY__",
            &authority.public_key_base64url(),
        )
        .replace("__RDC_EXECUTION_CONSUME_URL__", consume_url);
    if rendered.contains("__RDC_EXECUTION_") {
        return Err("runner source contains unresolved execution-key placeholders".into());
    }
    Ok(rendered)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.as_slice() {
        [kind, action, client_id, account_id] if kind == "client" && action == "approve" => {
            let changed = store()?.approve_client_for_account(client_id, account_id)?;
            if !changed {
                return Err("client was not found".into());
            }
            println!("client approved");
            Ok(())
        }
        [kind, action, client_id] if kind == "client" && action == "approve" => {
            let changed = store()?.approve_client(client_id)?;
            if !changed {
                return Err("client was not found".into());
            }
            println!("client approved");
            Ok(())
        }
        [kind, action, client_id] if kind == "client" && action == "revoke" => {
            let changed = store()?.revoke_client(client_id)?;
            if !changed {
                return Err("client was not found".into());
            }
            println!("client revoked");
            Ok(())
        }
        [kind, action, account_id, capability_name]
            if kind == "entitlement" && action == "grant" =>
        {
            store()?.grant_entitlement(account_id, capability(capability_name)?)?;
            println!("entitlement granted");
            Ok(())
        }
        [kind, action, account_id, capability_name]
            if kind == "entitlement" && action == "revoke" =>
        {
            let changed = store()?.revoke_entitlement(account_id, capability(capability_name)?)?;
            if !changed {
                return Err("entitlement was not enabled".into());
            }
            println!("entitlement revoked");
            Ok(())
        }
        [kind, action, artifact_id, version, abi, android, path]
            if kind == "artifact" && action == "publish" =>
        {
            store()?.publish_artifact(artifact_id, version, abi, android, &PathBuf::from(path))?;
            println!("artifact published");
            Ok(())
        }
        [kind, action, artifact_id, version, abi, android, source, output]
            if kind == "artifact" && action == "publish-runner" =>
        {
            let secret = env::var("RDC_AUTH_SIGNING_KEY")?;
            let key_id =
                env::var("RDC_AUTH_SIGNING_KEY_ID").unwrap_or_else(|_| "auth-2026-01".into());
            let authority = SigningAuthority::from_base64url(key_id, &secret)?;
            let consume_url = env::var("RDC_AUTH_EXECUTION_CONSUME_URL")?;
            let source = std::fs::read_to_string(source)?;
            let rendered = render_runner_source(&source, &authority, &consume_url)?;
            std::fs::write(output, rendered)?;
            store()?.publish_artifact(
                artifact_id,
                version,
                abi,
                android,
                &PathBuf::from(output),
            )?;
            println!("protected runner rendered and published");
            Ok(())
        }
        _ => Err(usage().into()),
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    #[test]
    fn usage_documents_entitlement_revoke() {
        assert!(usage().contains("entitlement revoke"));
    }

    #[test]
    fn runner_rendering_replaces_trusted_key_and_consume_url_placeholders() {
        let old_authority =
            SigningAuthority::from_base64url("auth-old", &URL_SAFE_NO_PAD.encode([7; 32])).unwrap();
        let next_authority =
            SigningAuthority::from_base64url("auth-next", &URL_SAFE_NO_PAD.encode([8; 32]))
                .unwrap();
        let source =
            "key=__RDC_EXECUTION_KEY_ID__ public=__RDC_EXECUTION_PUBLIC_KEY__ url=__RDC_EXECUTION_CONSUME_URL__";
        let old_rendered = render_runner_source(
            source,
            &old_authority,
            "https://auth.example/v1/execution-grants/consume",
        )
        .unwrap();
        let next_rendered = render_runner_source(
            source,
            &next_authority,
            "https://auth.example/v1/execution-grants/consume",
        )
        .unwrap();
        assert!(old_rendered.contains(old_authority.key_id()));
        assert!(old_rendered.contains(&old_authority.public_key_base64url()));
        assert!(!old_rendered.contains(next_authority.key_id()));
        assert!(!old_rendered.contains(&next_authority.public_key_base64url()));
        assert!(next_rendered.contains(next_authority.key_id()));
        assert!(next_rendered.contains(&next_authority.public_key_base64url()));
        assert!(!next_rendered.contains(old_authority.key_id()));
        assert!(!next_rendered.contains(&old_authority.public_key_base64url()));
        for rendered in [old_rendered, next_rendered] {
            assert!(rendered.contains("https://auth.example/v1/execution-grants/consume"));
            assert!(!rendered.contains("__RDC_EXECUTION_"));
        }
    }
}
