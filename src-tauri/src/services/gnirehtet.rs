use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::models::{GnirehtetSession, ShellResult};
use crate::services::{log, settings, util};

struct TunnelProcess {
    child: Child,
    session: GnirehtetSession,
    output: Arc<Mutex<String>>,
}

static PROCESSES: Lazy<Mutex<HashMap<String, TunnelProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn failed(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: false,
        stderr: message.into(),
        exit_code: -1,
        ..ShellResult::default()
    }
}

fn binary() -> String {
    let configured = settings::gnirehtet_path();
    let configured = if configured.trim().is_empty() {
        "gnirehtet"
    } else {
        configured.as_str()
    };
    util::resolve_program(configured)
}

fn binary_dir(bin: &str) -> Option<&Path> {
    let parent = Path::new(bin).parent()?;
    (!parent.as_os_str().is_empty()).then_some(parent)
}

fn command_args(
    action: &str,
    serial: &str,
    dns: &str,
    relay_port: u16,
    routes: &str,
) -> Result<Vec<String>, String> {
    if serial.trim().is_empty() && action != "relay" {
        return Err("设备 Serial 不能为空".into());
    }
    if !matches!(action, "install" | "start" | "stop" | "run" | "relay") {
        return Err("不支持的 Gnirehtet 操作".into());
    }
    let mut args = vec![action.into()];
    if !serial.trim().is_empty() {
        args.push(serial.into());
    }
    if action == "run" {
        if !dns.trim().is_empty() {
            if !dns
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == '.' || ch == ',' || ch == ':')
            {
                return Err("DNS 参数包含非法字符".into());
            }
            args.extend(["-d".into(), dns.trim().into()]);
        }
        if relay_port > 0 {
            args.extend(["-p".into(), relay_port.to_string()]);
        }
        if !routes.trim().is_empty() {
            if !routes
                .chars()
                .all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '/' | ',' | ':'))
            {
                return Err("路由参数包含非法字符".into());
            }
            args.extend(["-r".into(), routes.trim().into()]);
        }
    }
    Ok(args)
}

fn run_action(action: &str, serial: &str) -> ShellResult {
    let args = match command_args(action, serial, "", 0, "") {
        Ok(value) => value,
        Err(reason) => return failed(reason),
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let bin = binary();
    if let Some(dir) = binary_dir(&bin) {
        util::run_command_timeout_in_dir(&bin, &refs, Duration::from_secs(20), dir)
    } else {
        util::run_command_timeout(&bin, &refs, Duration::from_secs(20))
    }
}

fn merge_remote_stop_result(mut local: ShellResult, remote: ShellResult) -> ShellResult {
    if !remote.success {
        let detail = [remote.stderr.trim(), remote.stdout.trim()]
            .into_iter()
            .find(|item| !item.is_empty())
            .unwrap_or("远端供网停止失败");
        local.success = false;
        local.stderr = detail.to_string();
        local.stdout.clear();
    }
    local
}

pub fn install(serial: &str) -> ShellResult {
    run_action("install", serial)
}

pub fn start(serial: &str, dns: &str, relay_port: u16, routes: &str) -> GnirehtetSession {
    let has_local_process = PROCESSES.lock().contains_key(serial);
    if has_local_process {
        let previous = stop(serial);
        if !previous.success {
            let detail = [previous.stderr.trim(), previous.stdout.trim()]
                .into_iter()
                .find(|item| !item.is_empty())
                .unwrap_or("上一个 Gnirehtet 进程未能停止");
            return GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: format!("无法重启 Gnirehtet：{detail}"),
                ..GnirehtetSession::default()
            };
        }
    }
    let args = match command_args("run", serial, dns, relay_port, routes) {
        Ok(value) => value,
        Err(reason) => {
            return GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: reason,
                ..GnirehtetSession::default()
            }
        }
    };
    let bin = binary();
    if bin != "gnirehtet" && !Path::new(&bin).exists() {
        return GnirehtetSession {
            serial: serial.into(),
            status: "error".into(),
            message: format!("找不到 Gnirehtet: {bin}"),
            ..GnirehtetSession::default()
        };
    }
    let mut command = util::command(&bin);
    if let Some(dir) = binary_dir(&bin) {
        command.current_dir(dir);
    }
    command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(reason) => {
            return GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: format!("启动 Gnirehtet 失败: {reason}"),
                ..GnirehtetSession::default()
            }
        }
    };
    let output = Arc::new(Mutex::new(String::new()));
    if let Some(mut pipe) = child.stdout.take() {
        let output = Arc::clone(&output);
        std::thread::spawn(move || {
            let mut value = String::new();
            let _ = pipe.read_to_string(&mut value);
            if !value.trim().is_empty() {
                output.lock().push_str(value.trim());
            }
        });
    }
    if let Some(mut pipe) = child.stderr.take() {
        let output = Arc::clone(&output);
        std::thread::spawn(move || {
            let mut value = String::new();
            let _ = pipe.read_to_string(&mut value);
            if !value.trim().is_empty() {
                let mut guard = output.lock();
                if !guard.is_empty() {
                    guard.push('\n');
                }
                guard.push_str(value.trim());
            }
        });
    }
    thread::sleep(Duration::from_millis(500));
    match child.try_wait() {
        Ok(Some(exit)) => {
            // Give the reader threads a short window to publish the actual
            // process message before returning the startup failure.
            thread::sleep(Duration::from_millis(50));
            let detail = output.lock().trim().to_string();
            return GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: if detail.is_empty() {
                    format!("Gnirehtet 启动后退出: {:?}", exit.code())
                } else {
                    detail
                },
                relay: format!(
                    "127.0.0.1:{}",
                    if relay_port == 0 { 31416 } else { relay_port }
                ),
                installed: true,
            };
        }
        Err(reason) => {
            let _ = child.kill();
            let _ = child.wait();
            return GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: format!("读取 Gnirehtet 启动状态失败: {reason}"),
                ..GnirehtetSession::default()
            };
        }
        Ok(None) => {}
    }
    let session = GnirehtetSession {
        serial: serial.into(),
        status: "running".into(),
        message: "反向供网进行中".into(),
        relay: format!(
            "127.0.0.1:{}",
            if relay_port == 0 { 31416 } else { relay_port }
        ),
        installed: true,
    };
    PROCESSES.lock().insert(
        serial.into(),
        TunnelProcess {
            child,
            session: session.clone(),
            output,
        },
    );
    log::info("Gnirehtet", &format!("Tunnel started for {serial}"));
    session
}

pub fn stop(serial: &str) -> ShellResult {
    let mut processes = PROCESSES.lock();
    let process = processes.remove(serial);
    let result = if let Some(mut tunnel) = process {
        match tunnel.child.try_wait() {
            Ok(Some(status)) => ShellResult {
                success: status.success(),
                stdout: if status.success() {
                    "供网进程已停止".into()
                } else {
                    String::new()
                },
                stderr: if status.success() {
                    String::new()
                } else {
                    format!("供网进程异常退出: {:?}", status.code())
                },
                exit_code: status.code().unwrap_or(-1),
            },
            Ok(None) => {
                let _ = tunnel.child.kill();
                match tunnel.child.wait() {
                    Ok(_) => ShellResult {
                        success: true,
                        stdout: "供网进程已停止".into(),
                        ..ShellResult::default()
                    },
                    Err(reason) => {
                        processes.insert(serial.to_string(), tunnel);
                        ShellResult {
                            success: false,
                            stderr: format!("等待供网进程退出失败: {reason}"),
                            exit_code: -1,
                            ..ShellResult::default()
                        }
                    }
                }
            }
            Err(reason) => {
                processes.insert(serial.to_string(), tunnel);
                ShellResult {
                    success: false,
                    stderr: format!("读取供网进程状态失败: {reason}"),
                    exit_code: -1,
                    ..ShellResult::default()
                }
            }
        }
    } else {
        ShellResult {
            success: true,
            stdout: "供网进程未运行".into(),
            ..ShellResult::default()
        }
    };
    drop(processes);
    merge_remote_stop_result(result, run_action("stop", serial))
}

pub fn status(serial: &str) -> GnirehtetSession {
    let mut processes = PROCESSES.lock();
    let Some(mut process) = processes.remove(serial) else {
        return GnirehtetSession {
            serial: serial.into(),
            status: "stopped".into(),
            ..GnirehtetSession::default()
        };
    };
    match process.child.try_wait() {
        Ok(None) => {
            let session = process.session.clone();
            processes.insert(serial.into(), process);
            session
        }
        Ok(Some(exit)) => {
            let detail = process.output.lock().trim().to_string();
            GnirehtetSession {
                status: if exit.success() {
                    "stopped".into()
                } else {
                    "error".into()
                },
                message: if !detail.is_empty() {
                    detail
                } else if exit.success() {
                    "供网已停止".into()
                } else {
                    format!("供网进程退出: {:?}", exit.code())
                },
                ..process.session
            }
        }
        Err(reason) => {
            let session = GnirehtetSession {
                serial: serial.into(),
                status: "error".into(),
                message: reason.to_string(),
                ..process.session.clone()
            };
            // Do not lose ownership of a potentially live process just because
            // this status read failed.
            processes.insert(serial.to_string(), process);
            session
        }
    }
}

pub fn repair(serial: &str, dns: &str, relay_port: u16, routes: &str) -> GnirehtetSession {
    let install_result = install(serial);
    if !install_result.success {
        return GnirehtetSession {
            serial: serial.into(),
            status: "error".into(),
            message: install_result.stderr,
            ..GnirehtetSession::default()
        };
    }
    start(serial, dns, relay_port, routes)
}

pub fn batch_command(action: &str, serials: &[String]) -> Vec<(String, ShellResult)> {
    serials
        .iter()
        .map(|serial| (serial.clone(), run_action(action, serial)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{command_args, merge_remote_stop_result};
    use crate::models::ShellResult;

    #[test]
    fn builds_safe_run_args() {
        let args = command_args(
            "run",
            "emulator-5554",
            "1.1.1.1,8.8.8.8",
            31416,
            "10.0.0.0/8",
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "run",
                "emulator-5554",
                "-d",
                "1.1.1.1,8.8.8.8",
                "-p",
                "31416",
                "-r",
                "10.0.0.0/8"
            ]
        );
    }

    #[test]
    fn rejects_injection_in_network_options() {
        assert!(command_args("run", "device", "1.1.1.1;whoami", 0, "").is_err());
        assert!(command_args("run", "device", "", 0, "0.0.0.0/0|whoami").is_err());
    }

    #[test]
    fn remote_stop_failure_is_not_reported_as_success() {
        let result = merge_remote_stop_result(
            ShellResult {
                success: true,
                stdout: "供网进程已停止".into(),
                ..ShellResult::default()
            },
            ShellResult {
                success: false,
                stderr: "adb disconnected".into(),
                ..ShellResult::default()
            },
        );
        assert!(!result.success);
        assert_eq!(result.stderr, "adb disconnected");
        assert!(result.stdout.is_empty());
    }
}
