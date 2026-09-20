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
use sha2::{Digest, Sha256};
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
    #[serde(default)]
    client_key_algorithm: Option<ClientKeyAlgorithm>,
    #[serde(default)]
    public_key: Option<String>,
    #[serde(default)]
    cng_key_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub install_id: String,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceSecurityLevel {
    HardwareBacked,
    CngSoftwareProvider,
    DpapiSoftwareFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceSecurityPolicy {
    pub prefer_cng: bool,
    pub require_hardware_backed: bool,
}

impl Default for DeviceSecurityPolicy {
    fn default() -> Self {
        Self {
            prefer_cng: false,
            require_hardware_backed: false,
        }
    }
}

#[derive(Debug)]
pub struct DeviceAuthMaterial {
    pub identity: DeviceIdentity,
    pub signer: DeviceSigner,
    pub security_level: DeviceSecurityLevel,
}

#[derive(Debug)]
pub enum DeviceSigner {
    Ed25519(SigningKey),
    #[cfg(windows)]
    Cng(CngDeviceSigner),
}

impl DeviceSigner {
    pub fn algorithm(&self) -> ClientKeyAlgorithm {
        match self {
            Self::Ed25519(_) => ClientKeyAlgorithm::Ed25519DpapiV1,
            #[cfg(windows)]
            Self::Cng(_) => ClientKeyAlgorithm::EcdsaP256CngV1,
        }
    }

    pub fn public_key_base64url(&self) -> String {
        match self {
            Self::Ed25519(key) => URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            #[cfg(windows)]
            Self::Cng(signer) => signer.metadata.public_key.clone(),
        }
    }

    pub fn sign_canonical(&self, payload: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
        match self {
            Self::Ed25519(key) => Ok(ed25519_dalek::Signer::sign(key, payload)
                .to_bytes()
                .to_vec()),
            #[cfg(windows)]
            Self::Cng(signer) => signer.sign_canonical(payload),
        }
    }
}

impl DeviceSigner {
    pub fn security_level(&self) -> DeviceSecurityLevel {
        match self {
            Self::Ed25519(_) => DeviceSecurityLevel::DpapiSoftwareFallback,
            #[cfg(windows)]
            Self::Cng(signer) => signer.security_level(),
        }
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CngDeviceMetadata {
    pub algorithm: ClientKeyAlgorithm,
    pub key_name: String,
    pub public_key: String,
    pub hardware_backed: bool,
}

#[cfg(windows)]
#[derive(Debug)]
pub struct CngDeviceSigner {
    provider: windows_sys::Win32::Security::Cryptography::NCRYPT_PROV_HANDLE,
    key: windows_sys::Win32::Security::Cryptography::NCRYPT_KEY_HANDLE,
    metadata: CngDeviceMetadata,
}

#[cfg(windows)]
impl CngDeviceSigner {
    pub fn open_or_create(
        key_name: &str,
        require_hardware: bool,
    ) -> Result<Self, SecureStoreError> {
        Self::open_internal(key_name, require_hardware, true)
    }

    pub fn open_existing(key_name: &str, require_hardware: bool) -> Result<Self, SecureStoreError> {
        Self::open_internal(key_name, require_hardware, false)
    }

    fn open_internal(
        key_name: &str,
        require_hardware: bool,
        create_if_missing: bool,
    ) -> Result<Self, SecureStoreError> {
        use windows_sys::Win32::Foundation::{NTE_BAD_KEYSET, NTE_NOT_SUPPORTED};
        use windows_sys::Win32::Security::Cryptography::{
            NCryptCreatePersistedKey, NCryptExportKey, NCryptFinalizeKey, NCryptGetProperty,
            NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_ECCPUBLIC_BLOB,
            BCRYPT_ECDSA_P256_ALGORITHM, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_ALLOW_SIGNING_FLAG,
            NCRYPT_IMPL_HARDWARE_FLAG, NCRYPT_IMPL_TYPE_PROPERTY,
            NCRYPT_IMPL_VIRTUAL_ISOLATION_FLAG, NCRYPT_KEY_USAGE_PROPERTY, NCRYPT_SILENT_FLAG,
        };
        if key_name.trim().is_empty() || key_name.encode_utf16().any(|unit| unit == 0) {
            return Err(SecureStoreError::InvalidKey);
        }
        let name = to_wide(key_name);
        let mut provider = 0;
        let status =
            unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) };
        if status != 0 {
            return Err(SecureStoreError::Unsupported);
        }
        let mut key = 0;
        let opened =
            unsafe { NCryptOpenKey(provider, &mut key, name.as_ptr(), 0, NCRYPT_SILENT_FLAG) };
        let key = if opened == 0 {
            key
        } else if opened == NTE_BAD_KEYSET && create_if_missing {
            let created = unsafe {
                NCryptCreatePersistedKey(
                    provider,
                    &mut key,
                    BCRYPT_ECDSA_P256_ALGORITHM,
                    name.as_ptr(),
                    0,
                    0,
                )
            };
            if created != 0 {
                unsafe { windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider) };
                return Err(cng_error("create CNG key", created));
            }
            let usage = NCRYPT_ALLOW_SIGNING_FLAG.to_le_bytes();
            let property = unsafe {
                NCryptSetProperty(
                    key,
                    NCRYPT_KEY_USAGE_PROPERTY,
                    usage.as_ptr(),
                    usage.len() as u32,
                    0,
                )
            };
            if property != 0 {
                unsafe {
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
                }
                return Err(cng_error("set CNG key usage", property));
            }
            let finalized = unsafe { NCryptFinalizeKey(key, 0) };
            if finalized != 0 {
                unsafe {
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
                }
                return Err(cng_error("finalize CNG key", finalized));
            }
            key
        } else {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(cng_error("open CNG key", opened));
        };
        let mut implementation = 0_u32;
        let mut implementation_size = 0_u32;
        let property_status = unsafe {
            NCryptGetProperty(
                key,
                NCRYPT_IMPL_TYPE_PROPERTY,
                (&mut implementation as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut implementation_size,
                0,
            )
        };
        if property_status != 0 && property_status != NTE_NOT_SUPPORTED {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(cng_error("read CNG implementation type", property_status));
        }
        let hardware_backed = property_status == 0
            && implementation_size == 4
            && implementation & (NCRYPT_IMPL_HARDWARE_FLAG | NCRYPT_IMPL_VIRTUAL_ISOLATION_FLAG)
                != 0;
        if require_hardware && !hardware_backed {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(SecureStoreError::Unsupported);
        }
        let mut required = 0_u32;
        let exported = unsafe {
            NCryptExportKey(
                key,
                0,
                BCRYPT_ECCPUBLIC_BLOB,
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                &mut required,
                0,
            )
        };
        if exported != 0 || required < 8 {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(cng_error("size CNG public key blob", exported));
        }
        let mut blob = vec![0_u8; required as usize];
        let exported = unsafe {
            NCryptExportKey(
                key,
                0,
                BCRYPT_ECCPUBLIC_BLOB,
                std::ptr::null(),
                blob.as_mut_ptr(),
                blob.len() as u32,
                &mut required,
                0,
            )
        };
        if exported != 0 {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(cng_error("export CNG public key", exported));
        }
        if required as usize != blob.len() {
            unsafe {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
            }
            return Err(SecureStoreError::Corrupt(
                "CNG public key export length changed unexpectedly".into(),
            ));
        }
        let public_key = match Self::public_key_from_blob(&blob) {
            Ok(public_key) => public_key,
            Err(error) => {
                unsafe {
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(key);
                    windows_sys::Win32::Security::Cryptography::NCryptFreeObject(provider);
                }
                return Err(error);
            }
        };
        Ok(Self {
            provider,
            key,
            metadata: CngDeviceMetadata {
                algorithm: ClientKeyAlgorithm::EcdsaP256CngV1,
                key_name: key_name.into(),
                public_key: URL_SAFE_NO_PAD.encode(public_key),
                hardware_backed,
            },
        })
    }

    pub fn metadata(&self) -> &CngDeviceMetadata {
        &self.metadata
    }

    pub fn security_level(&self) -> DeviceSecurityLevel {
        if self.metadata.hardware_backed {
            DeviceSecurityLevel::HardwareBacked
        } else {
            DeviceSecurityLevel::CngSoftwareProvider
        }
    }

    pub fn public_key_from_blob(blob: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
        use windows_sys::Win32::Security::Cryptography::BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
        if blob.len() < 8 {
            return Err(SecureStoreError::Corrupt(
                "CNG public key blob header is truncated".into(),
            ));
        }
        let magic = u32::from_le_bytes(blob[0..4].try_into().unwrap());
        let field_length = u32::from_le_bytes(blob[4..8].try_into().unwrap());
        if magic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || field_length != 32 {
            return Err(SecureStoreError::Corrupt(
                "CNG public key blob is not an ECDSA P-256 public key".into(),
            ));
        }
        let expected = 8 + field_length as usize * 2;
        if blob.len() != expected {
            return Err(SecureStoreError::Corrupt(
                "CNG public key blob has an invalid coordinate length".into(),
            ));
        }
        let mut public_key = Vec::with_capacity(65);
        public_key.push(0x04);
        public_key.extend_from_slice(&blob[8..]);
        Ok(public_key)
    }

    pub fn validate_signature(signature: &[u8]) -> Result<(), SecureStoreError> {
        if signature.len() == 64 {
            Ok(())
        } else {
            Err(SecureStoreError::Corrupt(
                "CNG ECDSA signature must contain raw r and s values".into(),
            ))
        }
    }

    fn delete_persisted_key(mut self) -> Result<(), SecureStoreError> {
        use windows_sys::Win32::Security::Cryptography::NCryptDeleteKey;
        let key = self.key;
        self.key = 0;
        let status = unsafe { NCryptDeleteKey(key, 0) };
        if status != 0 {
            self.key = key;
            return Err(cng_error("delete CNG key", status));
        }
        Ok(())
    }

    fn sign_canonical(&self, payload: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
        use windows_sys::Win32::Security::Cryptography::NCryptSignHash;
        let digest = Sha256::digest(payload);
        let mut signature = vec![0_u8; 64];
        let mut written = 0_u32;
        let status = unsafe {
            NCryptSignHash(
                self.key,
                std::ptr::null(),
                digest.as_ptr(),
                digest.len() as u32,
                signature.as_mut_ptr(),
                signature.len() as u32,
                &mut written,
                0,
            )
        };
        if status != 0 {
            return Err(cng_error("sign with CNG key", status));
        }
        signature.truncate(written as usize);
        Self::validate_signature(&signature)?;
        Ok(signature)
    }

    #[cfg(test)]
    fn metadata_only_for_tests(key_name: &str, public_key: String, hardware_backed: bool) -> Self {
        Self {
            provider: 0,
            key: 0,
            metadata: CngDeviceMetadata {
                algorithm: ClientKeyAlgorithm::EcdsaP256CngV1,
                key_name: key_name.into(),
                public_key,
                hardware_backed,
            },
        }
    }

    #[cfg(test)]
    fn delete_persisted_key_for_tests(self) -> Result<(), SecureStoreError> {
        self.delete_persisted_key()
    }
}

#[cfg(windows)]
impl Drop for CngDeviceSigner {
    fn drop(&mut self) {
        unsafe {
            if self.key != 0 {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(self.key);
            }
            if self.provider != 0 {
                windows_sys::Win32::Security::Cryptography::NCryptFreeObject(self.provider);
            }
        }
    }
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn cng_error(operation: &str, status: i32) -> SecureStoreError {
    SecureStoreError::Protection(format!(
        "{operation} failed with status 0x{:08x}",
        status as u32
    ))
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
                client_key_algorithm: None,
                public_key: None,
                cng_key_name: None,
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
            if metadata.client_key_algorithm == Some(ClientKeyAlgorithm::EcdsaP256CngV1) {
                return Err(SecureStoreError::Corrupt(
                    "CNG identity cannot be loaded through the DPAPI compatibility path".into(),
                ));
            }
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
    Ok(load_or_create_device_material_with(
        &store,
        DeviceSecurityPolicy {
            prefer_cng: true,
            require_hardware_backed: false,
        },
    )?
    .identity)
}

fn enforce_security_policy(
    policy: DeviceSecurityPolicy,
    security_level: DeviceSecurityLevel,
) -> Result<(), SecureStoreError> {
    if policy.require_hardware_backed && security_level != DeviceSecurityLevel::HardwareBacked {
        return Err(SecureStoreError::Unsupported);
    }
    Ok(())
}

fn legacy_device_material<S: SecureStore>(
    store: &S,
    policy: DeviceSecurityPolicy,
) -> Result<DeviceAuthMaterial, SecureStoreError> {
    let identity = ensure_device_identity_with(store)?;
    let signer = DeviceSigner::Ed25519(load_signing_key_with(store)?);
    let security_level = signer.security_level();
    enforce_security_policy(policy, security_level)?;
    if signer.public_key_base64url() != identity.public_key {
        return Err(SecureStoreError::Corrupt(
            "device signer does not match the stored identity".into(),
        ));
    }
    Ok(DeviceAuthMaterial {
        identity,
        signer,
        security_level,
    })
}

#[cfg(windows)]
fn create_cng_device_material<S: SecureStore>(
    store: &S,
    policy: DeviceSecurityPolicy,
) -> Result<DeviceAuthMaterial, SecureStoreError> {
    let install_id = Uuid::new_v4().to_string();
    let device_id = Uuid::new_v4().to_string();
    let key_name = format!("RedroidDeviceCenter-{install_id}");
    let signer = CngDeviceSigner::open_or_create(&key_name, policy.require_hardware_backed)?;
    let security_level = signer.security_level();
    if let Err(error) = enforce_security_policy(policy, security_level) {
        let cleanup = signer.delete_persisted_key();
        return Err(cleanup.err().unwrap_or(error));
    }
    let public_key = signer.metadata.public_key.clone();
    let metadata = IdentityMetadata {
        install_id: install_id.clone(),
        device_id: device_id.clone(),
        client_key_algorithm: Some(ClientKeyAlgorithm::EcdsaP256CngV1),
        public_key: Some(public_key.clone()),
        cng_key_name: Some(key_name),
    };
    let metadata_bytes = serde_json::to_vec(&metadata)
        .map_err(|error| SecureStoreError::Corrupt(error.to_string()))?;
    if let Err(error) = store.save(IDENTITY_METADATA_KEY, &metadata_bytes) {
        let cleanup = signer.delete_persisted_key();
        return Err(cleanup.err().unwrap_or(error));
    }
    Ok(DeviceAuthMaterial {
        identity: DeviceIdentity {
            install_id,
            device_id,
            public_key,
        },
        signer: DeviceSigner::Cng(signer),
        security_level,
    })
}

#[cfg(windows)]
fn existing_cng_device_material<S: SecureStore>(
    store: &S,
    metadata: IdentityMetadata,
    policy: DeviceSecurityPolicy,
) -> Result<DeviceAuthMaterial, SecureStoreError> {
    let key_name = metadata
        .cng_key_name
        .ok_or_else(|| SecureStoreError::Corrupt("CNG identity is missing its key name".into()))?;
    let stored_public_key = metadata.public_key.ok_or_else(|| {
        SecureStoreError::Corrupt("CNG identity is missing its public key".into())
    })?;
    let signer = match CngDeviceSigner::open_existing(&key_name, policy.require_hardware_backed) {
        Ok(signer) => signer,
        Err(SecureStoreError::Unsupported) => return Err(SecureStoreError::Unsupported),
        Err(error) => {
            return Err(SecureStoreError::Corrupt(format!(
                "CNG device key is unavailable: {error}"
            )))
        }
    };
    let security_level = signer.security_level();
    enforce_security_policy(policy, security_level)?;
    let public_key = signer.metadata.public_key.clone();
    if public_key != stored_public_key {
        return Err(SecureStoreError::Corrupt(
            "CNG public key does not match the stored device identity".into(),
        ));
    }
    if store.load(PRIVATE_KEY_KEY)?.is_some() {
        return Err(SecureStoreError::Corrupt(
            "CNG identity unexpectedly contains a DPAPI private key".into(),
        ));
    }
    Ok(DeviceAuthMaterial {
        identity: DeviceIdentity {
            install_id: metadata.install_id,
            device_id: metadata.device_id,
            public_key,
        },
        signer: DeviceSigner::Cng(signer),
        security_level,
    })
}

pub fn load_or_create_device_material_with<S: SecureStore>(
    store: &S,
    policy: DeviceSecurityPolicy,
) -> Result<DeviceAuthMaterial, SecureStoreError> {
    let private = store.load(PRIVATE_KEY_KEY)?;
    let metadata = store
        .load(IDENTITY_METADATA_KEY)?
        .map(|bytes| {
            serde_json::from_slice::<IdentityMetadata>(&bytes)
                .map_err(|error| SecureStoreError::Corrupt(error.to_string()))
        })
        .transpose()?;

    if metadata
        .as_ref()
        .and_then(|value| value.client_key_algorithm)
        == Some(ClientKeyAlgorithm::EcdsaP256CngV1)
    {
        if private.is_some() {
            return Err(SecureStoreError::Corrupt(
                "CNG identity unexpectedly contains a DPAPI private key".into(),
            ));
        }
        let metadata = metadata.expect("CNG metadata was checked above");
        #[cfg(windows)]
        {
            return existing_cng_device_material(store, metadata, policy);
        }
        #[cfg(not(windows))]
        {
            let _ = metadata;
            return Err(SecureStoreError::Unsupported);
        }
    }

    if private.is_none() && metadata.is_none() && policy.prefer_cng {
        #[cfg(windows)]
        {
            match create_cng_device_material(store, policy) {
                Ok(material) => return Ok(material),
                Err(SecureStoreError::Unsupported) if !policy.require_hardware_backed => {}
                Err(error) => return Err(error),
            }
        }
        #[cfg(not(windows))]
        if policy.require_hardware_backed {
            return Err(SecureStoreError::Unsupported);
        }
    }

    legacy_device_material(store, policy)
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
    fn security_level_serializes_stably() {
        assert_eq!(
            serde_json::to_string(&DeviceSecurityLevel::HardwareBacked).unwrap(),
            "\"hardware_backed\""
        );
        assert_eq!(
            serde_json::to_string(&DeviceSecurityLevel::CngSoftwareProvider).unwrap(),
            "\"cng_software_provider\""
        );
        assert_eq!(
            serde_json::to_string(&DeviceSecurityLevel::DpapiSoftwareFallback).unwrap(),
            "\"dpapi_software_fallback\""
        );
    }

    #[test]
    fn permissive_policy_keeps_memory_store_on_dpapi_compatibility_path() {
        let store = MemorySecureStore::default();
        let material =
            load_or_create_device_material_with(&store, DeviceSecurityPolicy::default()).unwrap();
        assert_eq!(
            material.security_level,
            DeviceSecurityLevel::DpapiSoftwareFallback
        );
        assert_eq!(
            material.signer.algorithm(),
            ClientKeyAlgorithm::Ed25519DpapiV1
        );
    }

    #[test]
    fn strict_hardware_policy_rejects_software_fallback() {
        let store = MemorySecureStore::default();
        let policy = DeviceSecurityPolicy {
            prefer_cng: false,
            require_hardware_backed: true,
        };
        assert_eq!(
            load_or_create_device_material_with(&store, policy).unwrap_err(),
            SecureStoreError::Unsupported
        );
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
                    client_key_algorithm: None,
                    public_key: None,
                    cng_key_name: None,
                })
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(
            load_device_signer_with(&store),
            Err(SecureStoreError::Corrupt(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn cng_public_blob_metadata_is_public_only_and_uses_sec1_shape() {
        use windows_sys::Win32::Security::Cryptography::BCRYPT_ECDSA_PUBLIC_P256_MAGIC;

        let blob = test_cng_public_blob(BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32, 7);
        let public_key = CngDeviceSigner::public_key_from_blob(&blob).unwrap();
        assert_eq!(public_key.len(), 65);
        assert_eq!(public_key[0], 0x04);
        let signer = CngDeviceSigner::metadata_only_for_tests(
            "rdc-device-proof-test",
            URL_SAFE_NO_PAD.encode(&public_key),
            false,
        );
        let json = serde_json::to_string(&signer.metadata()).unwrap();
        assert!(json.contains("ecdsa-p256-cng-v1"));
        assert!(json.contains("rdc-device-proof-test"));
        assert!(!json.contains("private"));
    }

    #[cfg(windows)]
    #[test]
    fn cng_public_blob_and_signature_shapes_fail_closed() {
        use windows_sys::Win32::Security::Cryptography::BCRYPT_ECDSA_PUBLIC_P256_MAGIC;

        let valid = test_cng_public_blob(BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32, 3);
        assert!(CngDeviceSigner::public_key_from_blob(&valid).is_ok());
        let wrong_magic = test_cng_public_blob(0, 32, 3);
        assert!(matches!(
            CngDeviceSigner::public_key_from_blob(&wrong_magic),
            Err(SecureStoreError::Corrupt(_))
        ));
        let wrong_length = test_cng_public_blob(BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 31, 3);
        assert!(matches!(
            CngDeviceSigner::public_key_from_blob(&wrong_length),
            Err(SecureStoreError::Corrupt(_))
        ));
        assert!(matches!(
            CngDeviceSigner::validate_signature(&[0_u8; 63]),
            Err(SecureStoreError::Corrupt(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires RDC_RUN_CNG_PROVIDER_TESTS=1 and creates an ephemeral user key"]
    fn cng_provider_can_sign_with_an_ephemeral_named_key() {
        if std::env::var("RDC_RUN_CNG_PROVIDER_TESTS").ok().as_deref() != Some("1") {
            return;
        }
        let key_name = format!("RedroidDeviceCenter-test-{}", Uuid::new_v4());
        let signer = CngDeviceSigner::open_or_create(&key_name, false).unwrap();
        let signature = signer.sign_canonical(b"cng-provider-test").unwrap();
        assert_eq!(signature.len(), 64);
        signer.delete_persisted_key_for_tests().unwrap();
    }

    #[cfg(windows)]
    fn test_cng_public_blob(magic: u32, field_length: u32, fill: u8) -> Vec<u8> {
        let mut blob = Vec::with_capacity(8 + field_length as usize * 2);
        blob.extend_from_slice(&magic.to_le_bytes());
        blob.extend_from_slice(&field_length.to_le_bytes());
        blob.extend(std::iter::repeat(fill).take(field_length as usize * 2));
        blob
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
            client_key_algorithm: None,
            public_key: None,
            cng_key_name: None,
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
