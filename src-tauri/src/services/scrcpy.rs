use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::models::ShellResult;
use crate::services::{adb, log, settings};

static PROCESSES: Lazy<Mutex<HashMap<String, Child>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static LAST_ARGS: Lazy<Mutex<HashMap<String, (u32, u32, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn extra_flags(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .filter(|t| t.starts_with("--") || t.starts_with('-') || t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'))
        .filter(|t| !t.contains('&') && !t.contains('|') && !t.contains(';') && !t.contains('`'))
        .map(|t| t.to_string())
        .collect()
}

pub fn scrcpy_bin() -> String {
    let configured = settings::scrcpy_path();
    if Path::new(&configured).exists() {
        return configured;
    }
    // Common Windows installs / PATH
    let candidates = [
        configured.as_str(),
        "scrcpy",
        r"C:\scrcpy\scrcpy.exe",
    ];
    for c in candidates {
        if c == "scrcpy" {
            return c.to_string();
        }
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    configured
}

pub fn status(serial: &str) -> String {
    let mut map = PROCESSES.lock();
    if let Some(child) = map.get_mut(serial) {
        match child.try_wait() {
            Ok(Some(_)) => {
                map.remove(serial);
                "stopped".into()
            }
            Ok(None) => "running".into(),
            Err(_) => {
                map.remove(serial);
                "error".into()
            }
        }
    } else {
        "stopped".into()
    }
}

/// Ensure serial is online via ADB before launching scrcpy.
pub fn ensure_device_ready(serial: &str) -> Result<(), String> {
    // TCP devices: connect first
    if serial.contains(':') {
        let _ = adb::disconnect(serial);
        thread::sleep(Duration::from_millis(200));
        let conn = adb::connect(serial);
        log::info(
            "Scrcpy",
            &format!("adb connect {}: {} {}", serial, conn.stdout, conn.stderr),
        );
    }

    // Wait up to ~15s for state=device
    for i in 0..15 {
        let devices = adb::devices();
        if let Some(d) = devices.iter().find(|d| d.serial == serial) {
            if d.state == "device" {
                return Ok(());
            }
            if d.state == "offline" || d.state == "unauthorized" {
                log::warn(
                    "Scrcpy",
                    &format!("device {} state={} (attempt {})", serial, d.state, i + 1),
                );
                if serial.contains(':') && i % 3 == 2 {
                    let _ = adb::disconnect(serial);
                    thread::sleep(Duration::from_millis(300));
                    let _ = adb::connect(serial);
                }
            }
        } else if serial.contains(':') {
            let _ = adb::connect(serial);
        }
        thread::sleep(Duration::from_secs(1));
    }

    let devices = adb::devices();
    let state = devices
        .iter()
        .find(|d| d.serial == serial)
        .map(|d| d.state.as_str())
        .unwrap_or("not found");
    Err(format!(
        "ADB 设备未就绪: {} (state={}). scrcpy 需要 state=device。若是 Redroid，请确认容器内 Android 已启动且 adbd 正常；Windows Docker Desktop 上 Redroid 常会出现 offline。",
        serial, state
    ))
}

/// Idle redroid screens sleep into a black scrcpy window; wake so the mirror
/// opens on the lit desktop. Best-effort.
fn wake_screen(serial: &str) {
    let r = adb::shell_timeout(
        serial,
        "input keyevent KEYCODE_WAKEUP",
        Duration::from_secs(10),
    );
    if !r.success {
        log::warn("Scrcpy", &format!("wake {} failed: {}", serial, r.stderr));
    }
}

pub fn start(serial: &str, max_size: u32, bit_rate: u32, extra: &str) -> ShellResult {
    stop(serial);
    log::info("Scrcpy", &format!("Starting scrcpy for {}", serial));

    if let Err(e) = ensure_device_ready(serial) {
        log::error("Scrcpy", &e);
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: e,
            exit_code: -1,
        };
    }

    wake_screen(serial);

    let bin = scrcpy_bin();
    if bin != "scrcpy" && !Path::new(&bin).exists() {
        let msg = format!(
            "找不到 scrcpy 可执行文件: {}。请在 Settings 中配置正确的 Scrcpy 路径。",
            bin
        );
        log::error("Scrcpy", &msg);
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: msg,
            exit_code: -1,
        };
    }

    let max_size_s = max_size.to_string();
    let bit_rate_s = format!("{}M", bit_rate.max(1));
    let title = format!("Redroid - {}", serial);

    // Prefer ADB from settings so scrcpy uses same adb binary
    let adb_path = settings::adb_path();
    let mut cmd = Command::new(&bin);
    if Path::new(&adb_path).exists() {
        cmd.env("ADB", &adb_path);
    }
    // Put scrcpy dir on PATH so it finds adb if bundled
    if let Some(parent) = Path::new(&bin).parent() {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("{};{}", parent.display(), path),
        );
    }

    LAST_ARGS
        .lock()
        .insert(serial.to_string(), (max_size, bit_rate, extra.to_string()));

    let mut args = vec![
        "-s".into(),
        serial.to_string(),
        "--max-size".into(),
        max_size_s,
        "--video-bit-rate".into(),
        bit_rate_s,
        "--window-title".into(),
        title,
        "--stay-awake".into(),
        "--no-audio".into(),
    ];
    for f in extra_flags(extra) {
        if f == "-s" || f == "--max-size" || f == "--video-bit-rate" || f == "--window-title" {
            continue;
        }
        args.push(f);
    }

    match cmd.args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            // Detect instant crash (common when device offline / no encoder)
            thread::sleep(Duration::from_millis(800));
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut err = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        use std::io::Read;
                        let _ = stderr.read_to_string(&mut err);
                    }
                    let msg = format!(
                        "scrcpy 启动后立即退出 (code={:?}): {}",
                        status.code(),
                        err.trim()
                    );
                    log::error("Scrcpy", &msg);
                    ShellResult {
                        success: false,
                        stdout: String::new(),
                        stderr: msg,
                        exit_code: status.code().unwrap_or(-1),
                    }
                }
                Ok(None) => {
                    PROCESSES.lock().insert(serial.to_string(), child);
                    log::info("Scrcpy", &format!("scrcpy running for {}", serial));
                    ShellResult {
                        success: true,
                        stdout: "scrcpy started".into(),
                        stderr: String::new(),
                        exit_code: 0,
                    }
                }
                Err(e) => {
                    log::error("Scrcpy", &format!("try_wait failed: {}", e));
                    ShellResult {
                        success: false,
                        stdout: String::new(),
                        stderr: e.to_string(),
                        exit_code: -1,
                    }
                }
            }
        }
        Err(e) => {
            let msg = format!("无法启动 scrcpy ({}): {}", bin, e);
            log::error("Scrcpy", &msg);
            ShellResult {
                success: false,
                stdout: String::new(),
                stderr: msg,
                exit_code: -1,
            }
        }
    }
}

pub fn stop(serial: &str) -> ShellResult {
    let mut map = PROCESSES.lock();
    if let Some(mut child) = map.remove(serial) {
        let _ = child.kill();
        let _ = child.wait();
        log::info("Scrcpy", &format!("scrcpy stopped for {}", serial));
        ShellResult {
            success: true,
            stdout: "scrcpy stopped".into(),
            stderr: String::new(),
            exit_code: 0,
        }
    } else {
        ShellResult {
            success: true,
            stdout: "not running".into(),
            stderr: String::new(),
            exit_code: 0,
        }
    }
}

pub fn restart(serial: &str) -> ShellResult {
    let (max_size, bit_rate, extra) = LAST_ARGS
        .lock()
        .get(serial)
        .cloned()
        .unwrap_or((1080, 8, String::new()));
    stop(serial);
    start(serial, max_size, bit_rate, &extra)
}
