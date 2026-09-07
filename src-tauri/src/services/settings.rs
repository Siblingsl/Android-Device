use parking_lot::Mutex;
use once_cell::sync::Lazy;
use std::path::PathBuf;

use crate::models::AppSettings;
use crate::services::util::{ensure_dir, set_runtime_proxy};

static SETTINGS: Lazy<Mutex<AppSettings>> = Lazy::new(|| Mutex::new(load_from_disk()));

fn settings_file() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("RedroidDeviceCenter");
    ensure_dir(&dir.to_string_lossy());
    dir.join("settings.json")
}

fn load_from_disk() -> AppSettings {
    let path = settings_file();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<AppSettings>(&content) {
                ensure_dirs(&s);
                set_runtime_proxy(&s.proxy);
                return s;
            }
        }
    }
    let s = AppSettings::default();
    ensure_dirs(&s);
    set_runtime_proxy(&s.proxy);
    let _ = save_to_disk(&s);
    s
}

fn ensure_dirs(s: &AppSettings) {
    ensure_dir(&s.log_path);
    ensure_dir(&s.screenshot_path);
    ensure_dir(&s.apk_path);
}

fn save_to_disk(s: &AppSettings) -> Result<(), String> {
    let path = settings_file();
    let content = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

pub fn get() -> AppSettings {
    SETTINGS.lock().clone()
}

pub fn update(settings: AppSettings) -> Result<AppSettings, String> {
    ensure_dirs(&settings);
    save_to_disk(&settings)?;
    set_runtime_proxy(&settings.proxy);
    *SETTINGS.lock() = settings.clone();
    Ok(settings)
}

pub fn adb_path() -> String {
    SETTINGS.lock().adb_path.clone()
}

pub fn docker_path() -> String {
    SETTINGS.lock().docker_path.clone()
}

pub fn scrcpy_path() -> String {
    SETTINGS.lock().scrcpy_path.clone()
}

pub fn screenshot_path() -> String {
    SETTINGS.lock().screenshot_path.clone()
}

pub fn apk_path() -> String {
    SETTINGS.lock().apk_path.clone()
}

pub fn log_path() -> String {
    SETTINGS.lock().log_path.clone()
}

pub fn gapps_zip_path() -> String {
    SETTINGS.lock().gapps_zip_path.clone()
}
