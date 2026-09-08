use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferProgress {
    pub operation_id: String,
    pub direction: String,
    pub status: String,
    pub bytes_transferred: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedProgress {
    pub percent: u8,
    pub bytes_transferred: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Default)]
pub struct TransferRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TransferRegistry {
    pub fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        let operation_id = operation_id.trim();
        if operation_id.is_empty() {
            return Err("operation id cannot be empty".into());
        }

        let mut active = self.active.lock();
        if active.contains_key(operation_id) {
            return Err(format!("transfer {operation_id} is already active"));
        }
        let token = Arc::new(AtomicBool::new(false));
        active.insert(operation_id.to_string(), token.clone());
        Ok(token)
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let token = self.active.lock().get(operation_id).cloned();
        if let Some(token) = token {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn finish(&self, operation_id: &str) {
        self.active.lock().remove(operation_id);
    }
}

pub fn emit_progress(app: &AppHandle, payload: FileTransferProgress) -> Result<(), String> {
    app.emit("file-transfer-progress", payload)
        .map_err(|e| e.to_string())
}

pub fn parse_adb_progress(text: &str, total_bytes: Option<u64>) -> Option<ParsedProgress> {
    let bytes = text.as_bytes();
    let mut last_percent = None;
    let mut index = 0;

    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }

        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'%' {
            continue;
        }

        let percent = text[start..index].parse::<u16>().ok()?;
        last_percent = Some(percent.min(100) as u8);
        index += 1;
    }

    let percent = last_percent?;
    Some(ParsedProgress {
        percent,
        bytes_transferred: total_bytes.map(|total| total.saturating_mul(percent as u64) / 100),
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_serializes_using_frontend_field_names() {
        let payload = FileTransferProgress {
            operation_id: "op-1".into(),
            direction: "upload".into(),
            status: "running".into(),
            bytes_transferred: Some(512),
            total_bytes: Some(1024),
            percent: Some(50),
            message: "上传中".into(),
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["operationId"], "op-1");
        assert_eq!(value["bytesTransferred"], 512);
        assert_eq!(value["totalBytes"], 1024);
    }

    #[test]
    fn registry_rejects_empty_and_duplicate_ids_and_cleans_finished_ids() {
        let registry = TransferRegistry::default();
        assert!(registry.start(" ").is_err());
        let _token = registry.start("op-1").unwrap();
        assert!(registry.start("op-1").is_err());
        assert!(registry.cancel("op-1"));
        registry.finish("op-1");
        assert!(registry.start("op-1").is_ok());
        assert!(!registry.cancel("missing"));
    }

    #[test]
    fn parser_accepts_cr_refreshed_percent_and_maps_known_total() {
        let parsed =
            parse_adb_progress("[  0%] file\r[ 50%] file\r[100%] file", Some(2048)).unwrap();
        assert_eq!(parsed.percent, 100);
        assert_eq!(parsed.bytes_transferred, Some(2048));
        assert_eq!(parsed.total_bytes, Some(2048));
    }

    #[test]
    fn parser_ignores_unrelated_numbers_and_unknown_total() {
        assert!(parse_adb_progress("pull 2026 bytes without percent", Some(1)).is_none());
        let parsed = parse_adb_progress("[ 25%] file", None).unwrap();
        assert_eq!(parsed.percent, 25);
        assert_eq!(parsed.bytes_transferred, None);
        assert_eq!(parsed.total_bytes, None);
    }
}
