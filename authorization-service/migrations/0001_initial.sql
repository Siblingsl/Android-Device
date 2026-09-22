PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    device_public_key TEXT NOT NULL,
    client_version TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_challenges (
    client_id TEXT PRIMARY KEY REFERENCES clients(client_id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
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
