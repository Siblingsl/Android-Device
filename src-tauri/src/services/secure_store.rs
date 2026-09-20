//! Small secure-storage boundary for client-held device identity material.
//!
//! The production implementation uses Windows DPAPI scoped to the current
//! Windows user. Tests use an in-memory store so identity lifecycle behavior
//! can be verified without touching the user's profile. The public
//! DeviceIdentity intentionally contains no private-key field.

use crate::services::authorization::ClientKeyAlgorithm;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

const PRIVATE_KEY_KEY: &str = "device-private-key";
const IDENTITY_METADATA_KEY: &str = "device-identity-metadata";

pub trait SecureStore: Send + Sync {
    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, SecureStoreError>;
    fn save(&self, key: &str, value: &[u8]) -> Result<(), SecureStoreError>;
    fn delete(&self, key: &str) -> Result<(), SecureStoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureStoreError {
    InvalidKey,
    EmptyValue,
    Io(String),
    Protection(String),
    Unprotection(String),
    Corrupt(String),
    Unsupported,
}

impl fmt::Display for SecureStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKey => f.write_str("secure-store key is invalid"),
            Self::EmptyValue => f.write_str("secure-store value must not be empty"),
            Self::Io(detail) => write!(f, "secure-store I/O failed: {detail}"),
            Self::Protection(detail) => write!(f, "secure-store protection failed: {detail}"),
            Self::Unprotection(detail) => {
                write!(f, "secure-store unprotection failed: {detail}")
            }
            Self::Corrupt(detail) => write!(f, "secure-store value is corrupt: {detail}"),
            Self::Unsupported => f.write_str("secure-store is unsupported on this platform"),
        }
    }
}

impl std::error::Error for SecureStoreError {}

fn validate_key(key: &str) -> Result<(), SecureStoreError> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(SecureStoreError::InvalidKey);
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct MemorySecureStore {
    values: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemorySecureStore {
    #[cfg(test)]
    fn raw_value(&self, key: &str) -> Option<Vec<u8>> {
        self.values.lock().unwrap().get(key).cloned()
    }
}

impl SecureStore for MemorySecureStore {
    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, SecureStoreError> {
        validate_key(key)?;
        Ok(self.values.lock().unwrap().get(key).cloned())
    }

    fn save(&self, key: &str, value: &[u8]) -> Result<(), SecureStoreError> {
        validate_key(key)?;
        if value.is_empty() {
            return Err(SecureStoreError::EmptyValue);
        }
        self.values
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_vec());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecureStoreError> {
        validate_key(key)?;
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

/// DPAPI-backed store. The files are only DPAPI ciphertext; the directory is
/// still kept under the app's local data directory so it is not accidentally
/// copied as an application asset or guest bind mount.
#[derive(Debug, Clone)]
pub struct WindowsSecureStore {
    root: PathBuf,
}

impl WindowsSecureStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn from_app_data() -> Result<Self, SecureStoreError> {
        let root = dirs::data_local_dir()
            .ok_or_else(|| SecureStoreError::Io("local app-data directory unavailable".into()))?
            .join("RedroidDeviceCenter")
            .join("secure-store");
        Ok(Self::new(root))
    }

    fn path_for(&self, key: &str) -> Result<PathBuf, SecureStoreError> {
        validate_key(key)?;
        Ok(self.root.join(format!("{key}.dpapi")))
    }
}

impl SecureStore for WindowsSecureStore {
    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, SecureStoreError> {
        let path = self.path_for(key)?;
        match std::fs::read(path) {
            Ok(ciphertext) => unprotect(&ciphertext).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(SecureStoreError::Io(error.to_string())),
        }
    }

    fn save(&self, key: &str, value: &[u8]) -> Result<(), SecureStoreError> {
        if value.is_empty() {
            return Err(SecureStoreError::EmptyValue);
        }
        let path = self.path_for(key)?;
        let ciphertext = protect(value)?;
        std::fs::create_dir_all(&self.root)
            .map_err(|error| SecureStoreError::Io(error.to_string()))?;
        let temp = path.with_extension(format!("dpapi.{}.tmp", Uuid::new_v4()));
        std::fs::write(&temp, ciphertext)
            .map_err(|error| SecureStoreError::Io(error.to_string()))?;
        if let Err(error) = std::fs::rename(&temp, &path) {
            let _ = std::fs::remove_file(&temp);
            return Err(SecureStoreError::Io(error.to_string()));
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecureStoreError> {
        let path = self.path_for(key)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(SecureStoreError::Io(error.to_string())),
        }
    }
}

#[cfg(windows)]
fn protect(value: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value
            .len()
            .try_into()
            .map_err(|_| SecureStoreError::Protection("value is too large for DPAPI".into()))?,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(SecureStoreError::Protection(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(_value: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
    Err(SecureStoreError::Unsupported)
}

#[cfg(windows)]
fn unprotect(value: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if value.is_empty() {
        return Err(SecureStoreError::Corrupt("empty DPAPI blob".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: value
            .len()
            .try_into()
            .map_err(|_| SecureStoreError::Unprotection("value is too large for DPAPI".into()))?,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(SecureStoreError::Unprotection(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    if bytes.is_empty() {
        return Err(SecureStoreError::Corrupt(
            "DPAPI returned an empty value".into(),
        ));
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn unprotect(_value: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
    Err(SecureStoreError::Unsupported)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IdentityMetadata {
    install_id: String,
    device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub install_id: String,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Debug)]
pub enum DeviceSigner {
    Ed25519(SigningKey),
}

impl DeviceSigner {
    pub fn algorithm(&self) -> ClientKeyAlgorithm {
        match self {
            Self::Ed25519(_) => ClientKeyAlgorithm::Ed25519DpapiV1,
        }
    }

    pub fn public_key_base64url(&self) -> String {
        match self {
            Self::Ed25519(key) => URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
        }
    }

    pub fn sign_canonical(&self, payload: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
        match self {
            Self::Ed25519(key) => Ok(ed25519_dalek::Signer::sign(key, payload)
                .to_bytes()
                .to_vec()),
        }
    }
}

fn build_identity(
    metadata: IdentityMetadata,
    private_key: &[u8],
) -> Result<DeviceIdentity, SecureStoreError> {
    let key_bytes: [u8; 32] = private_key.try_into().map_err(|_| {
        SecureStoreError::Corrupt("device private key must be exactly 32 bytes".into())
    })?;
    if metadata.install_id.trim().is_empty() || metadata.device_id.trim().is_empty() {
        return Err(SecureStoreError::Corrupt(
            "device identity metadata contains an empty ID".into(),
        ));
    }
    let signing_key = SigningKey::from_bytes(&key_bytes);
    Ok(DeviceIdentity {
        install_id: metadata.install_id,
        device_id: metadata.device_id,
        public_key: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
    })
}

/// Load or create the stable device identity. A partially missing pair is
/// treated as corruption: startup must not silently rotate the device binding.
pub fn ensure_device_identity_with<S: SecureStore>(
    store: &S,
) -> Result<DeviceIdentity, SecureStoreError> {
    let private = store.load(PRIVATE_KEY_KEY)?;
    let metadata = store.load(IDENTITY_METADATA_KEY)?;
    match (private, metadata) {
        (None, None) => {
            let signing_key = SigningKey::generate(&mut OsRng);
            let metadata = IdentityMetadata {
                install_id: Uuid::new_v4().to_string(),
                device_id: Uuid::new_v4().to_string(),
            };
            let metadata_bytes = serde_json::to_vec(&metadata)
                .map_err(|error| SecureStoreError::Corrupt(error.to_string()))?;
            store.save(PRIVATE_KEY_KEY, &signing_key.to_bytes())?;
            if let Err(error) = store.save(IDENTITY_METADATA_KEY, &metadata_bytes) {
                let _ = store.delete(PRIVATE_KEY_KEY);
                return Err(error);
            }
            build_identity(metadata, &signing_key.to_bytes())
        }
        (Some(private), Some(metadata)) => {
            let metadata: IdentityMetadata = serde_json::from_slice(&metadata)
                .map_err(|error| SecureStoreError::Corrupt(error.to_string()))?;
            build_identity(metadata, &private)
        }
        (Some(_), None) | (None, Some(_)) => Err(SecureStoreError::Corrupt(
            "device key and identity metadata are incomplete".into(),
        )),
    }
}

/// Production entry point. The private key is never returned by this API.
pub fn ensure_device_identity() -> Result<DeviceIdentity, SecureStoreError> {
    let store = WindowsSecureStore::from_app_data()?;
    ensure_device_identity_with(&store)
}

pub fn load_signing_key_with<S: SecureStore>(store: &S) -> Result<SigningKey, SecureStoreError> {
    let private = store
        .load(PRIVATE_KEY_KEY)?
        .ok_or_else(|| SecureStoreError::Corrupt("device private key is missing".into()))?;
    let bytes: [u8; 32] = private.try_into().map_err(|_| {
        SecureStoreError::Corrupt("device private key must be exactly 32 bytes".into())
    })?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub fn load_device_signer_with<S: SecureStore>(
    store: &S,
) -> Result<DeviceSigner, SecureStoreError> {
    Ok(DeviceSigner::Ed25519(load_signing_key_with(store)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::authorization::ClientKeyAlgorithm;
    use ed25519_dalek::Verifier;

    #[test]
    fn device_identity_round_trips_without_exposing_private_key_bytes() {
        let store = MemorySecureStore::default();
        let first = ensure_device_identity_with(&store).unwrap();
        let second = ensure_device_identity_with(&store).unwrap();
        assert_eq!(first.install_id, second.install_id);
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.public_key, second.public_key);
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("private"));
        assert_eq!(store.raw_value(PRIVATE_KEY_KEY).unwrap().len(), 32);
    }

    #[test]
    fn ed25519_device_signer_round_trips_without_exposing_private_key() {
        let store = MemorySecureStore::default();
        let identity = ensure_device_identity_with(&store).unwrap();
        let signer = load_device_signer_with(&store).unwrap();
        assert_eq!(signer.algorithm(), ClientKeyAlgorithm::Ed25519DpapiV1);
        assert_eq!(signer.public_key_base64url(), identity.public_key);
        let signature = signer.sign_canonical(b"device-proof").unwrap();
        let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(signer.public_key_base64url())
            .unwrap()
            .try_into()
            .unwrap();
        let key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes).unwrap();
        key.verify(
            b"device-proof",
            &ed25519_dalek::Signature::from_slice(&signature).unwrap(),
        )
        .unwrap();
        assert!(!serde_json::to_string(&identity)
            .unwrap()
            .contains("private"));
    }

    #[test]
    fn device_signer_fails_closed_when_private_key_is_missing() {
        let store = MemorySecureStore::default();
        store
            .save(
                IDENTITY_METADATA_KEY,
                &serde_json::to_vec(&IdentityMetadata {
                    install_id: "install-a".into(),
                    device_id: "device-a".into(),
                })
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(
            load_device_signer_with(&store),
            Err(SecureStoreError::Corrupt(_))
        ));
    }

    #[test]
    fn partial_identity_does_not_silently_regenerate_the_device_binding() {
        let store = MemorySecureStore::default();
        store.save(PRIVATE_KEY_KEY, &[1; 32]).unwrap();
        assert!(matches!(
            ensure_device_identity_with(&store),
            Err(SecureStoreError::Corrupt(_))
        ));
    }

    #[test]
    fn corrupt_private_key_is_rejected() {
        let store = MemorySecureStore::default();
        let metadata = serde_json::to_vec(&IdentityMetadata {
            install_id: "install-a".into(),
            device_id: "device-a".into(),
        })
        .unwrap();
        store.save(PRIVATE_KEY_KEY, &[1; 31]).unwrap();
        store.save(IDENTITY_METADATA_KEY, &metadata).unwrap();
        assert!(matches!(
            ensure_device_identity_with(&store),
            Err(SecureStoreError::Corrupt(_))
        ));
    }

    #[test]
    fn invalid_keys_and_empty_values_are_rejected() {
        let store = MemorySecureStore::default();
        assert_eq!(store.load("../secret"), Err(SecureStoreError::InvalidKey));
        assert_eq!(store.save("valid", &[]), Err(SecureStoreError::EmptyValue));
    }
}
