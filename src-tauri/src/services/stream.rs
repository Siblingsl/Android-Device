use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use crate::models::{ShellResult, StreamSession};
use crate::services::{scrcpy, settings, util};

struct StreamProcess {
    scrcpy: Child,
    ffmpeg: Child,
    stop: Arc<AtomicBool>,
    port: u16,
}

fn terminate_child(child: &mut Child, name: &str) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            if let Err(error) = child.kill() {
                return match child.try_wait() {
                    Ok(Some(_)) => Ok(()),
                    Ok(None) => Err(format!("终止 {name} 失败: {error}")),
                    Err(status_error) => Err(format!(
                        "终止 {name} 失败: {error}; 读取退出状态失败: {status_error}"
                    )),
                };
            }
            child
                .wait()
                .map(|_| ())
                .map_err(|error| format!("等待 {name} 退出失败: {error}"))
        }
        Err(error) => Err(format!("读取 {name} 状态失败: {error}")),
    }
}

fn terminate_process(process: &mut StreamProcess) -> Result<(), String> {
    process.stop.store(true, Ordering::Relaxed);
    let mut errors = Vec::new();
    if let Err(error) = terminate_child(&mut process.scrcpy, "scrcpy") {
        errors.push(error);
    }
    if let Err(error) = terminate_child(&mut process.ffmpeg, "ffmpeg") {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

static STREAMS: Lazy<Mutex<HashMap<String, StreamProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const FORBIDDEN_FLAGS: [&str; 13] = [
    "-s",
    "--serial",
    "--record",
    "-r",
    "--record-format",
    "--raw-video-stream",
    "--no-window",
    "--window-title",
    "--max-size",
    "-m",
    "--video-bit-rate",
    "-b",
    "--audio",
];

fn is_forbidden_flag(token: &str) -> bool {
    FORBIDDEN_FLAGS
        .iter()
        .any(|flag| token == *flag || token.starts_with(&format!("{}=", flag)))
}

pub fn build_scrcpy_args(
    serial: &str,
    max_size: u32,
    bit_rate: u32,
    extra: &str,
) -> Result<Vec<String>, String> {
    if serial.trim().is_empty() || serial.chars().any(|c| c.is_control()) {
        return Err("ADB Serial 不能为空或包含控制字符".into());
    }
    if max_size == 0 || bit_rate == 0 {
        return Err("投屏分辨率和码率必须大于 0".into());
    }
    if extra.contains(['&', '|', ';', '`', '\r', '\n']) {
        return Err("Scrcpy 参数包含不允许的 shell 字符".into());
    }

    let mut args = vec![
        "-s".into(),
        serial.into(),
        "--no-window".into(),
        "--record=-".into(),
        "--record-format=mkv".into(),
        "--no-audio".into(),
        "--max-size".into(),
        max_size.to_string(),
        "--video-bit-rate".into(),
        format!("{}M", bit_rate),
    ];

    for token in extra.split_whitespace() {
        if is_forbidden_flag(token) || !token.starts_with('-') {
            return Err(format!("参数不允许覆盖内嵌投屏控制项: {}", token));
        }
        args.push(token.to_string());
    }
    Ok(args)
}

fn stream_error(serial: &str, message: impl Into<String>) -> StreamSession {
    StreamSession {
        serial: serial.into(),
        status: "error".into(),
        url: String::new(),
        port: 0,
        message: message.into(),
    }
}

fn ffmpeg_bin() -> &'static str {
    "ffmpeg"
}

fn start_http_server(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<Option<TcpStream>>>,
) {
    let _ = listener.set_nonblocking(true);
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nodelay(true);
                    let headers = concat!(
                        "HTTP/1.1 200 OK\r\n",
                        "Cache-Control: no-cache, no-store, must-revalidate\r\n",
                        "Pragma: no-cache\r\n",
                        "Connection: close\r\n",
                        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n",
                        "\r\n",
                    );
                    if stream.write_all(headers.as_bytes()).is_ok() {
                        *clients.lock() = Some(stream);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => break,
            }
        }
    });
}

fn serve_mjpeg(
    mut output: impl Read + Send + 'static,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<Option<TcpStream>>>,
) {
    thread::spawn(move || {
        let mut buffer = Vec::with_capacity(512 * 1024);
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let read = match output.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(size) => size,
            };
            buffer.extend_from_slice(&chunk[..read]);
            loop {
                let Some(start) = buffer.windows(2).position(|pair| pair == [0xff, 0xd8]) else {
                    if buffer.len() > 2 * 1024 * 1024 {
                        buffer.drain(..buffer.len() - 2);
                    }
                    break;
                };
                let Some(end_offset) = buffer[start + 2..]
                    .windows(2)
                    .position(|pair| pair == [0xff, 0xd9])
                else {
                    if start > 0 {
                        buffer.drain(..start);
                    }
                    break;
                };
                let end = start + 2 + end_offset + 2;
                let jpeg = buffer[start..end].to_vec();
                buffer.drain(..end);
                let header = format!(
                    "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    jpeg.len()
                );
                let mut guard = clients.lock();
                if let Some(client) = guard.as_mut() {
                    if client.write_all(header.as_bytes()).is_err()
                        || client.write_all(&jpeg).is_err()
                        || client.write_all(b"\r\n").is_err()
                    {
                        *guard = None;
                    }
                }
            }
        }
    });
}

pub fn start(serial: &str, max_size: u32, bit_rate: u32, extra: &str) -> StreamSession {
    let previous_stop = stop(serial);
    if !previous_stop.success {
        return stream_error(
            serial,
            format!("无法停止旧投屏会话: {}", previous_stop.stderr),
        );
    }
    if let Err(error) = scrcpy::ensure_device_ready(serial) {
        return stream_error(serial, error);
    }
    let args = match build_scrcpy_args(serial, max_size, bit_rate, extra) {
        Ok(args) => args,
        Err(error) => return stream_error(serial, error),
    };
    let bin = scrcpy::scrcpy_bin();
    let adb_path = settings::adb_path();
    let mut scrcpy_cmd = util::command(&bin);
    if std::path::Path::new(&adb_path).exists() {
        scrcpy_cmd.env("ADB", adb_path);
    }
    if let Some(parent) = std::path::Path::new(&bin).parent() {
        util::prepend_path(&mut scrcpy_cmd, parent);
    }
    let mut scrcpy_child = match scrcpy_cmd
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return stream_error(serial, format!("无法启动 scrcpy: {}", error)),
    };
    let Some(scrcpy_output) = scrcpy_child.stdout.take() else {
        let _ = scrcpy_child.kill();
        return stream_error(serial, "无法读取 scrcpy 视频输出");
    };

    let mut ffmpeg_child = match util::command(ffmpeg_bin())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-f",
            "matroska",
            "-i",
            "pipe:0",
            "-an",
            "-f",
            "mjpeg",
            "-q:v",
            "5",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = scrcpy_child.kill();
            return stream_error(
                serial,
                format!("找不到 ffmpeg，无法显示内嵌投屏: {}", error),
            );
        }
    };

    // Do not report a running stream when either process has already exited
    // during startup (for example, an unsupported scrcpy option or an
    // unavailable encoder). The status poll will catch later exits, but the
    // initial result must also be truthful.
    thread::sleep(Duration::from_millis(400));
    let scrcpy_state = scrcpy_child.try_wait();
    let ffmpeg_state = ffmpeg_child.try_wait();
    let startup_error = match (scrcpy_state, ffmpeg_state) {
        (Ok(Some(status)), _) => Some(format!("scrcpy 启动后退出 (code={:?})", status.code())),
        (_, Ok(Some(status))) => Some(format!("ffmpeg 启动后退出 (code={:?})", status.code())),
        (Err(error), _) => Some(format!("读取 scrcpy 启动状态失败: {error}")),
        (_, Err(error)) => Some(format!("读取 ffmpeg 启动状态失败: {error}")),
        _ => None,
    };
    if let Some(message) = startup_error {
        let _ = scrcpy_child.kill();
        let _ = ffmpeg_child.kill();
        let _ = scrcpy_child.wait();
        let _ = ffmpeg_child.wait();
        return stream_error(serial, message);
    }

    let Some(mut ffmpeg_input) = ffmpeg_child.stdin.take() else {
        let _ = scrcpy_child.kill();
        let _ = ffmpeg_child.kill();
        return stream_error(serial, "无法连接 ffmpeg 输入管道");
    };
    let Some(ffmpeg_output) = ffmpeg_child.stdout.take() else {
        let _ = scrcpy_child.kill();
        let _ = ffmpeg_child.kill();
        return stream_error(serial, "无法读取 ffmpeg 视频输出");
    };

    let (listener, address) = match TcpListener::bind("127.0.0.1:0").and_then(|listener| {
        let address = listener.local_addr()?;
        Ok((listener, address))
    }) {
        Ok(value) => value,
        Err(error) => {
            let _ = scrcpy_child.kill();
            let _ = ffmpeg_child.kill();
            return stream_error(serial, format!("无法创建本地投屏通道: {}", error));
        }
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let clients = Arc::new(Mutex::new(None));
    let input_stop = Arc::clone(&stop_flag);
    thread::spawn(move || {
        let mut output = scrcpy_output;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if input_stop.load(Ordering::Relaxed) {
                break;
            }
            match output.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if ffmpeg_input.write_all(&buffer[..size]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ffmpeg_input.flush();
    });
    start_http_server(listener, Arc::clone(&stop_flag), Arc::clone(&clients));
    serve_mjpeg(ffmpeg_output, Arc::clone(&stop_flag), clients);

    let port = address.port();
    STREAMS.lock().insert(
        serial.to_string(),
        StreamProcess {
            scrcpy: scrcpy_child,
            ffmpeg: ffmpeg_child,
            stop: stop_flag,
            port,
        },
    );
    StreamSession {
        serial: serial.into(),
        status: "running".into(),
        url: format!("http://127.0.0.1:{}/stream", port),
        port,
        message: "内嵌投屏已启动".into(),
    }
}

pub fn stop(serial: &str) -> ShellResult {
    let mut streams = STREAMS.lock();
    if let Some(mut process) = streams.remove(serial) {
        return match terminate_process(&mut process) {
            Ok(()) => ShellResult {
                success: true,
                stdout: "stream stopped".into(),
                stderr: String::new(),
                exit_code: 0,
            },
            Err(error) => {
                streams.insert(serial.to_string(), process);
                ShellResult {
                    success: false,
                    stdout: String::new(),
                    stderr: error,
                    exit_code: -1,
                }
            }
        };
    }
    ShellResult {
        success: true,
        stdout: "stream not running".into(),
        stderr: String::new(),
        exit_code: 0,
    }
}

pub fn status(serial: &str) -> StreamSession {
    let mut streams = STREAMS.lock();
    let Some(process) = streams.get_mut(serial) else {
        return StreamSession {
            serial: serial.into(),
            status: "stopped".into(),
            ..StreamSession::default()
        };
    };
    let scrcpy_alive = process
        .scrcpy
        .try_wait()
        .map(|result| result.is_none())
        .unwrap_or(false);
    let ffmpeg_alive = process
        .ffmpeg
        .try_wait()
        .map(|result| result.is_none())
        .unwrap_or(false);
    if !scrcpy_alive || !ffmpeg_alive {
        if let Some(mut process) = streams.remove(serial) {
            if terminate_process(&mut process).is_err() {
                streams.insert(serial.to_string(), process);
            }
        }
        return StreamSession {
            serial: serial.into(),
            status: "error".into(),
            message: "投屏进程已退出".into(),
            ..StreamSession::default()
        };
    }
    StreamSession {
        serial: serial.into(),
        status: "running".into(),
        port: process.port,
        url: format!("http://127.0.0.1:{}/stream", process.port),
        message: "内嵌投屏运行中".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_scrcpy_args;

    #[test]
    fn builds_a_windowless_stream_recording_command() {
        let args = build_scrcpy_args("emulator-5554", 1080, 8, "--stay-awake")
            .expect("valid stream options");

        assert_eq!(
            &args[0..2],
            &["-s".to_string(), "emulator-5554".to_string()]
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--no-window", "--record=-"]));
        assert!(args.contains(&"--record-format=mkv".to_string()));
        assert!(args.windows(2).any(|pair| pair == ["--max-size", "1080"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--video-bit-rate", "8M"]));
        assert!(args.contains(&"--stay-awake".to_string()));
    }

    #[test]
    fn rejects_shell_and_stream_override_arguments() {
        let result = build_scrcpy_args(
            "emulator-5554",
            1080,
            8,
            "--record C:\\temp\\evil --no-window --raw-video-stream=stdout;whoami",
        );

        assert!(result.is_err());
    }
}
