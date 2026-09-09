use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use uuid::Uuid;

use crate::services::adb;

pub const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartRequest {
    pub kind: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub shell: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub kind: String,
    pub data: String,
    pub status: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandResult {
    pub success: bool,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

struct TerminalEntry {
    info: TerminalSessionInfo,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Default)]
pub struct TerminalRegistry {
    entries: Arc<Mutex<HashMap<String, TerminalEntry>>>,
    stopped: Arc<Mutex<HashSet<String>>>,
}

pub fn validate_request(request: &TerminalStartRequest) -> Result<(), String> {
    match request.kind.trim() {
        "device" if request.serial.trim().is_empty() => Err("device serial is required".into()),
        "device" => Ok(()),
        "local" if matches!(request.shell.trim(), "powershell" | "cmd") => Ok(()),
        "local" => Err("local shell must be powershell or cmd".into()),
        _ => Err("terminal kind must be device or local".into()),
    }
}

pub fn local_command(shell: &str) -> Result<CommandSpec, String> {
    match shell.trim() {
        "powershell" => {
            #[cfg(windows)]
            let program = "powershell.exe";
            #[cfg(not(windows))]
            let program = "pwsh";
            Ok(CommandSpec {
                program: program.into(),
                args: vec!["-NoLogo".into(), "-NoProfile".into()],
            })
        }
        "cmd" => {
            #[cfg(windows)]
            let program = "cmd.exe";
            #[cfg(not(windows))]
            let program = "sh";
            #[cfg(windows)]
            let args = vec!["/Q".into()];
            #[cfg(not(windows))]
            let args = Vec::new();
            Ok(CommandSpec {
                program: program.into(),
                args,
            })
        }
        _ => Err("local shell must be powershell or cmd".into()),
    }
}

fn command_for_request(
    request: &TerminalStartRequest,
) -> Result<(CommandSpec, String, String), String> {
    validate_request(request)?;
    match request.kind.trim() {
        "device" => {
            let serial = request.serial.trim().to_string();
            Ok((
                CommandSpec {
                    program: adb::adb_bin(),
                    args: vec!["-s".into(), serial.clone(), "shell".into()],
                },
                "device".into(),
                format!("ADB Shell · {serial}"),
            ))
        }
        "local" => {
            let shell = request.shell.trim().to_string();
            Ok((
                local_command(&shell)?,
                "local".into(),
                match shell.as_str() {
                    "powershell" => "PowerShell".into(),
                    _ => "CMD".into(),
                },
            ))
        }
        _ => Err("terminal kind must be device or local".into()),
    }
}

fn command_builder(spec: &CommandSpec) -> CommandBuilder {
    let mut builder = CommandBuilder::new(&spec.program);
    builder.args(&spec.args);
    builder
}

pub fn start(
    app: tauri::AppHandle,
    registry: TerminalRegistry,
    request: TerminalStartRequest,
) -> Result<TerminalSessionInfo, String> {
    let (spec, kind, title) = command_for_request(&request)?;
    let id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to create terminal: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command_builder(&spec))
        .map_err(|error| format!("failed to start terminal: {error}"))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("failed to open terminal output: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("failed to open terminal input: {error}"));
        }
    };
    let killer = child.clone_killer();
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let info = TerminalSessionInfo {
        id: id.clone(),
        kind,
        title,
        status: "running".into(),
    };
    registry.entries.lock().insert(
        id.clone(),
        TerminalEntry {
            info: info.clone(),
            writer: Arc::new(Mutex::new(writer)),
            killer: Arc::new(Mutex::new(killer)),
            stopped: stopped.clone(),
        },
    );
    spawn_reader(app, registry, id, reader, child, stopped);
    Ok(info)
}

fn spawn_reader(
    app: tauri::AppHandle,
    registry: TerminalRegistry,
    id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut read_error = None;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => emit_output(
                    &app,
                    &id,
                    "stdout",
                    String::from_utf8_lossy(&buffer[..size]).into_owned(),
                    None,
                    None,
                ),
                Err(error) => {
                    read_error = Some(error.to_string());
                    break;
                }
            }
        }
        let exit = child.wait();
        let status = if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            "stopped"
        } else if read_error.is_some() || exit.is_err() {
            "failed"
        } else {
            "exited"
        };
        let data = read_error.unwrap_or_default();
        let exit_code = exit.ok().map(|value| value.exit_code() as i32);
        emit_output(&app, &id, "exit", data, Some(status), exit_code);
        registry.entries.lock().remove(&id);
    });
}

fn emit_output(
    app: &tauri::AppHandle,
    session_id: &str,
    kind: &str,
    data: String,
    status: Option<&str>,
    exit_code: Option<i32>,
) {
    let _ = app.emit(
        TERMINAL_OUTPUT_EVENT,
        TerminalOutputEvent {
            session_id: session_id.into(),
            kind: kind.into(),
            data,
            status: status.map(str::to_string),
            exit_code,
        },
    );
}

pub fn write(registry: &TerminalRegistry, id: &str, data: &str) -> TerminalCommandResult {
    let writer = match registry.entries.lock().get(id) {
        Some(entry) => entry.writer.clone(),
        None => {
            return TerminalCommandResult {
                success: false,
                error: "terminal session not found".into(),
            };
        }
    };
    let mut writer = writer.lock();
    match writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
    {
        Ok(()) => TerminalCommandResult {
            success: true,
            error: String::new(),
        },
        Err(error) => TerminalCommandResult {
            success: false,
            error: error.to_string(),
        },
    }
}

pub fn stop(registry: &TerminalRegistry, id: &str) -> TerminalCommandResult {
    let entry = registry.entries.lock().remove(id);
    let Some(entry) = entry else {
        if registry.stopped.lock().contains(id) {
            return TerminalCommandResult {
                success: true,
                error: String::new(),
            };
        }
        return TerminalCommandResult {
            success: false,
            error: "terminal session not found".into(),
        };
    };
    entry
        .stopped
        .store(true, std::sync::atomic::Ordering::SeqCst);
    registry.stopped.lock().insert(id.into());
    let kill_result = entry.killer.lock().kill();
    match kill_result {
        Ok(()) => TerminalCommandResult {
            success: true,
            error: String::new(),
        },
        Err(error) => TerminalCommandResult {
            success: false,
            error: error.to_string(),
        },
    }
}

pub fn list(registry: &TerminalRegistry) -> Vec<TerminalSessionInfo> {
    registry
        .entries
        .lock()
        .values()
        .map(|entry| entry.info.clone())
        .collect()
}

pub fn stop_all(registry: &TerminalRegistry) {
    let ids: Vec<String> = registry.entries.lock().keys().cloned().collect();
    for id in ids {
        let _ = stop(registry, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_device_serial() {
        let request = TerminalStartRequest {
            kind: "device".into(),
            serial: "  ".into(),
            shell: String::new(),
        };
        assert_eq!(
            validate_request(&request),
            Err("device serial is required".into())
        );
    }

    #[test]
    fn accepts_only_supported_local_shells() {
        let powershell = local_command("powershell").unwrap();
        #[cfg(windows)]
        assert_eq!(powershell.program, "powershell.exe");
        #[cfg(not(windows))]
        assert_eq!(powershell.program, "pwsh");
        assert!(local_command("bash").is_err());
    }

    #[test]
    fn rejects_unknown_session_ids_without_mutating_the_registry() {
        let registry = TerminalRegistry::default();
        let result = write(&registry, "missing", "echo\r");
        assert!(!result.success);
        assert_eq!(list(&registry).len(), 0);
    }
}
