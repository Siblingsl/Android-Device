use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use uuid::Uuid;

use crate::models::{ShellResult, TerminalSession};
use crate::services::{settings, util};

struct TerminalProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<String>>,
    kind: String,
    serial: String,
    cols: u16,
    rows: u16,
}

static SESSIONS: Lazy<Mutex<HashMap<String, TerminalProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn terminal_command(kind: &str, serial: &str) -> (String, Vec<String>) {
    if kind == "device" {
        return (
            settings::adb_path(),
            vec!["-s".into(), serial.into(), "shell".into(), "-t".into()],
        );
    }
    #[cfg(windows)]
    {
        return (
            "powershell".into(),
            vec!["-NoLogo".into(), "-NoProfile".into()],
        );
    }
    #[cfg(not(windows))]
    {
        ("bash".into(), Vec::new())
    }
}

fn failed(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: false,
        stderr: message.into(),
        exit_code: -1,
        ..ShellResult::default()
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    output: Arc<Mutex<String>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let text = String::from_utf8_lossy(&buffer[..size]);
                    // PowerShell/ConPTY asks for the current cursor position
                    // during startup. Answering it keeps interactive prompts
                    // from waiting forever, while hiding the control query
                    // from the visible terminal buffer.
                    if text.contains("\x1b[6n") {
                        let mut writer = writer.lock();
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    output.lock().push_str(&text.replace("\x1b[6n", ""));
                }
            }
        }
    });
}

pub fn start(kind: &str, serial: &str) -> TerminalSession {
    if !matches!(kind, "device" | "local") {
        return TerminalSession {
            status: "error".into(),
            message: "终端类型不受支持".into(),
            ..TerminalSession::default()
        };
    }
    if kind == "device" && serial.trim().is_empty() {
        return TerminalSession {
            status: "error".into(),
            message: "设备 Serial 不能为空".into(),
            ..TerminalSession::default()
        };
    }

    let (binary, args) = terminal_command(kind, serial);
    let binary = util::resolve_program(&binary);
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            return TerminalSession {
                status: "error".into(),
                message: format!("创建终端 PTY 失败: {error}"),
                ..TerminalSession::default()
            };
        }
    };

    let mut command = CommandBuilder::new(&binary);
    command.args(args);
    #[cfg(windows)]
    if kind == "local" {
        // A Unix-style TERM=dumb inherited from a host automation shell makes
        // Windows PowerShell/ConPTY stop in its VT initialization sequence.
        // The local Windows shell does not need that variable.
        command.env_remove("TERM");
    }
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            return TerminalSession {
                status: "error".into(),
                message: format!("启动终端失败: {error}"),
                ..TerminalSession::default()
            };
        }
    };
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return TerminalSession {
                status: "error".into(),
                message: format!("终端输出管道不可用: {error}"),
                ..TerminalSession::default()
            };
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return TerminalSession {
                status: "error".into(),
                message: format!("终端输入管道不可用: {error}"),
                ..TerminalSession::default()
            };
        }
    };

    let output = Arc::new(Mutex::new(String::new()));
    let writer = Arc::new(Mutex::new(writer));
    spawn_reader(reader, Arc::clone(&output), Arc::clone(&writer));
    let id = Uuid::new_v4().to_string();
    SESSIONS.lock().insert(
        id.clone(),
        TerminalProcess {
            child,
            master: pair.master,
            writer,
            output,
            kind: kind.into(),
            serial: serial.into(),
            cols: 120,
            rows: 32,
        },
    );
    TerminalSession {
        id,
        kind: kind.into(),
        serial: serial.into(),
        status: "running".into(),
        message: "终端 PTY 已启动".into(),
        ..TerminalSession::default()
    }
}

pub fn write(id: &str, input: &str) -> ShellResult {
    let mut sessions = SESSIONS.lock();
    let Some(session) = sessions.get_mut(id) else {
        return failed("终端会话不存在");
    };
    let mut writer = session.writer.lock();
    if let Err(error) = writer.write_all(input.as_bytes()) {
        return failed(format!("终端写入失败: {error}"));
    }
    if let Err(error) = writer.flush() {
        return failed(format!("终端刷新失败: {error}"));
    }
    ShellResult {
        success: true,
        stdout: "written".into(),
        ..ShellResult::default()
    }
}

pub fn read(id: &str) -> TerminalSession {
    let mut sessions = SESSIONS.lock();
    let Some(session) = sessions.get_mut(id) else {
        return TerminalSession {
            id: id.into(),
            status: "stopped".into(),
            message: "终端会话不存在".into(),
            ..TerminalSession::default()
        };
    };
    let (status, message) = match session.child.try_wait() {
        Ok(Some(_)) => ("stopped".to_string(), String::new()),
        Ok(None) => ("running".to_string(), String::new()),
        Err(error) => ("error".to_string(), format!("读取终端状态失败: {error}")),
    };
    let chunk = std::mem::take(&mut *session.output.lock());
    let result = TerminalSession {
        id: id.into(),
        kind: session.kind.clone(),
        serial: session.serial.clone(),
        status: status.clone(),
        output: chunk,
        cols: session.cols,
        rows: session.rows,
        message,
    };
    if status == "stopped" {
        sessions.remove(id);
    }
    result
}

pub fn resize(id: &str, cols: u16, rows: u16) -> ShellResult {
    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
        return failed("终端尺寸超出范围");
    }
    let mut sessions = SESSIONS.lock();
    let Some(session) = sessions.get_mut(id) else {
        return failed("终端会话不存在");
    };
    if let Err(error) = session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        return failed(format!("终端调整大小失败: {error}"));
    }
    session.cols = cols;
    session.rows = rows;
    ShellResult {
        success: true,
        stdout: "resized".into(),
        ..ShellResult::default()
    }
}

pub fn stop(id: &str) -> ShellResult {
    let mut sessions = SESSIONS.lock();
    let Some(mut session) = sessions.remove(id) else {
        return failed("终端会话不存在");
    };
    let (status, terminated_by_request) = match session.child.try_wait() {
        Ok(Some(status)) => (status, false),
        Ok(None) => {
            let _ = session.child.kill();
            match session.child.wait() {
                Ok(status) => (status, true),
                Err(reason) => {
                    sessions.insert(id.to_string(), session);
                    return failed(format!("等待终端退出失败: {reason}"));
                }
            }
        }
        Err(reason) => {
            sessions.insert(id.to_string(), session);
            return failed(format!("读取终端状态失败: {reason}"));
        }
    };
    if !terminated_by_request {
        return ShellResult {
            success: status.success(),
            stdout: if status.success() {
                "terminal stopped".into()
            } else {
                String::new()
            },
            stderr: if status.success() {
                String::new()
            } else {
                format!("终端进程异常退出: code={}", status.exit_code())
            },
            exit_code: status.exit_code() as i32,
        };
    }
    ShellResult {
        success: true,
        stdout: "terminal stopped".into(),
        stderr: String::new(),
        exit_code: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::{read, resize, start, stop, terminal_command, write};

    #[test]
    fn builds_a_device_shell_command_with_the_configured_adb_binary() {
        let (binary, args) = terminal_command("device", "emulator-5554");
        assert_eq!(binary, "adb");
        assert_eq!(args, vec!["-s", "emulator-5554", "shell", "-t"]);
    }

    #[test]
    fn uses_a_local_shell_without_injecting_the_device_serial() {
        let (binary, args) = terminal_command("local", "ignored");
        assert!(binary == "powershell" || binary == "bash");
        assert!(args.iter().all(|arg| !arg.contains("ignored")));
    }

    #[test]
    fn local_pty_round_trips_input_and_cleans_up() {
        let session = start("local", "");
        assert_eq!(session.status, "running");
        let mut output = String::new();
        if cfg!(windows) {
            // ConPTY/PowerShell emits its terminal initialization before it
            // begins consuming interactive input. Drain that startup window
            // so this round-trip test matches the UI's ready-to-type state.
            for _ in 0..40 {
                let chunk = read(&session.id);
                output.push_str(&chunk.output);
                if !chunk.output.is_empty() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        let command = if cfg!(windows) {
            "Write-Output rdc-pty-ok\r"
        } else {
            "printf 'rdc-pty-ok\\n'\n"
        };
        assert!(write(&session.id, command).success);
        assert!(resize(&session.id, 100, 30).success);

        for _ in 0..40 {
            let chunk = read(&session.id);
            output.push_str(&chunk.output);
            if output.contains("rdc-pty-ok") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(output.contains("rdc-pty-ok"), "PTY output: {output:?}");
        assert!(stop(&session.id).success);
        assert_eq!(read(&session.id).status, "stopped");
    }
}
