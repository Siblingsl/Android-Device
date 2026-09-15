//! Process execution helpers (std-only).
//!
//! Every *runtime* action in this crate funnels through [`run_command`]: the
//! pure command-assembly functions decide the argv, this module runs it with a
//! timeout and captures output. Two Windows-specific details are handled here
//! so the rest of the crate stays platform-neutral:
//!
//! * `CREATE_NO_WINDOW` — the CLI is often driven from a GUI/host process and
//!   must not flash console windows.
//! * [`spawn_detached`] (QEMU on Windows) — `DETACHED_PROCESS |
//!   CREATE_NEW_PROCESS_GROUP` plus redirected stdio, the Windows substitute
//!   for POSIX `-daemonize` (see [`crate::vm::Detach`]). A detached child
//!   outlives the CLI, so its stdio policy ([`detached_stdio_redirection`]) and
//!   the inherit flag of *our own* std handles both matter — see the Bug B note
//!   on [`NoInheritStdio`].

use std::io;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::ffi::c_void;

/// Result of a captured run.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub exit_code: i32,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl RunOutcome {
    /// A synthetic outcome for a command that could not even be spawned
    /// (binary missing): treated as a failure with the OS error as stderr.
    pub fn spawn_failure(err: impl std::fmt::Display) -> Self {
        Self {
            exit_code: -1,
            success: false,
            stdout: String::new(),
            stderr: format!("spawn failed: {err}"),
            timed_out: false,
        }
    }

    /// Last non-empty stderr line, for compact one-line diagnostics.
    pub fn stderr_last_line(&self) -> String {
        self.stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string()
    }
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// Run `argv` (program first) and capture stdout/stderr, killing it after
/// `timeout` (polled `try_wait`; std has no wait-with-timeout).
pub fn run_command(argv: &[String], timeout: Duration) -> RunOutcome {
    let Some((program, args)) = argv.split_first() else {
        return RunOutcome::spawn_failure("empty argv");
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunOutcome::spawn_failure(e),
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let out = child.wait_with_output().ok();
                    return RunOutcome {
                        exit_code: -1,
                        success: false,
                        stdout: out
                            .as_ref()
                            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                            .unwrap_or_default(),
                        stderr: out
                            .as_ref()
                            .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
                            .unwrap_or_default(),
                        timed_out: true,
                    };
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return RunOutcome::spawn_failure(e),
        }
    }

    match child.wait_with_output() {
        Ok(out) => {
            let code = out.status.code().unwrap_or(-1);
            RunOutcome {
                exit_code: code,
                success: out.status.success(),
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
                timed_out: false,
            }
        }
        Err(e) => RunOutcome::spawn_failure(e),
    }
}

// ------------------------------------------------- detached stdio policy ----

/// Where one stream of a detached child is pointed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachedSink {
    /// The OS null device (`NUL` / `/dev/null`); output is discarded.
    Null,
    /// Append to the log file handed to [`spawn_detached`] (a VM's `qemu.log`).
    LogFile,
    /// Copy this process's own handle into the child. **Never legal for a
    /// detached child** — see [`detached_stdio_redirection`]; the variant exists
    /// only so the policy can be asserted against it.
    Inherit,
}

/// The stdio policy of a detached child (stdin, stdout, stderr).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetachedStdio {
    pub stdin: DetachedSink,
    pub stdout: DetachedSink,
    pub stderr: DetachedSink,
}

impl DetachedStdio {
    /// The three sinks, in stdin/stdout/stderr order.
    pub fn streams(self) -> [DetachedSink; 3] {
        [self.stdin, self.stdout, self.stderr]
    }

    /// No stream copies a handle from this process. The invariant behind Bug B.
    pub fn inherits_nothing(self) -> bool {
        !self.streams().contains(&DetachedSink::Inherit)
    }
}

/// Pure: the only legal stdio policy for a detached child.
///
/// A detached child outlives the CLI by design (QEMU keeps running after
/// `vm start` returns), so it must not hold any copy of the CLI's stdio. The
/// write end of the caller's pipe is the one that hurts: while the child lives,
/// a caller reading the CLI to EOF — `qemu-center vm start node1 | Select-Object
/// -Last 2`, or the Tauri bridge's `run_cli` — never sees EOF and reports
/// `vm timed out after 90s` although the VM started fine (real-machine Bug B).
///
/// `has_log` = a log file could be opened: stdout and stderr then land in
/// `vms/<name>/qemu.log`, which is worth far more than `/dev/null` when a VM
/// fails to boot. Either way neither stream is inherited, and stdin is the null
/// device (nobody is at a detached VM's keyboard).
pub fn detached_stdio_redirection(has_log: bool) -> DetachedStdio {
    let out = if has_log {
        DetachedSink::LogFile
    } else {
        DetachedSink::Null
    };
    DetachedStdio {
        stdin: DetachedSink::Null,
        stdout: out,
        stderr: out,
    }
}

/// Bridge from the policy to `Command`. `Inherit` is refused outright, so no
/// future caller can reintroduce Bug B through the policy type.
fn detached_stdio_for(sink: DetachedSink, log: Option<&std::fs::File>) -> io::Result<Stdio> {
    Ok(match sink {
        DetachedSink::Null => Stdio::null(),
        DetachedSink::LogFile => match log {
            Some(f) => Stdio::from(f.try_clone()?),
            None => Stdio::null(), // defensive: a missing log never means inherit
        },
        DetachedSink::Inherit => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to let a detached child inherit this process's stdio",
            ))
        }
    })
}

/// Open (create + append) a detached child's log file. `None` means the child's
/// output is nulled instead: logging must never block a VM start, and it must
/// never fall back to inheriting our stdio.
fn open_append_log(path: &Path) -> Option<std::fs::File> {
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!(
                "warning: cannot open {} for the detached child's output: {e} (output discarded)",
                path.display()
            );
            None
        }
    }
}

/// Windows: makes this process's three standard handles non-inheritable for as
/// long as the guard lives, then restores the original flags.
///
/// **Bug B, measured on a real machine** (`QEMU 11.1`, WHPX): the CLI exited in
/// ~80 ms, yet `qemu-center vm start node1 | Select-Object -Last 2` never
/// returned, and the Tauri bridge's `run_cli` — which reads the child to EOF —
/// reported `vm timed out after 90s`. Killing QEMU released the pipe instantly,
/// so the detached QEMU was holding a write end of the caller's stdout/stderr.
///
/// Why redirecting the child's stdio is not enough: std's Windows spawn calls
/// `CreateProcessW(..., bInheritHandles = TRUE, ...)`, so *every* inheritable
/// handle of this process is copied into the child, and a pipe handed to us by
/// PowerShell/.NET is inheritable. `Stdio::null()` / `Stdio::from(file)` only
/// decide the child's *standard* handles; the leaked copy of the caller's pipe
/// stays open in the child until it exits. Clearing `HANDLE_FLAG_INHERIT` on our
/// own std handles for the duration of the spawn closes that hole (measured:
/// EOF at ~68 ms with the child still alive, rather than never).
///
/// Single-threaded-CLI assumption: the flags are restored on drop, and nothing
/// else in this process spawns children concurrently (see `run_command`, which
/// sets all three of its child's streams explicitly).
#[cfg(windows)]
struct NoInheritStdio {
    saved: Vec<(*mut c_void, u32)>,
}

#[cfg(windows)]
mod kernel32 {
    use std::ffi::c_void;

    pub const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    pub const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    pub const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    pub const HANDLE_FLAG_INHERIT: u32 = 1;

    // Raw kernel32 FFI: the alternative (`windows-sys`) would break this
    // crate's zero-dependency red line for three functions.
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetStdHandle(std_handle: u32) -> *mut c_void;
        pub fn GetHandleInformation(object: *mut c_void, flags: *mut u32) -> i32;
        pub fn SetHandleInformation(object: *mut c_void, mask: u32, flags: u32) -> i32;
    }
}

#[cfg(windows)]
impl NoInheritStdio {
    fn install() -> Self {
        use kernel32::*;
        let mut saved = Vec::new();
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let h = unsafe { GetStdHandle(id) };
            if h.is_null() || h as isize == -1 {
                continue; // no such standard handle (normal under DETACHED_PROCESS)
            }
            let mut flags: u32 = 0;
            if unsafe { GetHandleInformation(h, &mut flags) } == 0 {
                continue;
            }
            if flags & HANDLE_FLAG_INHERIT == 0 {
                continue; // already safe (e.g. a console handle)
            }
            if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) } != 0 {
                saved.push((h, flags));
            }
        }
        Self { saved }
    }
}

#[cfg(windows)]
impl Drop for NoInheritStdio {
    fn drop(&mut self) {
        use kernel32::*;
        for (h, flags) in self.saved.drain(..) {
            unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, flags & HANDLE_FLAG_INHERIT) };
        }
    }
}

/// Spawn `argv` fully detached (no console, own process group) and return the
/// child PID after a short startup check. Immediate exits return an error with
/// this launch's log output. `log`: append stdout/stderr there (the
/// VM's `qemu.log`); `None` discards them. Neither option ever inherits this
/// process's stdio ([`detached_stdio_redirection`]).
///
/// This is how `vm start` launches QEMU on Windows, where QEMU's POSIX-only
/// `-daemonize` cannot be used. On Unix the CLI uses `-daemonize` instead
/// (QEMU's `daemon(0, 0)` closes its inherited stdio), so this function is only
/// reached there by callers that ask for it; the `Handle`-level guard below is
/// Windows-only because POSIX handle inheritance would need `libc`.
pub fn spawn_detached(argv: &[String], log: Option<&Path>) -> io::Result<u32> {
    let Some((program, args)) = argv.split_first() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty argv"));
    };
    let log_file = log.and_then(open_append_log);
    let log_offset = log_file
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let plan = detached_stdio_redirection(log_file.is_some());
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(detached_stdio_for(plan.stdin, log_file.as_ref())?)
        .stdout(detached_stdio_for(plan.stdout, log_file.as_ref())?)
        .stderr(detached_stdio_for(plan.stderr, log_file.as_ref())?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    // Keep the caller's pipe out of the child (Bug B). Held only across the
    // spawn, so the rest of the CLI is unaffected.
    let mut child = {
        #[cfg(windows)]
        let _no_inherit = NoInheritStdio::install();
        cmd.spawn()?
    };
    let deadline = Instant::now() + Duration::from_millis(750);
    loop {
        if let Some(status) = child.try_wait()? {
            let output = log
                .and_then(|path| {
                    use std::io::{Read, Seek, SeekFrom};
                    let mut file = std::fs::File::open(path).ok()?;
                    let start =
                        log_offset.max(file.metadata().ok()?.len().saturating_sub(16 * 1024));
                    file.seek(SeekFrom::Start(start)).ok()?;
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes).ok()?;
                    Some(String::from_utf8_lossy(&bytes).trim().to_string())
                })
                .unwrap_or_default();
            return Err(io::Error::other(format!(
                "process exited during startup ({status}){}",
                if output.is_empty() {
                    String::new()
                } else {
                    format!(": {output}")
                }
            )));
        }
        if Instant::now() >= deadline {
            return Ok(child.id());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Human-readable rendering of an argv for logs / `--dry-run` output, with
/// quoting only where needed (so copy-paste into a shell mostly works).
pub fn argv_to_display(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if a.is_empty() || a.contains(' ') || a.contains('"') {
                format!("\"{}\"", a.replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cheap "is this command on PATH?" probe used by `setup qemu` channel
/// selection (winget / scoop / choco presence). The command is resolved by the
/// OS; a missing binary simply reports failure after the spawn error.
pub fn where_exists(exe: &str) -> bool {
    let argv = ["where".to_string(), exe.to_string()];
    run_command(&argv, Duration::from_secs(10)).success
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    /// Marks the helper mode of [`detached_spawn_helper_process`].
    const HELPER_ENV: &str = "QC_TEST_DETACHED_HELPER";
    /// Log file the helper points its detached child at.
    const HELPER_LOG: &str = "qemu-center-detached-stdio-test.log";

    #[test]
    fn detached_spawn_reports_immediate_exit_and_current_error() {
        let log = std::env::temp_dir().join(format!(
            "qc-start-failure-{}.log",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&log, "stale error from a previous launch\n").unwrap();
        let argv: Vec<String> = if cfg!(windows) {
            vec![
                "cmd".into(),
                "/C".into(),
                "echo QC_STARTUP_FAILED 1>&2 & exit /b 7".into(),
            ]
        } else {
            vec![
                "sh".into(),
                "-c".into(),
                "echo QC_STARTUP_FAILED >&2; exit 7".into(),
            ]
        };
        let result = spawn_detached(&argv, Some(&log));
        std::fs::remove_file(&log).unwrap();
        let error = result
            .expect_err("an immediately exiting child must not be reported as started")
            .to_string();
        assert!(error.contains("7"), "{error}");
        assert!(error.contains("QC_STARTUP_FAILED"), "{error}");
        assert!(!error.contains("stale error"), "{error}");
    }

    /// The long-lived child the helper detaches; stands in for QEMU. `ping` is
    /// deliberate: it is a plain console program that keeps the handles it
    /// inherits (unlike, e.g., PowerShell, which drops them — which is why a
    /// PowerShell stand-in does not reproduce Bug B). It runs ~24 s and prints
    /// the target address, which makes the log assertion locale-independent.
    fn long_running_detached_child() -> Vec<String> {
        if cfg!(windows) {
            vec!["ping".into(), "-n".into(), "25".into(), "127.0.0.1".into()]
        } else {
            vec!["sleep".into(), "25".into()]
        }
    }

    #[test]
    fn detached_stdio_policy_never_inherits() {
        for has_log in [false, true] {
            let plan = detached_stdio_redirection(has_log);
            assert!(plan.inherits_nothing(), "{plan:?} must not inherit stdio");
            assert_eq!(plan.stdin, DetachedSink::Null, "no keyboard behind a VM");
            assert_eq!(plan.streams().len(), 3);
            let want = if has_log {
                DetachedSink::LogFile
            } else {
                DetachedSink::Null
            };
            assert_eq!(plan.stdout, want);
            assert_eq!(plan.stderr, want);
        }
        // The only bridge to `Command` refuses an inherited stream outright.
        assert!(detached_stdio_for(DetachedSink::Inherit, None).is_err());
        // A log sink without an open file degrades to null, never to inherit.
        assert!(matches!(
            detached_stdio_for(DetachedSink::LogFile, None),
            Ok(_) if detached_stdio_redirection(false).inherits_nothing()
        ));
        assert!(detached_stdio_for(DetachedSink::Null, None).is_ok());
    }

    #[test]
    fn unopenable_log_falls_back_to_discarding_output() {
        // A directory is not openable as an append-mode file: the policy must
        // degrade to Null instead of letting the spawn fail.
        let dir = std::env::temp_dir();
        let log_file = open_append_log(&dir);
        assert!(log_file.is_none());
        let plan = detached_stdio_redirection(log_file.is_some());
        assert!(plan.inherits_nothing());
        assert_eq!(plan.stdout, DetachedSink::Null);
    }

    /// Helper process for [`detached_child_releases_the_callers_stdout`]; a
    /// no-op in a normal `cargo test` run. When armed by the env var it plays
    /// the CLI: detach a long-lived child, report its PID, exit immediately.
    #[test]
    fn detached_spawn_helper_process() {
        if std::env::var_os(HELPER_ENV).is_none() {
            return;
        }
        let log = std::env::temp_dir().join(HELPER_LOG);
        let _ = std::fs::remove_file(&log);
        let pid =
            spawn_detached(&long_running_detached_child(), Some(&log)).expect("spawn detached");
        let mut out = io::stdout();
        let _ = writeln!(out, "detached-pid {pid}");
        let _ = out.flush();
        // Leave at once, exactly like `vm start` does after launching QEMU.
        std::process::exit(0);
    }

    /// End-to-end model of the failing caller (Bug B): run this test binary as
    /// the "CLI" with *piped* stdout, let it detach a long-lived child (QEMU),
    /// and read the pipe to EOF the way `vm start | Select-Object -Last 2` and
    /// the Tauri bridge's `run_cli` do. If the detached child inherited the
    /// pipe's write end, EOF only arrives when the child dies — the caller then
    /// blocks until its timeout ("vm timed out after 90s", although the VM is up
    /// and fine). Verified to fail without the [`NoInheritStdio`] guard.
    #[cfg(windows)]
    #[test]
    fn detached_child_releases_the_callers_stdout() {
        let exe = std::env::current_exe().expect("test binary path");
        let mut cmd = Command::new(exe);
        cmd.args([
            "--exact",
            "exec::tests::detached_spawn_helper_process",
            "--nocapture",
        ])
        .env(HELPER_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        let mut helper = cmd.spawn().expect("spawn helper");
        let mut pipe = helper.stdout.take().expect("piped stdout");

        let start = Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut s = String::new();
            let ok = pipe.read_to_string(&mut s).is_ok();
            let _ = tx.send((start.elapsed(), ok, s));
        });
        let (eof_after, read_ok, captured) = rx.recv_timeout(Duration::from_secs(10)).expect(
            "caller never saw EOF: the detached child is holding our stdout pipe open (Bug B)",
        );
        assert!(read_ok, "reading the helper's stdout failed");
        assert!(
            eof_after < Duration::from_secs(10),
            "EOF took {eof_after:?} — the caller would have timed out"
        );
        // The detached child's own output must go to the log, not to us.
        assert!(
            !captured.contains("127.0.0.1"),
            "detached child wrote to the caller's stdout: {captured:?}"
        );
        let pid: u32 = captured
            .lines()
            .find_map(|l| l.strip_prefix("detached-pid "))
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or_else(|| panic!("helper printed no PID: {captured:?}"));
        assert!(helper.wait().expect("wait helper").success());

        // The detached child is still running while we already have EOF — that
        // is the whole fix: it holds no copy of the caller's pipe.
        let alive = run_command(
            &["tasklist".into(), "/FI".into(), format!("PID eq {pid}")],
            Duration::from_secs(15),
        );
        assert!(
            alive.stdout.contains(&pid.to_string()),
            "detached child {pid} is gone, so this run proves nothing: {}",
            alive.stdout
        );

        // Its stdout went to the log file (poll: the child needs a moment).
        let log = std::env::temp_dir().join(HELPER_LOG);
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut logged = String::new();
        while Instant::now() < deadline {
            logged = std::fs::read_to_string(&log).unwrap_or_default();
            if logged.contains("127.0.0.1") {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = run_command(
            &[
                "taskkill".into(),
                "/PID".into(),
                pid.to_string(),
                "/F".into(),
                "/T".into(),
            ],
            Duration::from_secs(15),
        );
        let _ = std::fs::remove_file(&log);
        assert!(
            logged.contains("127.0.0.1"),
            "the detached child's stdout did not reach the log file: {logged:?}"
        );
    }

    #[test]
    fn spawn_failure_reports_stderr_and_last_line() {
        let o = RunOutcome::spawn_failure("not found");
        assert!(!o.success);
        assert_eq!(o.exit_code, -1);
        assert!(o.stderr.contains("not found"));
        assert_eq!(o.stderr_last_line(), "spawn failed: not found");
    }

    #[test]
    fn empty_argv_is_a_spawn_failure_not_a_panic() {
        let o = run_command(&[], Duration::from_millis(50));
        assert!(!o.success);
        assert!(o.stderr.contains("empty argv"));
        assert!(spawn_detached(&[], None).is_err());
    }

    #[test]
    fn argv_display_quotes_only_when_needed() {
        let argv = vec![
            "ssh".to_string(),
            "-p".to_string(),
            "22300".to_string(),
            "rdc@127.0.0.1".to_string(),
            "docker ps -a".to_string(),
        ];
        assert_eq!(
            argv_to_display(&argv),
            "ssh -p 22300 rdc@127.0.0.1 \"docker ps -a\""
        );
        assert_eq!(argv_to_display(&["a\"b".to_string()]), "\"a\\\"b\"");
    }

    #[test]
    fn missing_binary_is_captured_not_propagated() {
        let o = run_command(
            &["qemu-center-definitely-not-a-real-binary-xyz".to_string()],
            Duration::from_millis(200),
        );
        assert!(!o.success);
        assert!(o.stderr.contains("spawn failed"));
    }

    #[test]
    fn timeout_is_flagged() {
        // A sleep long enough to blow the 100 ms budget on any platform.
        let argv: Vec<String> = if cfg!(windows) {
            vec![
                "powershell".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 5".into(),
            ]
        } else {
            vec!["sleep".into(), "5".into()]
        };
        let o = run_command(&argv, Duration::from_millis(100));
        assert!(o.timed_out, "expected timeout, got {o:?}");
        assert!(!o.success);
    }
}
