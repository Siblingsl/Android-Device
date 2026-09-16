use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::thread;
use std::time::Duration;

use crate::models::{RecordingSession, ShellResult};
use crate::services::{log, scrcpy, settings, util};

struct RecordingProcess {
    child: Child,
    session: RecordingSession,
}

static PROCESSES: Lazy<Mutex<HashMap<String, RecordingProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn error(
    serial: &str,
    mode: &str,
    output_path: &str,
    message: impl Into<String>,
) -> RecordingSession {
    RecordingSession {
        serial: serial.into(),
        mode: mode.into(),
        status: "error".into(),
        output_path: output_path.into(),
        message: message.into(),
    }
}

fn validate_output(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("录制文件路径不能为空".into());
    }
    if trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("录制文件路径包含非法字符".into());
    }
    let output = PathBuf::from(trimmed);
    if output.file_name().is_none() {
        return Err("录制路径必须包含文件名".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建录制目录失败: {e}"))?;
    }
    Ok(output)
}

fn output_format(mode: &str, output: &Path, requested: &str) -> Result<String, String> {
    let value = requested.trim().to_ascii_lowercase();
    if !value.is_empty() {
        let valid = match mode {
            "audio" => ["mka", "m4a", "opus", "aac", "flac", "wav"].contains(&value.as_str()),
            _ => ["mp4", "mkv"].contains(&value.as_str()),
        };
        if !valid {
            return Err(format!("录制模式不支持格式: {requested}"));
        }
        return Ok(value);
    }
    if mode == "audio" {
        return Ok("mka".into());
    }
    Ok(
        match output
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "mkv" => "mkv".into(),
            "webm" => "mkv".into(),
            _ => "mp4".into(),
        },
    )
}

fn valid_mode(mode: &str) -> bool {
    matches!(
        mode,
        "video" | "audio" | "av" | "camera" | "camera-record" | "camera-record-av" | "otg"
    )
}

fn append_camera_args(
    args: &mut Vec<String>,
    mode: &str,
    camera_torch: bool,
    camera_zoom: Option<f64>,
) -> Result<(), String> {
    if !matches!(mode, "camera" | "camera-record" | "camera-record-av") {
        return Ok(());
    }
    if camera_torch {
        args.push("--camera-torch".into());
    }
    if let Some(zoom) = camera_zoom {
        if !zoom.is_finite() || !(0.0..=100.0).contains(&zoom) {
            return Err("摄像头变焦必须在 0-100 之间".into());
        }
        args.push(format!("--camera-zoom={zoom}"));
    }
    Ok(())
}

fn build_args(
    serial: &str,
    mode: &str,
    output: &Path,
    camera_facing: &str,
    camera_id: &str,
    camera_ar: &str,
    camera_high_speed: bool,
    camera_size: &str,
    camera_fps: u32,
    time_limit: u32,
    record_format: &str,
    record_orientation: &str,
    gamepad: &str,
) -> Result<Vec<String>, String> {
    if serial.trim().is_empty() {
        return Err("设备 Serial 不能为空".into());
    }
    if !valid_mode(mode) {
        return Err(format!("不支持的录制模式: {mode}"));
    }
    if !record_orientation.trim().is_empty()
        && !matches!(record_orientation.trim(), "0" | "90" | "180" | "270")
    {
        return Err("录制方向只能是 0、90、180 或 270".into());
    }
    let mut args = vec!["-s".into(), serial.into()];
    if mode == "otg" {
        if !matches!(gamepad.trim(), "" | "disabled" | "uhid" | "aoa") {
            return Err("OTG 游戏手柄模式只能是 disabled、uhid 或 aoa".into());
        }
        args.push("--otg".into());
        args.push("--keyboard=sdk".into());
        args.push("--mouse=sdk".into());
        if !gamepad.trim().is_empty() {
            args.push(format!("--gamepad={}", gamepad.trim()));
        }
        return Ok(args);
    }
    let camera_mirror = mode == "camera";
    if !camera_mirror {
        args.push("--no-window".into());
    }
    if mode == "audio" {
        args.push("--no-video".into());
    } else if !matches!(mode, "av" | "camera-record-av") {
        args.push("--no-audio".into());
    }
    if matches!(mode, "camera" | "camera-record" | "camera-record-av") {
        args.push("--video-source=camera".into());
        if !camera_id.trim().is_empty() {
            if !camera_id.chars().all(|ch| ch.is_ascii_digit()) {
                return Err("摄像头 ID 只能是数字".into());
            }
            args.push(format!("--camera-id={}", camera_id.trim()));
        } else {
            let facing = if matches!(camera_facing, "front" | "back" | "external") {
                camera_facing
            } else {
                "back"
            };
            args.push(format!("--camera-facing={facing}"));
        }
        if !camera_ar.trim().is_empty() {
            if !camera_ar
                .chars()
                .all(|ch| ch.is_ascii_digit() || matches!(ch, ':' | '.'))
            {
                return Err("摄像头比例格式无效".into());
            }
            args.push(format!("--camera-ar={}", camera_ar.trim()));
        }
        if camera_high_speed {
            args.push("--camera-high-speed".into());
        }
        if !camera_size.trim().is_empty() {
            if !camera_size
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == 'x' || ch == 'X' || ch == '×')
            {
                return Err("摄像头分辨率只能使用宽x高".into());
            }
            args.push(format!(
                "--camera-size={}",
                camera_size.trim().replace('×', "x")
            ));
        }
        if camera_fps > 0 {
            args.push(format!("--camera-fps={camera_fps}"));
        }
    }
    if camera_mirror {
        return Ok(args);
    }
    args.push("--record".into());
    args.push(output.to_string_lossy().into_owned());
    args.push("--record-format".into());
    args.push(output_format(mode, output, record_format)?);
    if !record_orientation.trim().is_empty() {
        args.push("--record-orientation".into());
        args.push(record_orientation.trim().into());
    }
    if time_limit > 0 {
        args.push("--time-limit".into());
        args.push(time_limit.min(86_400).to_string());
    }
    Ok(args)
}

fn build_input_args(
    serial: &str,
    mode: &str,
    keyboard: bool,
    mouse: bool,
    gamepad: bool,
) -> Result<Vec<String>, String> {
    if serial.trim().is_empty() || serial.chars().any(|ch| ch.is_control()) {
        return Err("设备 Serial 不能为空或包含控制字符".into());
    }
    if !matches!(mode, "uhid" | "otg") {
        return Err("输入模式只能是 uhid 或 otg".into());
    }
    let mut args = vec![
        "-s".into(),
        serial.into(),
        "--no-window".into(),
        "--no-video".into(),
        "--no-audio".into(),
    ];
    let backend = if mode == "uhid" { "uhid" } else { "sdk" };
    if keyboard {
        args.push(format!("--keyboard={backend}"));
    }
    if mouse {
        args.push(format!("--mouse={backend}"));
    }
    if gamepad {
        args.push("--gamepad=uhid".into());
    }
    if mode == "otg" {
        args.push("--otg".into());
    }
    Ok(args)
}

pub fn default_output(mode: &str) -> String {
    let root = settings::recording_path();
    let dir = if root.trim().is_empty() {
        settings::screenshot_path()
    } else {
        root
    };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let ext = if mode == "audio" { "mka" } else { "mp4" };
    Path::new(&dir)
        .join(format!("recording-{stamp}.{ext}"))
        .to_string_lossy()
        .into()
}

pub fn start(
    serial: &str,
    mode: &str,
    output_path: &str,
    camera_facing: &str,
    camera_id: &str,
    camera_ar: &str,
    camera_high_speed: bool,
    camera_size: &str,
    camera_fps: u32,
    time_limit: u32,
    record_format: &str,
    record_orientation: &str,
    camera_torch: bool,
    camera_zoom: Option<f64>,
    gamepad: &str,
) -> RecordingSession {
    let previous_stop = stop(serial);
    if !previous_stop.success {
        return error(serial, mode, output_path, previous_stop.stderr);
    }
    let needs_output = mode != "camera" && mode != "otg";
    let output_input = if !needs_output {
        String::new()
    } else if output_path.trim().is_empty() {
        default_output(mode)
    } else {
        output_path.to_string()
    };
    let output = if needs_output {
        match validate_output(&output_input) {
            Ok(value) => value,
            Err(reason) => return error(serial, mode, output_path, reason),
        }
    } else {
        PathBuf::new()
    };
    if mode != "otg" {
        if let Err(reason) = scrcpy::ensure_device_ready(serial) {
            return error(serial, mode, &output.to_string_lossy(), reason);
        }
    }
    let mut args = match build_args(
        serial,
        mode,
        &output,
        camera_facing,
        camera_id,
        camera_ar,
        camera_high_speed,
        camera_size,
        camera_fps,
        time_limit,
        record_format,
        record_orientation,
        gamepad,
    ) {
        Ok(value) => value,
        Err(reason) => return error(serial, mode, &output.to_string_lossy(), reason),
    };
    if let Err(reason) = append_camera_args(&mut args, mode, camera_torch, camera_zoom) {
        return error(serial, mode, &output.to_string_lossy(), reason);
    }
    let bin = scrcpy::scrcpy_bin();
    let adb_path = settings::adb_path();
    let mut command = util::command(&bin);
    command
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if Path::new(&adb_path).exists() {
        command.env("ADB", &adb_path);
    }
    if let Some(parent) = Path::new(&bin).parent() {
        util::prepend_path(&mut command, parent);
    }
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(reason) => {
            return error(
                serial,
                mode,
                &output.to_string_lossy(),
                format!("启动录制失败: {reason}"),
            )
        }
    };
    thread::sleep(Duration::from_millis(700));
    match child.try_wait() {
        Ok(Some(status)) => {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read;
                let _ = pipe.read_to_string(&mut stderr);
            }
            error(
                serial,
                mode,
                &output.to_string_lossy(),
                format!(
                    "录制进程已退出 (code={:?}) {}",
                    status.code(),
                    stderr.trim()
                ),
            )
        }
        Ok(None) => {
            let session = RecordingSession {
                serial: serial.into(),
                mode: mode.into(),
                status: "running".into(),
                output_path: output.to_string_lossy().into(),
                message: "录制进行中".into(),
            };
            PROCESSES.lock().insert(
                serial.into(),
                RecordingProcess {
                    child,
                    session: session.clone(),
                },
            );
            log::info("Recording", &format!("Recording started for {serial}"));
            session
        }
        Err(reason) => error(
            serial,
            mode,
            &output.to_string_lossy(),
            format!("读取录制状态失败: {reason}"),
        ),
    }
}

/// Start a scrcpy input-only session. It shares the recording process registry
/// so the existing stop/status commands can reclaim the process reliably.
pub fn start_input(
    serial: &str,
    mode: &str,
    keyboard: bool,
    mouse: bool,
    gamepad: bool,
) -> RecordingSession {
    let previous_stop = stop(serial);
    if !previous_stop.success {
        return error(serial, mode, "", previous_stop.stderr);
    }
    if let Err(reason) = scrcpy::ensure_device_ready(serial) {
        return error(serial, mode, "", reason);
    }
    let args = match build_input_args(serial, mode, keyboard, mouse, gamepad) {
        Ok(value) => value,
        Err(reason) => return error(serial, mode, "", reason),
    };
    let bin = scrcpy::scrcpy_bin();
    let adb_path = settings::adb_path();
    let mut command = util::command(&bin);
    command
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if Path::new(&adb_path).exists() {
        command.env("ADB", &adb_path);
    }
    if let Some(parent) = Path::new(&bin).parent() {
        util::prepend_path(&mut command, parent);
    }
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(reason) => return error(serial, mode, "", format!("启动输入会话失败: {reason}")),
    };
    thread::sleep(Duration::from_millis(700));
    match child.try_wait() {
        Ok(Some(status)) => {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read;
                let _ = pipe.read_to_string(&mut stderr);
            }
            error(
                serial,
                mode,
                "",
                format!(
                    "输入会话已退出 (code={:?}) {}",
                    status.code(),
                    stderr.trim()
                ),
            )
        }
        Ok(None) => {
            let session = RecordingSession {
                serial: serial.into(),
                mode: format!("input-{mode}"),
                status: "running".into(),
                output_path: String::new(),
                message: "输入会话进行中".into(),
            };
            PROCESSES.lock().insert(
                serial.into(),
                RecordingProcess {
                    child,
                    session: session.clone(),
                },
            );
            log::info("Recording", &format!("Input session started for {serial}"));
            session
        }
        Err(reason) => error(serial, mode, "", format!("读取输入会话状态失败: {reason}")),
    }
}

pub fn stop(serial: &str) -> ShellResult {
    let mut processes = PROCESSES.lock();
    let Some(mut process) = processes.remove(serial) else {
        return ShellResult {
            success: true,
            stdout: "not running".into(),
            ..ShellResult::default()
        };
    };
    let (status, terminated_by_request) = match process.child.try_wait() {
        Ok(Some(status)) => (status, false),
        Ok(None) => {
            let _ = process.child.kill();
            match process.child.wait() {
                Ok(status) => (status, true),
                Err(reason) => {
                    processes.insert(serial.to_string(), process);
                    return ShellResult {
                        success: false,
                        stderr: format!("等待录制进程退出失败: {reason}"),
                        exit_code: -1,
                        ..ShellResult::default()
                    };
                }
            }
        }
        Err(reason) => {
            processes.insert(serial.to_string(), process);
            return ShellResult {
                success: false,
                stderr: format!("读取录制进程状态失败: {reason}"),
                exit_code: -1,
                ..ShellResult::default()
            };
        }
    };
    log::info("Recording", &format!("Recording stopped for {serial}"));
    if terminated_by_request {
        return ShellResult {
            success: true,
            stdout: process.session.output_path,
            stderr: String::new(),
            exit_code: 0,
        };
    }
    ShellResult {
        success: status.success(),
        stdout: if status.success() {
            process.session.output_path
        } else {
            String::new()
        },
        stderr: if status.success() {
            String::new()
        } else {
            format!("录制进程异常退出: {:?}", status.code())
        },
        exit_code: status.code().unwrap_or(-1),
    }
}

pub fn status(serial: &str) -> RecordingSession {
    let mut processes = PROCESSES.lock();
    let Some(mut process) = processes.remove(serial) else {
        return RecordingSession {
            serial: serial.into(),
            status: "stopped".into(),
            ..RecordingSession::default()
        };
    };
    match process.child.try_wait() {
        Ok(Some(status)) => {
            let session = RecordingSession {
                status: if status.success() {
                    "stopped".into()
                } else {
                    "error".into()
                },
                message: if status.success() {
                    "录制已完成".into()
                } else {
                    format!("录制进程退出: {:?}", status.code())
                },
                ..process.session.clone()
            };
            session
        }
        Ok(None) => {
            let session = process.session.clone();
            processes.insert(serial.to_string(), process);
            session
        }
        Err(reason) => {
            let session = RecordingSession {
                serial: serial.into(),
                status: "error".into(),
                message: reason.to_string(),
                ..process.session.clone()
            };
            // Preserve the handle so a later stop/retry can still reclaim the
            // process after a transient OS status-query failure.
            processes.insert(serial.to_string(), process);
            session
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{append_camera_args, build_args, build_input_args, output_format};
    use std::path::Path;

    #[test]
    fn video_recording_args_use_a_real_output_and_format() {
        let args = build_args(
            "emulator-5554",
            "video",
            Path::new("C:/tmp/demo.mp4"),
            "back",
            "",
            "",
            false,
            "",
            0,
            0,
            "",
            "",
            "",
        )
        .unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--record", "C:/tmp/demo.mp4"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--record-format", "mp4"]));
        assert!(args.contains(&"--no-audio".into()));
    }

    #[test]
    fn audio_and_otg_modes_are_distinct() {
        let audio = build_args(
            "device",
            "audio",
            Path::new("/tmp/a.mka"),
            "back",
            "",
            "",
            false,
            "",
            0,
            0,
            "",
            "",
            "",
        )
        .unwrap();
        let otg = build_args(
            "device",
            "otg",
            Path::new("/tmp/unused.mp4"),
            "back",
            "",
            "",
            false,
            "",
            0,
            0,
            "",
            "",
            "",
        )
        .unwrap();
        assert!(audio.contains(&"--no-video".into()));
        assert!(otg.contains(&"--otg".into()));
        let otg_gamepad = build_args(
            "device",
            "otg",
            Path::new("/tmp/unused.mp4"),
            "back",
            "",
            "",
            false,
            "",
            0,
            0,
            "",
            "",
            "uhid",
        )
        .unwrap();
        assert!(otg_gamepad.contains(&"--gamepad=uhid".into()));
        assert!(build_args(
            "device",
            "otg",
            Path::new("/tmp/unused.mp4"),
            "back",
            "",
            "",
            false,
            "",
            0,
            0,
            "",
            "",
            "sdk",
        )
        .is_err());
        assert_eq!(
            output_format("audio", Path::new("/tmp/a.mp4"), "").unwrap(),
            "mka"
        );
    }

    #[test]
    fn invalid_camera_size_is_rejected_before_spawn() {
        let result = build_args(
            "device",
            "camera",
            Path::new("/tmp/c.mp4"),
            "back",
            "",
            "",
            false,
            "1920;rm",
            30,
            0,
            "",
            "",
            "",
        );
        assert!(result.is_err());
    }

    #[test]
    fn camera_mirror_does_not_create_a_recording_file() {
        let args = build_args(
            "device",
            "camera",
            Path::new(""),
            "front",
            "1",
            "16:9",
            false,
            "1280x720",
            30,
            0,
            "",
            "",
            "",
        )
        .unwrap();
        assert!(args.contains(&"--video-source=camera".into()));
        assert!(args.contains(&"--camera-id=1".into()));
        assert!(!args.contains(&"--camera-facing=front".into()));
        assert!(!args.contains(&"--no-window".into()));
        assert!(!args.contains(&"--record".into()));
    }

    #[test]
    fn camera_torch_and_zoom_are_validated_and_scoped() {
        let mut camera = vec!["--video-source=camera".to_string()];
        append_camera_args(&mut camera, "camera-record", true, Some(2.5)).unwrap();
        assert!(camera.iter().any(|value| value == "--camera-torch"));
        assert!(camera.iter().any(|value| value == "--camera-zoom=2.5"));

        let mut screen = Vec::new();
        append_camera_args(&mut screen, "video", true, Some(2.5)).unwrap();
        assert!(screen.is_empty());
        assert!(append_camera_args(&mut screen, "camera", false, Some(101.0)).is_err());
    }

    #[test]
    fn input_modes_build_only_the_requested_injection_backends() {
        let uhid = build_input_args("device", "uhid", true, false, true).unwrap();
        assert!(uhid.contains(&"--keyboard=uhid".into()));
        assert!(!uhid.contains(&"--mouse=uhid".into()));
        assert!(!uhid.contains(&"--otg".into()));
        let otg = build_input_args("device", "otg", true, true, false).unwrap();
        assert!(otg.contains(&"--otg".into()));
        assert!(otg.contains(&"--keyboard=sdk".into()));
        assert!(otg.contains(&"--mouse=sdk".into()));
    }

    #[test]
    fn validates_explicit_format_and_record_orientation() {
        let args = build_args(
            "device",
            "video",
            Path::new("/tmp/c.mp4"),
            "back",
            "",
            "",
            false,
            "",
            30,
            0,
            "mkv",
            "90",
            "",
        )
        .unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--record-format", "mkv"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--record-orientation", "90"]));
        assert!(build_args(
            "device",
            "video",
            Path::new("/tmp/c.mp4"),
            "back",
            "",
            "",
            false,
            "",
            30,
            0,
            "flac",
            "",
            ""
        )
        .is_err());
        assert!(build_args(
            "device",
            "video",
            Path::new("/tmp/c.mp4"),
            "back",
            "",
            "",
            false,
            "",
            30,
            0,
            "mp4",
            "45",
            ""
        )
        .is_err());
    }
}
