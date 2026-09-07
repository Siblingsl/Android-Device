use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::models::ShellResult;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(6);

pub fn run_command(program: &str, args: &[&str]) -> ShellResult {
    run_command_timeout(program, args, DEFAULT_TIMEOUT)
}

static RUNTIME_PROXY: once_cell::sync::Lazy<parking_lot::Mutex<String>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(String::new()));

pub fn set_runtime_proxy(proxy: &str) {
    *RUNTIME_PROXY.lock() = proxy.trim().to_string();
}

fn apply_proxy(cmd: &mut Command) {
    let proxy = RUNTIME_PROXY.lock().clone();
    if proxy.is_empty() {
        return;
    }
    cmd.env("HTTP_PROXY", &proxy);
    cmd.env("HTTPS_PROXY", &proxy);
    cmd.env("ALL_PROXY", &proxy);
    cmd.env("http_proxy", &proxy);
    cmd.env("https_proxy", &proxy);
}

/// Run a command and return raw stdout bytes (binary-safe — unlike
/// run_command_timeout, which is lossy-UTF8 and trimmed).
pub fn run_command_bytes(program: &str, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_proxy(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {program} failed: {e}"))?;
    let child_id = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let out = child.wait_with_output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output.stdout),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            kill_process(child_id);
            Err(format!("command timeout after {}s: {program} {args:?}", timeout.as_secs()))
        }
    }
}

/// Run a command, feed `input` to its stdin, return the normal ShellResult.
/// Used to push binary blobs (sqlite db files) into containers — `docker cp`
/// fails on the read-only overlay, so the pattern is
/// `docker exec -i sh -c 'cat > path'` with the bytes on stdin.
pub fn run_command_stdin(
    program: &str,
    args: &[&str],
    input: &[u8],
    timeout: Duration,
) -> ShellResult {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_proxy(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: -1,
            };
        }
    };
    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        let write_result = stdin.write_all(input).and_then(|_| stdin.flush());
        // drop stdin so the child sees EOF even if write partially failed
        drop(stdin);
        if let Err(e) = write_result {
            kill_process(child.id());
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("write stdin failed: {e}"),
                exit_code: -1,
            };
        }
    }
    let child_id = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => ShellResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        },
        Ok(Err(e)) => ShellResult {
            success: false,
            stdout: String::new(),
            stderr: e.to_string(),
            exit_code: -1,
        },
        Err(_) => {
            kill_process(child_id);
            ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("command timeout after {}s: {program} {args:?}", timeout.as_secs()),
                exit_code: -1,
            }
        }
    }
}

pub fn run_command_timeout(program: &str, args: &[&str], timeout: Duration) -> ShellResult {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_proxy(&mut cmd);
    let child = match cmd.spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: -1,
            };
        }
    };

    let (tx, rx) = mpsc::channel();
    let child_id = child.id();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => ShellResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        },
        Ok(Err(e)) => ShellResult {
            success: false,
            stdout: String::new(),
            stderr: e.to_string(),
            exit_code: -1,
        },
        Err(_) => {
            // Kill hung process tree best-effort (Windows + Unix)
            kill_process(child_id);
            ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!(
                    "command timeout after {}s: {} {:?}",
                    timeout.as_secs(),
                    program,
                    args
                ),
                exit_code: -1,
            }
        }
    }
}

fn kill_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn run_shell(cmd: &str) -> ShellResult {
    #[cfg(target_os = "windows")]
    {
        run_command("cmd", &["/C", cmd])
    }
    #[cfg(not(target_os = "windows"))]
    {
        run_command("sh", &["-c", cmd])
    }
}

pub fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn ensure_dir(path: &str) {
    let _ = std::fs::create_dir_all(path);
}

pub fn parse_size_bytes(s: &str) -> u64 {
    let s = s.trim().to_uppercase();
    if s.is_empty() {
        return 0;
    }
    let (num, unit) = if s.ends_with("KIB") || s.ends_with("KB") {
        let n = s.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
        (n.parse::<f64>().unwrap_or(0.0), 1024.0)
    } else if s.ends_with("MIB") || s.ends_with("MB") {
        let n = s.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
        (n.parse::<f64>().unwrap_or(0.0), 1024.0 * 1024.0)
    } else if s.ends_with("GIB") || s.ends_with("GB") {
        let n = s.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
        (n.parse::<f64>().unwrap_or(0.0), 1024.0 * 1024.0 * 1024.0)
    } else {
        (s.parse::<f64>().unwrap_or(0.0), 1.0)
    };
    (num * unit) as u64
}
