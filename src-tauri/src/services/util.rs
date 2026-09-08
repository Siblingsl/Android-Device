use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
    Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

#[derive(Debug)]
pub enum CancellableCommandResult {
    Completed(ShellResult),
    Cancelled(ShellResult),
    TimedOut(ShellResult),
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    is_stderr: bool,
    sender: mpsc::Sender<(bool, String)>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if sender
                        .send((is_stderr, String::from_utf8_lossy(&buffer[..size]).into()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

fn record_output(
    receiver: &mpsc::Receiver<(bool, String)>,
    stdout: &mut String,
    stderr: &mut String,
    callback: &Arc<dyn Fn(String) + Send + Sync>,
) {
    while let Ok((is_stderr, chunk)) = receiver.try_recv() {
        if is_stderr {
            stderr.push_str(&chunk);
        } else {
            stdout.push_str(&chunk);
        }
        callback(chunk);
    }
}

fn record_remaining_output(
    receiver: &mpsc::Receiver<(bool, String)>,
    stdout: &mut String,
    stderr: &mut String,
    callback: &Arc<dyn Fn(String) + Send + Sync>,
) {
    while let Ok((is_stderr, chunk)) = receiver.recv() {
        if is_stderr {
            stderr.push_str(&chunk);
        } else {
            stdout.push_str(&chunk);
        }
        callback(chunk);
    }
}

pub fn run_command_cancellable(
    program: &str,
    args: &[&str],
    timeout: Duration,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> CancellableCommandResult {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_proxy(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return CancellableCommandResult::Completed(ShellResult {
                success: false,
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: -1,
            })
        }
    };

    let child_id = child.id();
    let (sender, receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, false, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, true, sender.clone());
    }
    drop(sender);

    let callback: Arc<dyn Fn(String) + Send + Sync> = Arc::new(on_output);
    let started = Instant::now();
    let mut stdout = String::new();
    let mut stderr = String::new();

    loop {
        record_output(&receiver, &mut stdout, &mut stderr, &callback);

        if cancel.load(Ordering::SeqCst) {
            kill_process(child_id);
            let _ = child.wait();
            record_remaining_output(&receiver, &mut stdout, &mut stderr, &callback);
            if stderr.trim().is_empty() {
                stderr = "command cancelled".into();
            }
            return CancellableCommandResult::Cancelled(ShellResult {
                success: false,
                stdout: stdout.trim().into(),
                stderr: stderr.trim().into(),
                exit_code: -1,
            });
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                record_remaining_output(&receiver, &mut stdout, &mut stderr, &callback);
                return CancellableCommandResult::Completed(ShellResult {
                    success: status.success(),
                    stdout: stdout.trim().into(),
                    stderr: stderr.trim().into(),
                    exit_code: status.code().unwrap_or(-1),
                });
            }
            Ok(None) => {}
            Err(e) => {
                kill_process(child_id);
                let _ = child.wait();
                record_remaining_output(&receiver, &mut stdout, &mut stderr, &callback);
                return CancellableCommandResult::Completed(ShellResult {
                    success: false,
                    stdout: stdout.trim().into(),
                    stderr: e.to_string(),
                    exit_code: -1,
                });
            }
        }

        if started.elapsed() >= timeout {
            kill_process(child_id);
            let _ = child.wait();
            record_remaining_output(&receiver, &mut stdout, &mut stderr, &callback);
            if stderr.trim().is_empty() {
                stderr = format!("command timeout after {}s: {program} {args:?}", timeout.as_secs());
            }
            return CancellableCommandResult::TimedOut(ShellResult {
                success: false,
                stdout: stdout.trim().into(),
                stderr: stderr.trim().into(),
                exit_code: -1,
            });
        }

        thread::sleep(Duration::from_millis(20));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellable_runner_reports_success_for_immediate_command() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        #[cfg(windows)]
        let (program, args) = ("cmd", vec!["/C", "exit", "0"]);
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c", "exit 0"]);
        let refs: Vec<&str> = args.iter().copied().collect();
        let result =
            run_command_cancellable(program, &refs, Duration::from_secs(2), &cancel, |_| {});
        assert!(matches!(result, CancellableCommandResult::Completed(r) if r.success));
    }

    #[test]
    fn cancellable_runner_reports_cancelled_and_stops_long_command() {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(windows)]
        let (program, args) = ("cmd", vec!["/C", "ping -n 30 127.0.0.1 > nul"]);
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c", "sleep 30"]);
        let refs: Vec<&str> = args.iter().copied().collect();
        let cancel_for_worker = cancel.clone();
        let worker = std::thread::spawn(move || {
            run_command_cancellable(
                program,
                &refs,
                Duration::from_secs(20),
                &cancel_for_worker,
                |_| {},
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        let result = worker.join().unwrap();
        assert!(matches!(result, CancellableCommandResult::Cancelled(_)));
    }
}
