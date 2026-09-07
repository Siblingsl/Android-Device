use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::fs::OpenOptions;
use std::io::Write;
use uuid::Uuid;

use crate::models::LogEntry;
use crate::services::settings;
use crate::services::util::{ensure_dir, now_iso};

static LOGS: Lazy<Mutex<Vec<LogEntry>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn persist_line(entry: &LogEntry) {
    let dir = settings::log_path();
    if dir.is_empty() {
        return;
    }
    ensure_dir(&dir);
    let day = entry.timestamp.get(..10).unwrap_or("log");
    let path = std::path::Path::new(&dir).join(format!("rdc-{day}.log"));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            f,
            "[{}] [{}] [{}] {}",
            entry.timestamp, entry.level, entry.source, entry.message
        );
    }
}

pub fn append(level: &str, source: &str, message: &str) {
    let entry = LogEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: now_iso(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.to_string(),
    };
    persist_line(&entry);
    let mut logs = LOGS.lock();
    logs.push(entry);
    if logs.len() > 5000 {
        let drain = logs.len() - 5000;
        logs.drain(0..drain);
    }
}

pub fn info(source: &str, message: &str) {
    append("INFO", source, message);
}

pub fn warn(source: &str, message: &str) {
    append("WARN", source, message);
}

pub fn error(source: &str, message: &str) {
    append("ERROR", source, message);
}

pub fn debug(source: &str, message: &str) {
    append("DEBUG", source, message);
}

pub fn list(
    source_filter: Option<&str>,
    level_filter: Option<&str>,
    keyword: Option<&str>,
    limit: usize,
) -> Vec<LogEntry> {
    let logs = LOGS.lock();
    logs.iter()
        .rev()
        .filter(|l| {
            source_filter
                .map(|s| l.source.eq_ignore_ascii_case(s) || s == "all")
                .unwrap_or(true)
        })
        .filter(|l| {
            level_filter
                .map(|lv| l.level.eq_ignore_ascii_case(lv) || lv == "all")
                .unwrap_or(true)
        })
        .filter(|l| {
            keyword
                .map(|k| {
                    let k = k.to_lowercase();
                    l.message.to_lowercase().contains(&k) || l.source.to_lowercase().contains(&k)
                })
                .unwrap_or(true)
        })
        .take(limit)
        .cloned()
        .collect()
}

pub fn clear(also_today_file: bool) {
    LOGS.lock().clear();
    if !also_today_file {
        return;
    }
    let dir = settings::log_path();
    if dir.is_empty() {
        return;
    }
    let iso = now_iso();
    let day = iso.get(..10).unwrap_or("log");
    let path = std::path::Path::new(&dir).join(format!("rdc-{day}.log"));
    let _ = std::fs::remove_file(path);
}

pub fn export(path: &str, content: Option<&str>) -> Result<String, String> {
    let content = if let Some(c) = content {
        c.to_string()
    } else {
        list(None, None, None, 10000)
            .iter()
            .rev()
            .map(|l| format!("[{}] [{}] [{}] {}", l.timestamp, l.level, l.source, l.message))
            .collect::<Vec<_>>()
            .join("\n")
    };
    if let Some(parent) = std::path::Path::new(path).parent() {
        ensure_dir(&parent.to_string_lossy());
    }
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string())
}
