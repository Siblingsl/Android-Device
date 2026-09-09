use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::models::{ScrcpyRecordingOptions, ShellResult};
use crate::services::{adb, log, settings};

static PROCESSES: Lazy<Mutex<HashMap<String, Child>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static RECORDING_PROCESSES: Lazy<Mutex<HashMap<String, Child>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CAMERA_PROCESSES: Lazy<Mutex<HashMap<String, Child>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
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
    status_for(&PROCESSES, serial)
}

pub fn recording_status(serial: &str) -> String {
    status_for(&RECORDING_PROCESSES, serial)
}

pub fn camera_status(serial: &str) -> String {
    status_for(&CAMERA_PROCESSES, serial)
}

fn status_for(map: &Mutex<HashMap<String, Child>>, serial: &str) -> String {
    let mut map = map.lock();
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

fn configured_command(bin: &str) -> Command {
    let adb_path = settings::adb_path();
    let mut cmd = Command::new(bin);
    if Path::new(&adb_path).exists() {
        cmd.env("ADB", &adb_path);
    }
    if let Some(parent) = Path::new(bin).parent() {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{};{}", parent.display(), path));
    }
    cmd
}

fn scrcpy_error(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: message.into(),
        exit_code: -1,
    }
}

fn scrcpy_success(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: true,
        stdout: message.into(),
        stderr: String::new(),
        exit_code: 0,
    }
}

fn spawn_managed(
    serial: &str,
    args: Vec<String>,
    map: &Mutex<HashMap<String, Child>>,
    label: &str,
) -> ShellResult {
    let bin = scrcpy_bin();
    if bin != "scrcpy" && !Path::new(&bin).exists() {
        return scrcpy_error(format!(
            "找不到 scrcpy 可执行文件: {}。请在 Settings 中配置正确的 Scrcpy 路径。",
            bin
        ));
    }

    match configured_command(&bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            thread::sleep(Duration::from_millis(800));
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut err = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        use std::io::Read;
                        let _ = stderr.read_to_string(&mut err);
                    }
                    scrcpy_error(format!(
                        "{} 启动后立即退出 (code={:?}): {}",
                        label,
                        status.code(),
                        err.trim()
                    ))
                }
                Ok(None) => {
                    map.lock().insert(serial.to_string(), child);
                    log::info(label, &format!("{} running for {}", label, serial));
                    scrcpy_success(format!("{} started", label))
                }
                Err(e) => scrcpy_error(format!("{} 状态检查失败: {}", label, e)),
            }
        }
        Err(e) => scrcpy_error(format!("无法启动 scrcpy ({}): {}", bin, e)),
    }
}

fn stop_managed(
    serial: &str,
    map: &Mutex<HashMap<String, Child>>,
    label: &str,
) -> ShellResult {
    let mut processes = map.lock();
    if let Some(mut child) = processes.remove(serial) {
        let _ = child.kill();
        let _ = child.wait();
        log::info(label, &format!("{} stopped for {}", label, serial));
        scrcpy_success(format!("{} stopped", label))
    } else {
        scrcpy_success("not running")
    }
}

fn validate_camera_options(options: &ScrcpyRecordingOptions) -> Result<(), String> {
    if options.camera_id.len() > 32
        || (!options.camera_id.is_empty()
            && !options
                .camera_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'))
    {
        return Err("摄像头 ID 无效".into());
    }
    if !options.camera_size.is_empty()
        && !options.camera_size.split_once('x').is_some_and(|(w, h)| {
            w.parse::<u32>().is_ok_and(|v| (2..=99999).contains(&v))
                && h.parse::<u32>().is_ok_and(|v| (2..=99999).contains(&v))
        })
    {
        return Err("摄像头分辨率无效".into());
    }
    if !valid_camera_ar(&options.camera_ar) {
        return Err("摄像头比例无效".into());
    }
    if !(1..=240).contains(&options.camera_fps) {
        return Err("摄像头帧率应为 1-240".into());
    }
    if !matches!(options.camera_facing.as_str(), "front" | "back" | "external") {
        return Err("摄像头方向无效".into());
    }
    if !options.camera_zoom.is_finite() || !(1.0..=20.0).contains(&options.camera_zoom) {
        return Err("摄像头缩放应为 1-20".into());
    }
    Ok(())
}

fn valid_camera_ar(value: &str) -> bool {
    if value == "sensor" {
        return true;
    }
    let ratio = value.split(':').collect::<Vec<_>>();
    if ratio.len() == 2 {
        return ratio.iter().all(|part| {
            part.parse::<u32>().is_ok_and(|number| number > 0)
        });
    }
    value
        .parse::<f32>()
        .is_ok_and(|number| number.is_finite() && number > 0.0)
}

fn camera_args(options: &ScrcpyRecordingOptions) -> Vec<String> {
    let mut args = vec![
        format!("--camera-size={}", options.camera_size),
        format!("--camera-ar={}", options.camera_ar),
        format!("--camera-fps={}", options.camera_fps),
        format!("--camera-zoom={}", options.camera_zoom),
    ];
    if !options.camera_id.is_empty() {
        args.push(format!("--camera-id={}", options.camera_id));
    } else {
        args.push(format!("--camera-facing={}", options.camera_facing));
    }
    if options.camera_torch {
        args.push("--camera-torch".into());
    }
    args
}

pub fn start_recording(serial: &str, options: ScrcpyRecordingOptions) -> ShellResult {
    if options.output_path.trim().is_empty() || options.output_path.contains('\0') {
        return scrcpy_error("录制输出路径不能为空");
    }
    if !matches!(options.format.as_str(), "mp4" | "mkv") {
        return scrcpy_error("录制格式仅支持 mp4 或 mkv");
    }
    if !matches!(options.audio_source.as_str(), "output" | "playback" | "mic") {
        return scrcpy_error("音频来源无效");
    }
    if !matches!(options.video_source.as_str(), "display" | "camera") {
        return scrcpy_error("视频来源无效");
    }
    if options.audio_only && !options.audio {
        return scrcpy_error("仅音频录制需要开启音频");
    }
    if options.time_limit_secs > 3600 {
        return scrcpy_error("录制时长不能超过 3600 秒");
    }
    if let Err(error) = validate_camera_options(&options) {
        return scrcpy_error(error);
    }
    stop_recording(serial);
    if let Err(error) = ensure_device_ready(serial) {
        return scrcpy_error(error);
    }
    wake_screen(serial);

    let mut args = vec![
        "-s".into(),
        serial.into(),
        "--no-playback".into(),
        "--no-window".into(),
        "--no-control".into(),
        "--record".into(),
        options.output_path.clone(),
        "--record-format".into(),
        options.format.clone(),
        "--stay-awake".into(),
    ];
    if !options.audio {
        args.push("--no-audio".into());
    } else {
        args.push(format!("--audio-source={}", options.audio_source));
    }
    if options.audio_only {
        args.push("--no-video".into());
    } else if options.video_source == "camera" {
        args.push("--video-source=camera".into());
        args.extend(camera_args(&options));
    } else {
        args.push("--video-source=display".into());
    }
    if options.time_limit_secs > 0 {
        args.push(format!("--time-limit={}", options.time_limit_secs));
    }
    spawn_managed(serial, args, &RECORDING_PROCESSES, "Scrcpy recording")
}

pub fn stop_recording(serial: &str) -> ShellResult {
    stop_managed(serial, &RECORDING_PROCESSES, "Scrcpy recording")
}

pub fn start_camera(serial: &str, options: ScrcpyRecordingOptions) -> ShellResult {
    if let Err(error) = validate_camera_options(&options) {
        return scrcpy_error(error);
    }
    stop_camera(serial);
    if let Err(error) = ensure_device_ready(serial) {
        return scrcpy_error(error);
    }
    wake_screen(serial);
    let mut args = vec![
        "-s".into(),
        serial.into(),
        "--video-source=camera".into(),
        "--no-audio".into(),
        "--stay-awake".into(),
        "--window-title".into(),
        format!("Redroid Camera - {}", serial),
    ];
    args.extend(camera_args(&options));
    spawn_managed(serial, args, &CAMERA_PROCESSES, "Scrcpy camera")
}

pub fn stop_camera(serial: &str) -> ShellResult {
    stop_managed(serial, &CAMERA_PROCESSES, "Scrcpy camera")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ScrcpyRecordingOptions {
        ScrcpyRecordingOptions {
            output_path: "C:\\captures\\demo.mp4".into(),
            format: "mp4".into(),
            audio: true,
            audio_only: false,
            audio_source: "mic".into(),
            video_source: "camera".into(),
            camera_id: "1".into(),
            camera_size: "1280x720".into(),
            camera_ar: "16:9".into(),
            camera_fps: 60,
            camera_facing: "front".into(),
            camera_torch: true,
            camera_zoom: 1.5,
            time_limit_secs: 30,
        }
    }

    #[test]
    fn camera_args_are_explicit_and_do_not_use_shell_interpolation() {
        let args = camera_args(&options());
        assert!(args.contains(&"--camera-id=1".into()));
        assert!(args.contains(&"--camera-torch".into()));
        assert!(args.contains(&"--camera-zoom=1.5".into()));
        assert!(!args.iter().any(|arg| arg.contains(';') || arg.contains('|')));
    }

    #[test]
    fn invalid_camera_options_are_rejected_before_adb_is_touched() {
        let mut invalid = options();
        invalid.camera_size = "1280;rmx720".into();
        assert!(validate_camera_options(&invalid).is_err());
    }
}
