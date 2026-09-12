use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
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

pub fn prepend_path(cmd: &mut Command, directory: &Path) {
    let mut paths = vec![directory.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

/// Resolve a configured tool name in the environment used by a packaged GUI.
/// macOS apps launched from Finder do not always inherit the shell PATH, so
/// Homebrew and the Android SDK need a small, deterministic fallback search.
pub fn resolve_program(program: &str) -> String {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return trimmed.into();
    }
    if trimmed.contains('/') || trimmed.contains('\\') || Path::new(trimmed).is_file() {
        return trimmed.into();
    }

    #[cfg(target_os = "windows")]
    if trimmed.eq_ignore_ascii_case("gnirehtet") {
        if let Some(path) = bundled_gnirehtet_path() {
            return path.to_string_lossy().into_owned();
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin").join(trimmed),
            PathBuf::from("/usr/local/bin").join(trimmed),
            PathBuf::from("/usr/bin").join(trimmed),
            PathBuf::from("/bin").join(trimmed),
        ];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin").join(trimmed));
        }
        if trimmed == "docker" {
            candidates.push(
                PathBuf::from("/Applications/Docker.app/Contents/Resources/bin").join(trimmed),
            );
        }
        if trimmed == "adb" {
            if let Some(home) = dirs::home_dir() {
                candidates.push(home.join("Library/Android/sdk/platform-tools/adb"));
            }
        }
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return path.to_string_lossy().into_owned();
        }
    }

    trimmed.into()
}

#[cfg(target_os = "windows")]
fn bundled_gnirehtet_path() -> Option<PathBuf> {
    let relatives = [
        Path::new("gnirehtet")
            .join("windows-x64")
            .join("gnirehtet.exe"),
        Path::new("vendor")
            .join("gnirehtet")
            .join("windows-x64")
            .join("gnirehtet.exe"),
    ];
    let mut roots = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("resources"));
            roots.push(parent.to_path_buf());
        }
    }

    // `cargo tauri dev` and Rust tests run from the source checkout. Release
    // builds use the resource directory next to the packaged executable.
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    roots
        .into_iter()
        .flat_map(|root| relatives.iter().map(move |relative| root.join(relative)))
        .find(|path| path.is_file())
}

/// Create a command with the same tool discovery rules as the probe and
/// command runners. Direct child processes (scrcpy/ffmpeg) use this helper so
/// a GUI-launched macOS app can also find Homebrew-installed dependencies.
#[allow(unused_mut)]
pub fn command(program: &str) -> Command {
    let resolved = resolve_program(program);
    let mut cmd = Command::new(&resolved);
    #[cfg(target_os = "macos")]
    {
        let mut directories = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];
        if let Some(home) = dirs::home_dir() {
            directories.push(home.join("Library/Android/sdk/platform-tools"));
            directories.push(home.join(".local/bin"));
        }
        if let Some(existing) = std::env::var_os("PATH") {
            directories.extend(std::env::split_paths(&existing));
        }
        if let Ok(path) = std::env::join_paths(directories) {
            cmd.env("PATH", path);
        }
    }
    cmd
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
pub fn run_command_bytes(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut cmd = command(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    apply_proxy(&mut cmd);
    let child = cmd
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
            Err(format!(
                "command timeout after {}s: {program} {args:?}",
                timeout.as_secs()
            ))
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
    let mut cmd = command(program);
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
                stderr: format!(
                    "command timeout after {}s: {program} {args:?}",
                    timeout.as_secs()
                ),
                exit_code: -1,
            }
        }
    }
}

pub fn run_command_timeout(program: &str, args: &[&str], timeout: Duration) -> ShellResult {
    run_command_timeout_with_dir(program, args, timeout, None)
}

pub fn run_command_timeout_in_dir(
    program: &str,
    args: &[&str],
    timeout: Duration,
    working_dir: &Path,
) -> ShellResult {
    run_command_timeout_with_dir(program, args, timeout, Some(working_dir))
}

fn run_command_timeout_with_dir(
    program: &str,
    args: &[&str],
    timeout: Duration,
    working_dir: Option<&Path>,
) -> ShellResult {
    let mut cmd = command(program);
    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_proxy(&mut cmd);
    let child = match cmd.spawn() {
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

#[cfg(test)]
mod tests {
    use super::resolve_program;
    #[cfg(target_os = "windows")]
    use std::path::Path;

    #[test]
    fn keeps_explicit_tool_paths_and_empty_values() {
        assert_eq!(resolve_program(""), "");
        assert_eq!(
            resolve_program("C:/Android/platform-tools/adb"),
            "C:/Android/platform-tools/adb"
        );
        assert_eq!(resolve_program("./tools/adb"), "./tools/adb");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_the_bundled_gnirehtet_runtime() {
        let resolved = resolve_program("gnirehtet");
        assert!(Path::new(&resolved).is_file(), "resolved path: {resolved}");
        assert!(resolved.to_ascii_lowercase().ends_with("gnirehtet.exe"));
    }
}
