use crate::crypto::{ClientKeyAlgorithm, ProtectedCapability};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug)]
pub enum StoreError {
    Sqlite(String),
    Corrupt(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(detail) => write!(f, "authorization store failed: {detail}"),
            Self::Corrupt(detail) => write!(f, "authorization store data is corrupt: {detail}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct ClientRecord {
    pub client_id: String,
    pub account_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub client_key_algorithm: ClientKeyAlgorithm,
    pub client_version: String,
    pub approved: bool,
    pub revoked: bool,
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session_id: String,
    pub client_id: String,
    pub account_id: String,
    pub device_id: String,
    pub capabilities: Vec<ProtectedCapability>,
    pub exp: i64,
    pub revoked: bool,
}

#[derive(Debug, Clone)]
pub struct ArtifactRecord {
    pub artifact_id: String,
    pub version: String,
    pub target_abi: String,
    pub target_android: String,
    pub path: String,
}

pub struct AuthStore {
    connection: Mutex<Connection>,
}

impl AuthStore {
    pub fn in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.initialize()?;
        Ok(store)
    }

    fn initialize(&self) -> Result<(), StoreError> {
        let connection = self.connection.lock().unwrap();
        connection.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS clients (
                client_id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL UNIQUE,
                device_public_key TEXT NOT NULL,
                client_key_algorithm TEXT NOT NULL DEFAULT 'ed25519-dpapi-v1',
                client_version TEXT NOT NULL,
                approved INTEGER NOT NULL DEFAULT 0,
                revoked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS registration_challenges (
                client_id TEXT PRIMARY KEY REFERENCES clients(client_id) ON DELETE CASCADE,
                challenge TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                requested_client_version TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS used_nonces (
                nonce TEXT PRIMARY KEY,
                used_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL REFERENCES clients(client_id),
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                capabilities_json TEXT NOT NULL,
                jti TEXT NOT NULL UNIQUE,
                exp INTEGER NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS entitlements (
                account_id TEXT NOT NULL,
                capability TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (account_id, capability)
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                artifact_id TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                target_abi TEXT NOT NULL,
                target_android TEXT NOT NULL,
                path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1
            );
            "#,
        )?;
        let has_requested_version = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('registration_challenges')
                 WHERE name = 'requested_client_version'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_requested_version {
            connection.execute(
                "ALTER TABLE registration_challenges
                 ADD COLUMN requested_client_version TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        let has_client_key_algorithm = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('clients')
                 WHERE name = 'client_key_algorithm'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_client_key_algorithm {
            connection.execute(
                "ALTER TABLE clients
                 ADD COLUMN client_key_algorithm TEXT NOT NULL DEFAULT 'ed25519-dpapi-v1'",
                [],
            )?;
        }
        Ok(())
    }

    pub fn create_pending_client(
        &self,
        client_id: &str,
        account_id: &str,
        device_id: &str,
        device_public_key: &str,
        client_key_algorithm: ClientKeyAlgorithm,
        client_version: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO clients (client_id, account_id, device_id, device_public_key, client_key_algorithm, client_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                client_id,
                account_id,
                device_id,
                device_public_key,
                serde_json::to_string(&client_key_algorithm)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?
                    .trim_matches('"'),
                client_version,
                now
            ],
        )?;
        Ok(())
    }

    pub fn set_registration_challenge(
        &self,
        client_id: &str,
        challenge: &str,
        requested_client_version: &str,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO registration_challenges
             (client_id, challenge, requested_client_version, expires_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(client_id) DO UPDATE SET challenge=excluded.challenge,
                requested_client_version=excluded.requested_client_version,
                expires_at=excluded.expires_at",
            params![client_id, challenge, requested_client_version, expires_at],
        )?;
        Ok(())
    }

    pub fn take_registration_challenge(
        &self,
        client_id: &str,
        challenge: &str,
        now: i64,
    ) -> Result<Option<String>, StoreError> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction()?;
        let requested_version = transaction
            .query_row(
                "SELECT requested_client_version FROM registration_challenges
                 WHERE client_id = ?1 AND challenge = ?2 AND expires_at > ?3",
                params![client_id, challenge, now],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if requested_version.is_some() {
            transaction.execute(
                "DELETE FROM registration_challenges WHERE client_id = ?1",
                params![client_id],
            )?;
        }
        transaction.commit()?;
        Ok(requested_version)
    }

    /// Read a still-valid challenge without consuming it. The caller must
    /// verify proof-of-possession before calling `take_registration_challenge`;
    /// otherwise an invalid request could deny the real device's registration.
    pub fn registration_challenge(
        &self,
        client_id: &str,
        challenge: &str,
        now: i64,
    ) -> Result<Option<String>, StoreError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT requested_client_version FROM registration_challenges
                 WHERE client_id = ?1 AND challenge = ?2 AND expires_at > ?3",
                params![client_id, challenge, now],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn client(&self, client_id: &str) -> Result<Option<ClientRecord>, StoreError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT client_id, account_id, device_id, device_public_key, client_key_algorithm, client_version, approved, revoked
                 FROM clients WHERE client_id = ?1",
                params![client_id],
                |row| {
                    Ok(ClientRecord {
                        client_id: row.get(0)?,
                        account_id: row.get(1)?,
                        device_id: row.get(2)?,
                        device_public_key: row.get(3)?,
                        client_key_algorithm: parse_client_key_algorithm(&row.get::<_, String>(4)?)?,
                        client_version: row.get(5)?,
                        approved: row.get::<_, i64>(6)? != 0,
                        revoked: row.get::<_, i64>(7)? != 0,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn client_by_device(&self, device_id: &str) -> Result<Option<ClientRecord>, StoreError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT client_id, account_id, device_id, device_public_key, client_key_algorithm, client_version, approved, revoked
                 FROM clients WHERE device_id = ?1",
                params![device_id],
                |row| {
                    Ok(ClientRecord {
                        client_id: row.get(0)?,
                        account_id: row.get(1)?,
                        device_id: row.get(2)?,
                        device_public_key: row.get(3)?,
                        client_key_algorithm: parse_client_key_algorithm(&row.get::<_, String>(4)?)?,
                        client_version: row.get(5)?,
                        approved: row.get::<_, i64>(6)? != 0,
                        revoked: row.get::<_, i64>(7)? != 0,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn update_client_registration(
        &self,
        client_id: &str,
        device_public_key: &str,
        client_key_algorithm: ClientKeyAlgorithm,
        client_version: &str,
    ) -> Result<bool, StoreError> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE sessions SET revoked = 1 WHERE client_id = ?1 AND revoked = 0",
            params![client_id],
        )?;
        let changed = transaction.execute(
            "UPDATE clients SET device_public_key = ?1, client_key_algorithm = ?2, client_version = ?3
             WHERE client_id = ?4 AND revoked = 0",
            params![
                device_public_key,
                serde_json::to_string(&client_key_algorithm)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?
                    .trim_matches('"'),
                client_version,
                client_id
            ],
        )? > 0;
        transaction.commit()?;
        Ok(changed)
    }

    pub fn approve_client(&self, client_id: &str) -> Result<bool, StoreError> {
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "UPDATE clients SET approved = 1 WHERE client_id = ?1",
            params![client_id],
        )? > 0)
    }

    pub fn approve_client_for_account(
        &self,
        client_id: &str,
        account_id: &str,
    ) -> Result<bool, StoreError> {
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "UPDATE clients SET account_id = ?1, approved = 1 WHERE client_id = ?2",
            params![account_id, client_id],
        )? > 0)
    }

    pub fn revoke_client(&self, client_id: &str) -> Result<bool, StoreError> {
        let connection = self.connection.lock().unwrap();
        let changed = connection.execute(
            "UPDATE clients SET revoked = 1 WHERE client_id = ?1",
            params![client_id],
        )? > 0;
        connection.execute(
            "UPDATE sessions SET revoked = 1 WHERE client_id = ?1",
            params![client_id],
        )?;
        Ok(changed)
    }

    pub fn grant_entitlement(
        &self,
        account_id: &str,
        capability: ProtectedCapability,
    ) -> Result<(), StoreError> {
        let capability = serde_json::to_string(&capability)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?
            .trim_matches('"')
            .to_owned();
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO entitlements (account_id, capability, enabled) VALUES (?1, ?2, 1)
             ON CONFLICT(account_id, capability) DO UPDATE SET enabled = 1",
            params![account_id, capability],
        )?;
        Ok(())
    }

    /// Disable a capability without deleting its row, so revocation remains
    /// observable in the authorization store and can be re-enabled explicitly.
    pub fn revoke_entitlement(
        &self,
        account_id: &str,
        capability: ProtectedCapability,
    ) -> Result<bool, StoreError> {
        let capability = serde_json::to_string(&capability)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?
            .trim_matches('"')
            .to_owned();
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "UPDATE entitlements SET enabled = 0
             WHERE account_id = ?1 AND capability = ?2 AND enabled <> 0",
            params![account_id, capability],
        )? > 0)
    }

    pub fn has_entitlement(
        &self,
        account_id: &str,
        capability: ProtectedCapability,
    ) -> Result<bool, StoreError> {
        let capability = serde_json::to_string(&capability)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?
            .trim_matches('"')
            .to_owned();
        let connection = self.connection.lock().unwrap();
        Ok(connection
            .query_row(
                "SELECT enabled FROM entitlements WHERE account_id = ?1 AND capability = ?2",
                params![account_id, capability],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|value| value != 0)
            .unwrap_or(false))
    }

    /// Atomically reserves a nonce; false means it has already been used.
    pub fn consume_nonce(&self, nonce: &str, now: i64) -> Result<bool, StoreError> {
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "INSERT OR IGNORE INTO used_nonces (nonce, used_at) VALUES (?1, ?2)",
            params![nonce, now],
        )? > 0)
    }

    pub fn create_session(
        &self,
        session_id: &str,
        client: &ClientRecord,
        capabilities: &[ProtectedCapability],
        jti: &str,
        exp: i64,
        now: i64,
    ) -> Result<(), StoreError> {
        let capabilities_json = serde_json::to_string(capabilities)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?;
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO sessions
             (session_id, client_id, account_id, device_id, capabilities_json, jti, exp, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session_id,
                client.client_id,
                client.account_id,
                client.device_id,
                capabilities_json,
                jti,
                exp,
                now
            ],
        )?;
        Ok(())
    }

    pub fn revoke_active_sessions_for_client(
        &self,
        client_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "UPDATE sessions SET revoked = 1
             WHERE client_id = ?1 AND revoked = 0 AND exp > ?2",
            params![client_id, now],
        )?;
        Ok(())
    }

    pub fn session(&self, session_id: &str) -> Result<Option<SessionRecord>, StoreError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT session_id, client_id, account_id, device_id, capabilities_json, exp, revoked
                 FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| {
                    let capabilities_json: String = row.get(4)?;
                    let capabilities = serde_json::from_str(&capabilities_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            capabilities_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok(SessionRecord {
                        session_id: row.get(0)?,
                        client_id: row.get(1)?,
                        account_id: row.get(2)?,
                        device_id: row.get(3)?,
                        capabilities,
                        exp: row.get(5)?,
                        revoked: row.get::<_, i64>(6)? != 0,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn refresh_session(
        &self,
        session_id: &str,
        capabilities: &[ProtectedCapability],
        jti: &str,
        exp: i64,
    ) -> Result<bool, StoreError> {
        let capabilities_json = serde_json::to_string(capabilities)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?;
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "UPDATE sessions SET capabilities_json = ?1, jti = ?2, exp = ?3
             WHERE session_id = ?4 AND revoked = 0",
            params![capabilities_json, jti, exp, session_id],
        )? > 0)
    }

    pub fn revoke_session(&self, session_id: &str) -> Result<bool, StoreError> {
        let connection = self.connection.lock().unwrap();
        Ok(connection.execute(
            "UPDATE sessions SET revoked = 1 WHERE session_id = ?1",
            params![session_id],
        )? > 0)
    }

    pub fn publish_artifact(
        &self,
        artifact_id: &str,
        version: &str,
        target_abi: &str,
        target_android: &str,
        path: &Path,
    ) -> Result<(), StoreError> {
        let path = path.to_string_lossy().to_string();
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO artifacts (artifact_id, version, target_abi, target_android, path, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(artifact_id) DO UPDATE SET version=excluded.version,
                target_abi=excluded.target_abi, target_android=excluded.target_android,
                path=excluded.path, enabled=1",
            params![artifact_id, version, target_abi, target_android, path],
        )?;
        Ok(())
    }

    pub fn artifact(&self, artifact_id: &str) -> Result<Option<ArtifactRecord>, StoreError> {
        let connection = self.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT artifact_id, version, target_abi, target_android, path
                 FROM artifacts WHERE artifact_id = ?1 AND enabled = 1",
                params![artifact_id],
                |row| {
                    Ok(ArtifactRecord {
                        artifact_id: row.get(0)?,
                        version: row.get(1)?,
                        target_abi: row.get(2)?,
                        target_android: row.get(3)?,
                        path: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    #[cfg(test)]
    pub fn seed_approved_client(&self, client: &ClientRecord) -> Result<(), StoreError> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "INSERT INTO clients
             (client_id, account_id, device_id, device_public_key, client_key_algorithm, client_version, approved, revoked, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, 0)",
            params![
                client.client_id,
                client.account_id,
                client.device_id,
                client.device_public_key,
                serde_json::to_string(&client.client_key_algorithm)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?
                    .trim_matches('"'),
                client.client_version
            ],
        )?;
        Ok(())
    }
}

fn parse_client_key_algorithm(value: &str) -> Result<ClientKeyAlgorithm, rusqlite::Error> {
    serde_json::from_str(&format!("\"{value}\"")).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_reservation_is_atomic_and_replay_is_rejected() {
        let store = AuthStore::in_memory().unwrap();
        assert!(store.consume_nonce("nonce-a", 1).unwrap());
        assert!(!store.consume_nonce("nonce-a", 2).unwrap());
    }

    #[test]
    fn entitlements_are_account_scoped() {
        let store = AuthStore::in_memory().unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        assert!(store
            .has_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap());
        assert!(!store
            .has_entitlement("account-b", ProtectedCapability::ProtectedPreset)
            .unwrap());
    }

    #[test]
    fn entitlement_revoke_disables_an_existing_capability() {
        let store = AuthStore::in_memory().unwrap();
        store
            .grant_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap();
        assert!(store
            .revoke_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap());
        assert!(!store
            .has_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap());
        assert!(!store
            .revoke_entitlement("account-a", ProtectedCapability::ProtectedPreset)
            .unwrap());
        assert!(!store
            .revoke_entitlement("missing", ProtectedCapability::ProtectedPreset)
            .unwrap());
    }

    #[test]
    fn client_registration_updates_version_without_changing_device_key() {
        let store = AuthStore::in_memory().unwrap();
        let client = ClientRecord {
            client_id: "client-a".into(),
            account_id: "account-a".into(),
            device_id: "device-a".into(),
            device_public_key: "key-a".into(),
            client_key_algorithm: ClientKeyAlgorithm::Ed25519DpapiV1,
            client_version: "1.0.0".into(),
            approved: true,
            revoked: false,
        };
        store.seed_approved_client(&client).unwrap();
        store
            .create_session(
                "session-a",
                &client,
                &[ProtectedCapability::ProtectedPreset],
                "jti-a",
                10_000,
                1,
            )
            .unwrap();
        let current = store.client_by_device("device-a").unwrap().unwrap();
        assert!(store
            .update_client_registration(
                &current.client_id,
                "key-a",
                ClientKeyAlgorithm::Ed25519DpapiV1,
                "1.1.0",
            )
            .unwrap());
        let updated = store.client("client-a").unwrap().unwrap();
        assert_eq!(updated.client_version, "1.1.0");
        assert_eq!(updated.device_public_key, "key-a");
        assert!(store.session("session-a").unwrap().unwrap().revoked);
    }
}
