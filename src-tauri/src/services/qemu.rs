//! Bridge to the standalone `qemu-center` CLI (the QEMU/WHPX track).
//!
//! This is a pure-addition service: it spawns the `qemu-center` binary as a
//! subprocess and parses its `--json` output. It imports nothing from
//! `docker.rs` and nothing from the `qemu-center` crate itself — the CLI's
//! JSON contract (documented in `qemu-center/README.md`) is the only interface.
//! The single shared dependency is `adb.rs` (the host ADB channel): QEMU
//! redroid instances are reached over the very same adb serials as Docker
//! instances, which is what makes the unified device list work without the
//! rest of the app caring where a serial came from.
//!
//! Honest status split (mirrors qemu-center's README):
//! - ✅ **unit-tested pure functions**: binary resolution priority, argv
//!   assembly per subcommand, `--json` parsing, default cloud-image path,
//!   the portable `--state-dir` pin (`<repo>/qemu-center/state` on every
//!   invocation — nothing lands in %APPDATA% / C:\Program Files).
//! - ⚠️ **runtime-unverified in this environment**: every actual subprocess
//!   spawn (`run_cli`) — no WHPX-capable host / built binary here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::services::adb;

/// Upper bound for one CLI invocation (setup all / image download / DISM).
/// `guest wait` derives its own budget from the caller's timeout.
pub const MAX_CLI_TIMEOUT_SECS: u64 = 60 * 60;

/// Ubuntu cloud image used when the UI does not pass an explicit path.
pub const DEFAULT_IMAGE_DISTRO: &str = "noble";

#[cfg(windows)]
const BIN_FILE_NAME: &str = "qemu-center.exe";
#[cfg(not(windows))]
const BIN_FILE_NAME: &str = "qemu-center";

// ------------------------------------------------------------------- models ---

/// Raw CLI result for the human-readable passthrough commands
/// (setup / vm create / guest wait / redroid create).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QemuCliOutput {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuDoctorCheck {
    pub id: String,
    pub title: String,
    /// "ok" | "fail" | "unknown" (CLI serializes the enum lowercase).
    pub status: String,
    pub detail: String,
    pub fix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuDoctorReport {
    pub state_dir: String,
    pub checks: Vec<QemuDoctorCheck>,
}

/// One adb port assignment inside a node's port block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuAdbAssignment {
    pub instance: String,
    pub port: u16,
    /// `127.0.0.1:<port>` — the adb serial the host uses.
    pub serial: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuVmEntry {
    pub name: String,
    pub vcpus: u16,
    pub mem_mib: u32,
    pub accel: String,
    pub ssh_host_port: u16,
    pub adb_ports: Vec<u16>,
    pub adb_assignments: Vec<QemuAdbAssignment>,
    /// qcow2 internal snapshot tags registered in state.json.
    #[serde(default)]
    pub snapshots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuVerifyCheck {
    pub id: String,
    pub title: String,
    /// "PASS" | "FAIL" | "UNTESTED" (CLI serializes the enum UPPERCASE).
    pub verdict: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuVerifyReport {
    pub vm: String,
    #[serde(default)]
    pub container: Option<String>,
    pub checks: Vec<QemuVerifyCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuRedroidInstance {
    pub instance: String,
    pub container: String,
    pub port: u16,
    pub serial: String,
    pub status: String,
    #[serde(default)]
    pub android_version: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub rollback_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuAdbMapping {
    pub serial: String,
    pub vm: String,
    pub instance: String,
}

/// Request for `vm create` (mirrors the CLI flags; camelCase on the wire).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QemuVmCreateRequest {
    pub name: String,
    /// Empty/absent → the default downloaded cloud image is resolved.
    #[serde(default)]
    pub image_path: Option<String>,
    pub cpus: u16,
    pub mem_mib: u32,
    pub disk_gib: u32,
    pub adb_port_count: u16,
    #[serde(default)]
    pub auto_setup: bool,
}

/// Request for `redroid create`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QemuRedroidCreateRequest {
    pub vm: String,
    pub name: String,
    pub cpus: f64,
    pub memory_mib: u32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub android_version: Option<String>,
    #[serde(default)]
    pub install_gapps: bool,
    #[serde(default)]
    pub gapps_zip: String,
    #[serde(default)]
    pub install_magisk: bool,
    #[serde(default)]
    pub install_lsposed: bool,
    #[serde(default)]
    pub install_shamiko: bool,
    #[serde(default)]
    pub install_cloak: bool,
    #[serde(default)]
    pub install_native_cloak: bool,
    #[serde(default)]
    pub native_cloak_zip: String,
    #[serde(default)]
    pub module_zips: Vec<String>,
    #[serde(default)]
    pub spoof_profile_id: Option<String>,
    #[serde(default)]
    pub spoof_profile: String,
    #[serde(default)]
    pub spoof_abilist: bool,
    #[serde(default)]
    pub hide_packages: Vec<String>,
    #[serde(default)]
    pub clean_traces: bool,

}

// ------------------------------------------------------- raw JSON (CLI only) --

// The CLI serializes with its own serde defaults (snake_case fields,
// lowercase/UPPERCASE enums). These mirror structs keep the wire contract
// explicit and let the public types above stay camelCase for the frontend.

#[derive(Deserialize)]
struct RawDoctorReport {
    #[serde(default)]
    state_dir: String,
    #[serde(default)]
    checks: Vec<RawDoctorCheck>,
}

#[derive(Deserialize)]
struct RawDoctorCheck {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    fix: String,
}

#[derive(Deserialize)]
struct RawRegistry {
    #[serde(default)]
    vms: Vec<RawVmEntry>,
}

#[derive(Deserialize)]
struct RawVmEntry {
    name: String,
    #[serde(default)]
    vcpus: u16,
    #[serde(default)]
    mem_mib: u32,
    #[serde(default)]
    accel: String,
    #[serde(default)]
    ssh_host_port: u16,
    #[serde(default)]
    adb_ports: Vec<u16>,
    #[serde(default)]
    adb_assignments: BTreeMap<String, u16>,
    #[serde(default)]
    snapshots: Vec<String>,
}

#[derive(Deserialize)]
struct RawVerifyReport {
    #[serde(default)]
    vm: String,
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    checks: Vec<RawVerifyCheck>,
}

#[derive(Deserialize)]
struct RawVerifyCheck {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    detail: String,
}

#[derive(Deserialize)]
struct RawRedroidEntry {
    instance: String,
    #[serde(default)]
    container: String,
    port: u16,
    #[serde(default)]
    serial: String,
    #[serde(default)]
    status: String,
}

// ------------------------------------------------------------- binary lookup --

/// Candidate binary locations derived from the repository layout (relative to
/// the `src-tauri` crate root, i.e. `<repo>/qemu-center/target/<profile>/`).
fn repo_candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("qemu-center"),
    );
    // Packaged app: look for a sibling `qemu-center` dir a few levels up.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            match dir {
                Some(d) => {
                    roots.push(d.join("qemu-center"));
                    dir = d.parent().map(Path::to_path_buf);
                }
                None => break,
            }
        }
    }
    roots
}

fn candidate_binaries(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        for profile in ["debug", "release"] {
            out.push(root.join("target").join(profile).join(BIN_FILE_NAME));
        }
    }
    out
}

/// Pure resolution: explicit override → repo build outputs (debug, release).
/// Returns `None` when neither source has the binary; the caller then probes PATH.
fn resolve_bin_in(env_value: Option<&str>, roots: &[PathBuf]) -> Option<PathBuf> {
    if let Some(value) = env_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    candidate_binaries(roots).into_iter().find(|p| p.is_file())
}

/// Locate the `qemu-center` binary:
/// 1. `QEMU_CENTER_BIN` environment variable,
/// 2. `<repo>/qemu-center/target/{debug,release}/qemu-center[.exe]`,
/// 3. `where qemu-center` (Windows) / `which qemu-center` (POSIX).
pub fn resolve_qemu_center_bin() -> Option<PathBuf> {
    let env_value = std::env::var("QEMU_CENTER_BIN").ok();
    if let Some(path) = resolve_bin_in(env_value.as_deref(), &repo_candidate_roots()) {
        return Some(path);
    }
    probe_path("qemu-center")
}

fn probe_path(bin: &str) -> Option<PathBuf> {
    let probe = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(probe)
        .arg(bin)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

// ----------------------------------------------------------- portable state --

/// Project-internal "home" of the QEMU track: `<repo>/qemu-center/state`.
/// The bridge pins `--state-dir` here on EVERY CLI invocation (see
/// [`run_cli`]), so the registry, keys, VM disks, cloud images, and the
/// portable QEMU install all stay inside the repository — never
/// `%APPDATA%\QemuCenter`, never `C:\Program Files`.
///
/// Root derivation reuses the [`repo_candidate_roots`] technique
/// (`CARGO_MANIFEST_DIR` for dev builds, exe-relative walk for packaged
/// ones); among the roots, one that already contains a `state` dir wins so
/// debug/release/packaged builds agree once the directory exists.
pub fn default_portable_state_dir() -> PathBuf {
    portable_state_dir_in(&repo_candidate_roots())
}

/// Pure pick: first root whose `state` subdir already exists, else the first
/// root's `state` (the CLI creates the dir on demand).
fn portable_state_dir_in(roots: &[PathBuf]) -> PathBuf {
    for root in roots {
        let candidate = root.join("state");
        if candidate.is_dir() {
            return candidate;
        }
    }
    match roots.first() {
        Some(root) => root.join("state"),
        // Unreachable in practice (repo_candidate_roots always yields one).
        None => PathBuf::from("qemu-center").join("state"),
    }
}

/// Append the portable `--state-dir` pin to an argv (pure). A `--state-dir`
/// already present in `args` (no argv builder emits one today) is stripped —
/// the project-internal pin always wins deterministically.
pub fn args_with_portable_state_dir(args: &[String], state_dir: &Path) -> Vec<String> {
    let mut full: Vec<String> = Vec::with_capacity(args.len() + 2);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--state-dir" {
            let _ = it.next(); // drop the old value too
            continue;
        }
        full.push(arg.clone());
    }
    full.push("--state-dir".into());
    full.push(state_dir.to_string_lossy().into_owned());
    full
}

// ------------------------------------------------------------ staleness guard --

/// Warning line prepended to STDERR (never stdout — `doctor` / `vm list` /
/// `adb list` / `verify` parse their JSON contract from stdout) when the
/// resolved binary predates the qemu-center sources. Informational only:
/// execution proceeds either way.
pub fn stale_cli_warning(bin: &Path) -> String {
    let name = bin
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "qemu-center".into());
    format!(
        "[warn] {name} 落后于源码（源码已修改），建议重新构建：cargo build --manifest-path qemu-center/Cargo.toml"
    )
}

/// Pure core: stale iff the newest source mtime is strictly newer than the
/// binary's. `None` on either side → not stale (undecidable must never block
/// a run — worst case the CLI behaves as it always has).
fn stale_from_mtimes(
    bin_mtime: Option<std::time::SystemTime>,
    newest_source: Option<std::time::SystemTime>,
) -> bool {
    match (bin_mtime, newest_source) {
        (Some(bin), Some(src)) => src > bin,
        _ => false,
    }
}

/// Newest mtime across every `*.rs` file under `src_dir` (recursive). None =
/// no readable `.rs` file (or no such dir). Filesystem reads only, no env.
fn newest_source_mtime(src_dir: &Path) -> Option<std::time::SystemTime> {
    let mut newest: Option<std::time::SystemTime> = None;
    let mut stack = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(path);
                continue;
            }
            let is_rs = path.extension().map(|e| e == "rs").unwrap_or(false);
            if !is_rs {
                continue;
            }
            if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                if newest.map_or(true, |n| mtime > n) {
                    newest = Some(mtime);
                }
            }
        }
    }
    newest
}

/// mtime of `bin`, if readable.
fn bin_mtime(bin: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(bin).and_then(|m| m.modified()).ok()
}

/// Locate the qemu-center `src/` dir for a binary built in the repo layout
/// (`<repo>/qemu-center/target/<profile>/qemu-center[.exe]` →
/// `<repo>/qemu-center/src`). Binaries found via `QEMU_CENTER_BIN` / PATH
/// outside that layout have no comparable sources → None.
fn qemu_center_src_dir_for(bin: &Path) -> Option<PathBuf> {
    // bin → target/<profile> → target → qemu-center
    let crate_root = bin.parent()?.parent()?.parent()?;
    let src = crate_root.join("src");
    src.is_dir().then_some(src)
}

/// True when the resolved `qemu-center` binary was built BEFORE the newest
/// `*.rs` under its crate's `src/` — i.e. it likely lacks newer fixes/flags
/// (real case: an old `qemu-img` without the `--state-dir` fallback). Only
/// compares when the source dir exists next to the binary AND both mtimes are
/// readable; anything undecidable counts as not stale.
pub fn cli_is_stale(bin: &Path) -> bool {
    let Some(src_dir) = qemu_center_src_dir_for(bin) else {
        return false;
    };
    stale_from_mtimes(bin_mtime(bin), newest_source_mtime(&src_dir))
}

// ------------------------------------------------------------- process spawn --

/// Spawn the CLI and capture stdout/stderr/exit code. Independent of
/// `util::run_command` on purpose: the QEMU track must not inherit the
/// Docker track's proxy/env/argument plumbing (zero-coupling rule).
///
/// Portable rule: every invocation gets `--state-dir <repo>/qemu-center/state`
/// appended, so nothing can land in `%APPDATA%` or `C:\Program Files`.
pub fn run_cli(args: &[String], timeout: Duration) -> Result<QemuCliOutput, String> {
    let bin = resolve_qemu_center_bin().ok_or_else(|| {
        "qemu-center 可执行文件未找到：请设置 QEMU_CENTER_BIN，或先在仓库根执行 \
         `cargo build --manifest-path qemu-center/Cargo.toml`"
            .to_string()
    })?;
    let state_dir = default_portable_state_dir();
    // Lightweight staleness guard: warn (never block) when the binary
    // predates the sources. The warning goes to STDERR — stdout carries the
    // JSON contract, and prefixing it there would break doctor / vm list
    // parsing (and the human-readable passthrough commands' UI log panel).
    let stale = cli_is_stale(&bin);
    let result = run_cli_at(&bin, &args_with_portable_state_dir(args, &state_dir), timeout);
    if !stale {
        return result;
    }
    let warning = stale_cli_warning(&bin);
    match result {
        Ok(mut output) => {
            output.stderr = if output.stderr.is_empty() {
                warning
            } else {
                format!("{warning}\n{}", output.stderr)
            };
            Ok(output)
        }
        Err(message) => Err(format!("{warning}\n{message}")),
    }
}

/// Runtime-unverified half: actually spawns the process.
pub fn run_cli_at(bin: &Path, args: &[String], timeout: Duration) -> Result<QemuCliOutput, String> {
    let effective = timeout.min(Duration::from_secs(MAX_CLI_TIMEOUT_SECS));
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", bin.display()))?;
    let child_id = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(effective) {
        Ok(Ok(output)) => Ok(QemuCliOutput {
            success: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim_end().to_string(),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            kill_cli_tree(child_id);
            Err(format!(
                "qemu-center {} timed out after {}s",
                args.first().map(String::as_str).unwrap_or("<no args>"),
                effective.as_secs()
            ))
        }
    }
}

fn kill_cli_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

// --------------------------------------------------------------- argv builders

pub fn args_doctor() -> Vec<String> {
    vec!["doctor".into(), "--json".into()]
}

/// `setup whpx|qemu` take no distro; `setup image|all` do.
pub fn args_setup(step: &str, distro: &str) -> Result<Vec<String>, String> {
    match step {
        "whpx" | "qemu" => Ok(vec!["setup".into(), step.into()]),
        "image" | "all" => Ok(vec![
            "setup".into(),
            step.into(),
            "--distro".into(),
            distro.into(),
        ]),
        other => Err(format!(
            "unknown setup step {other:?} (expected whpx|qemu|image|all)"
        )),
    }
}

pub fn args_vm_list() -> Vec<String> {
    vec!["vm".into(), "list".into(), "--json".into()]
}

pub fn args_vm_start(name: &str) -> Vec<String> {
    vec!["vm".into(), "start".into(), name.into()]
}

pub fn args_vm_stop(name: &str) -> Vec<String> {
    vec!["vm".into(), "stop".into(), name.into()]
}

pub fn args_vm_delete(name: &str, purge: bool) -> Vec<String> {
    let mut args = vec!["vm".into(), "delete".into(), name.into()];
    if purge {
        args.push("--purge".into());
    }
    args
}

/// `vm snapshot <name> <tag>` — qcow2 internal snapshot (VM should be stopped).
pub fn args_vm_snapshot(name: &str, tag: &str) -> Vec<String> {
    vec!["vm".into(), "snapshot".into(), name.into(), tag.into()]
}

/// `vm restore <name> <tag>` — apply a qcow2 internal snapshot (VM must be
/// stopped; qemu-img refuses images locked by a running qemu process).
pub fn args_vm_restore(name: &str, tag: &str) -> Vec<String> {
    vec!["vm".into(), "restore".into(), name.into(), tag.into()]
}

/// Default downloaded cloud image path (same convention as `setup image`'s
/// destination): `<state-dir>/images/<distro>-server-cloudimg-amd64.img`.
pub fn default_image_path_in(state_dir: &Path, distro: &str) -> PathBuf {
    state_dir
        .join("images")
        .join(format!("{distro}-server-cloudimg-amd64.img"))
}

/// Resolve the default cloud image inside the PORTABLE state dir
/// (`<repo>/qemu-center/state/images/…`) — the UI's "imagePath left empty"
/// flow resolves here, matching where `setup image` now downloads.
pub fn default_image_path() -> PathBuf {
    default_image_path_in(&default_portable_state_dir(), DEFAULT_IMAGE_DISTRO)
}

pub fn args_vm_create(request: &QemuVmCreateRequest) -> Result<Vec<String>, String> {
    let image = match request.image_path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => default_image_path(),
    };
    if request.adb_port_count == 0 {
        return Err("adbPortCount must be > 0".into());
    }
    let mut args = vec![
        "vm".into(),
        "create".into(),
        request.name.clone(),
        "--image".into(),
        image.to_string_lossy().into_owned(),
        "--cpus".into(),
        request.cpus.to_string(),
        "--mem".into(),
        request.mem_mib.to_string(),
        "--disk-gib".into(),
        request.disk_gib.to_string(),
        "--adb-port-count".into(),
        request.adb_port_count.to_string(),
    ];
    if request.auto_setup {
        args.push("--auto-setup".into());
    }
    Ok(args)
}

pub fn args_guest_wait(name: &str, timeout_secs: u64) -> Vec<String> {
    vec![
        "guest".into(),
        "wait".into(),
        name.into(),
        "--timeout-secs".into(),
        timeout_secs.to_string(),
    ]
}

pub fn args_redroid_create(request: &QemuRedroidCreateRequest) -> Vec<String> {
    let mut args = vec![
        "redroid".into(),
        "create".into(),
        request.vm.clone(),
        request.name.clone(),
        "--cpus".into(),
        trim_float(request.cpus),
        "--memory".into(),
        request.memory_mib.to_string(),
        "--width".into(),
        request.width.to_string(),
        "--height".into(),
        request.height.to_string(),
        "--dpi".into(),
        request.dpi.to_string(),
    ];
    if let Some(image) = request.image.as_deref().filter(|s| !s.is_empty()) {
        args.extend(["--image".into(), image.into()]);
    }
    args
}

pub fn args_redroid_list(vm: &str) -> Vec<String> {
    vec!["redroid".into(), "list".into(), vm.into(), "--json".into()]
}

pub fn args_adb_list() -> Vec<String> {
    vec!["adb".into(), "list".into(), "--json".into()]
}

pub fn args_verify(vm: Option<&str>) -> Vec<String> {
    let mut args = vec!["verify".into(), "--json".into()];
    if let Some(vm) = vm.map(str::trim).filter(|v| !v.is_empty()) {
        args.push("--vm".into());
        args.push(vm.into());
    }
    args
}

fn trim_float(value: f64) -> String {
    let text = format!("{value}");
    text.strip_suffix(".0").map(str::to_string).unwrap_or(text)
}

pub fn adb_serial(port: u16) -> String {
    format!("127.0.0.1:{port}")
}

// -------------------------------------------------------------- JSON parsers --

fn parse_json<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    serde_json::from_str::<T>(raw).map_err(|e| {
        let head: String = raw.chars().take(200).collect();
        format!("parse qemu-center JSON failed: {e} (head: {head:?})")
    })
}

pub fn parse_doctor_json(raw: &str) -> Result<QemuDoctorReport, String> {
    let parsed: RawDoctorReport = parse_json(raw)?;
    Ok(QemuDoctorReport {
        state_dir: parsed.state_dir,
        checks: parsed
            .checks
            .into_iter()
            .map(|c| QemuDoctorCheck {
                id: c.id,
                title: c.title,
                status: c.status.to_ascii_lowercase(),
                detail: c.detail,
                fix: c.fix,
            })
            .collect(),
    })
}

pub fn parse_vm_list_json(raw: &str) -> Result<Vec<QemuVmEntry>, String> {
    let parsed: RawRegistry = parse_json(raw)?;
    Ok(parsed
        .vms
        .into_iter()
        .map(|vm| QemuVmEntry {
            name: vm.name,
            vcpus: vm.vcpus,
            mem_mib: vm.mem_mib,
            accel: vm.accel,
            ssh_host_port: vm.ssh_host_port,
            adb_ports: vm.adb_ports,
            adb_assignments: vm
                .adb_assignments
                .into_iter()
                .map(|(instance, port)| QemuAdbAssignment {
                    instance,
                    port,
                    serial: adb_serial(port),
                })
                .collect(),
            snapshots: vm.snapshots,
        })
        .collect())
}

pub fn parse_verify_json(raw: &str) -> Result<QemuVerifyReport, String> {
    let parsed: RawVerifyReport = parse_json(raw)?;
    Ok(QemuVerifyReport {
        vm: parsed.vm,
        container: parsed.container,
        checks: parsed
            .checks
            .into_iter()
            .map(|c| QemuVerifyCheck {
                id: c.id,
                title: c.title,
                verdict: c.verdict.to_ascii_uppercase(),
                detail: c.detail,
            })
            .collect(),
    })
}

pub fn parse_redroid_list_json(raw: &str) -> Result<Vec<QemuRedroidInstance>, String> {
    let parsed: Vec<RawRedroidEntry> = parse_json(raw)?;
    Ok(parsed
        .into_iter()
        .map(|entry| QemuRedroidInstance {
            serial: if entry.serial.is_empty() {
                adb_serial(entry.port)
            } else {
                entry.serial
            },
            instance: entry.instance,
            container: entry.container,
            port: entry.port,
            status: entry.status,
            android_version: String::new(),
            image: String::new(),
            rollback_available: false,
        })
        .collect())
}

pub fn parse_adb_list_json(raw: &str) -> Result<Vec<QemuAdbMapping>, String> {
    // The CLI serializes `Vec<(String, String, String)>` as an array of
    // three-element arrays: [serial, vm, instance].
    let parsed: Vec<(String, String, String)> = parse_json(raw)?;
    Ok(parsed
        .into_iter()
        .map(|(serial, vm, instance)| QemuAdbMapping {
            serial,
            vm,
            instance,
        })
        .collect())
}

// ---------------------------------------------------------------- service ops --

pub fn doctor() -> Result<QemuDoctorReport, String> {
    let output = run_cli(&args_doctor(), Duration::from_secs(120))?;
    // Exit code 2 means "some check failed" — stdout still carries the report.
    parse_doctor_json(&output.stdout)
}

pub fn setup(step: &str, distro: &str) -> Result<QemuCliOutput, String> {
    let args = args_setup(step, distro)?;
    let mut output = run_cli(&args, Duration::from_secs(MAX_CLI_TIMEOUT_SECS))?;
    // Tell the operator where everything was installed (the UI log panel
    // prints stdout line by line). Pure informational — the reboot-detection
    // regex in the frontend is an additive match over the same text.
    let stdout = output.stdout.trim_end().to_string();
    output.stdout = if stdout.is_empty() {
        format!("[state-dir] {}", default_portable_state_dir().display())
    } else {
        format!("{}\n[state-dir] {}", stdout, default_portable_state_dir().display())
    };
    Ok(output)
}

pub fn vm_list() -> Result<Vec<QemuVmEntry>, String> {
    let output = run_cli(&args_vm_list(), Duration::from_secs(60))?;
    parse_vm_list_json(&output.stdout)
}

pub fn vm_create(request: QemuVmCreateRequest) -> Result<QemuCliOutput, String> {
    let args = args_vm_create(&request)?;
    run_cli(&args, Duration::from_secs(MAX_CLI_TIMEOUT_SECS))
}

pub fn vm_start(name: &str) -> Result<QemuCliOutput, String> {
    run_cli(&args_vm_start(name), Duration::from_secs(90))
}

pub fn vm_stop(name: &str) -> Result<QemuCliOutput, String> {
    run_cli(&args_vm_stop(name), Duration::from_secs(60))
}

pub fn vm_delete(name: &str, purge: bool) -> Result<QemuCliOutput, String> {
    run_cli(&args_vm_delete(name, purge), Duration::from_secs(120))
}

pub fn vm_snapshot(name: &str, tag: &str) -> Result<QemuCliOutput, String> {
    // qemu-img runs locally against the qcow2 — a few minutes is generous.
    run_cli(&args_vm_snapshot(name, tag), Duration::from_secs(300))
}

pub fn vm_restore(name: &str, tag: &str) -> Result<QemuCliOutput, String> {
    run_cli(&args_vm_restore(name, tag), Duration::from_secs(300))
}

pub fn guest_wait(name: &str, timeout_secs: u64) -> Result<QemuCliOutput, String> {
    // The CLI polls internally until its own deadline; give the process a
    // little headroom on top so the CLI's own error text wins the race.
    let budget = timeout_secs.saturating_add(60).min(MAX_CLI_TIMEOUT_SECS);
    run_cli(&args_guest_wait(name, timeout_secs), Duration::from_secs(budget))
}

pub fn redroid_create(request: QemuRedroidCreateRequest) -> Result<QemuCliOutput, String> {
    crate::services::qemu_presets::apply(request, false)
}

pub fn redroid_list(vm: &str) -> Result<Vec<QemuRedroidInstance>, String> {
    let output = run_cli(&args_redroid_list(vm), Duration::from_secs(90))?;
    let mut rows = parse_redroid_list_json(&output.stdout)?;
    crate::services::qemu_presets::enrich(vm, &mut rows);
    Ok(rows)
}

pub fn adb_list() -> Result<Vec<QemuAdbMapping>, String> {
    let output = run_cli(&args_adb_list(), Duration::from_secs(30))?;
    parse_adb_list_json(&output.stdout)
}

/// One QEMU-track adb serial with its live adb state, as surfaced to the
/// unified device list (`list_devices_unified`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QemuAdbDeviceStatus {
    pub serial: String,
    pub vm: String,
    pub instance: String,
    /// True iff `adb devices` currently reports this serial as `device`.
    pub online: bool,
}

/// Pure: an adb mapping is online iff the host adb server reports state
/// `device` for the serial (offline/unauthorized/recovering all count as not
/// ready — same rule as the Docker track's list).
pub fn mapping_is_online(state: &str) -> bool {
    state.trim() == "device"
}

/// List every QEMU-track adb serial (`adb list --json` from the CLI registry)
/// and judge each one's live state over the shared host adb channel. The CLI
/// registry is the source of truth for vm/instance names; adb is the source of
/// truth for reachability. Runtime spawn — unit tests cover the pure parts.
pub fn list_qemu_adb_devices() -> Result<Vec<QemuAdbDeviceStatus>, String> {
    Ok(adb_list()?
        .into_iter()
        .map(|m| {
            let online = mapping_is_online(&adb::device_state(&m.serial));
            QemuAdbDeviceStatus {
                serial: m.serial,
                vm: m.vm,
                instance: m.instance,
                online,
            }
        })
        .collect())
}

pub fn verify(vm: &str) -> Result<QemuVerifyReport, String> {
    let output = run_cli(&args_verify(Some(vm)), Duration::from_secs(10 * 60))?;
    parse_verify_json(&output.stdout)
}

// --------------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rdc-qemu-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    const DOCTOR_JSON: &str = r#"{
      "state_dir": "C:\\Users\\u\\AppData\\Roaming\\QemuCenter",
      "checks": [
        {"id": "whpx", "title": "WHPX feature", "status": "fail",
         "detail": "HypervisorPlatform = Disabled", "fix": "run qemu-center setup whpx"},
        {"id": "qemu", "title": "QEMU installed", "status": "unknown", "detail": ""},
        {"id": "disk", "title": "Free disk", "status": "ok", "detail": "90.3 GiB free", "fix": ""}
      ]
    }"#;

    const VM_LIST_JSON: &str = r#"{
      "version": 1,
      "vms": [
        {"name": "node1", "base_image": "C:\\img\\noble.img",
         "disk": "C:\\s\\vms\\node1\\disk.qcow2", "vcpus": 4, "mem_mib": 4096,
         "accel": "whpx", "ssh_host_port": 22300, "qmp_host_port": 23300,
         "adb_ports": [24500, 24501, 24502], "adb_assignments": {"r1": 24500, "r2": 24501},
         "snapshots": [], "created_at_unix": 1700000000,
         "cloud_init": {"hostname": "node1", "ssh_pubkey": "ssh-rsa AAAA", "docker_install": "get-docker"},
         "redroid_image": "redroid/redroid:14.0.0-latest"}
      ]
    }"#;

    const VERIFY_JSON: &str = r#"{
      "vm": "node1",
      "container": "qc-r1",
      "checks": [
        {"id": "whpx", "title": "WHPX usable", "verdict": "PASS", "detail": "probe exit 0"},
        {"id": "ssh", "title": "guest SSH reachable", "verdict": "FAIL", "detail": "ssh: connect refused"},
        {"id": "boot-completed", "title": "redroid booted", "verdict": "UNTESTED", "detail": "vm stopped"}
      ]
    }"#;

    const REDROID_JSON: &str = r#"[
      {"instance": "r1", "container": "qc-r1", "port": 24500,
       "serial": "127.0.0.1:24500", "status": "Up 3 minutes"},
      {"instance": "r2", "container": "qc-r2", "port": 24501, "status": "unknown"}
    ]"#;

    const ADB_JSON: &str = r#"[["127.0.0.1:24500","node1","r1"],["127.0.0.1:24501","node1","r2"]]"#;

    #[test]
    fn env_override_wins_for_binary_resolution() {
        let dir = temp_dir("env");
        let bin = dir.join("custom-qemu-center.exe");
        std::fs::write(&bin, b"stub").unwrap();
        let other = temp_dir("env-root");
        let resolved = resolve_bin_in(Some(bin.to_string_lossy().as_ref()), &[other.clone()]);
        assert_eq!(resolved.as_deref(), Some(bin.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn blank_env_override_falls_through_to_repo_candidates() {
        let root = temp_dir("repo");
        let debug_bin = root.join("target").join("debug").join(BIN_FILE_NAME);
        std::fs::create_dir_all(debug_bin.parent().unwrap()).unwrap();
        std::fs::write(&debug_bin, b"stub").unwrap();
        let resolved = resolve_bin_in(Some("   "), &[root.clone()]);
        assert_eq!(resolved.as_deref(), Some(debug_bin.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn release_candidate_found_when_debug_is_absent() {
        let root = temp_dir("release");
        let release_bin = root.join("target").join("release").join(BIN_FILE_NAME);
        std::fs::create_dir_all(release_bin.parent().unwrap()).unwrap();
        std::fs::write(&release_bin, b"stub").unwrap();
        let resolved = resolve_bin_in(None, &[root.clone()]);
        assert_eq!(resolved.as_deref(), Some(release_bin.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_everywhere_resolves_to_none() {
        let root = temp_dir("missing");
        assert!(resolve_bin_in(None, &[root.clone()]).is_none());
        assert!(resolve_bin_in(Some("C:/nope/qemu-center.exe"), &[root.clone()]).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn doctor_argv_requests_json() {
        assert_eq!(args_doctor(), vec!["doctor", "--json"]);
    }

    #[test]
    fn setup_argv_passes_distro_only_for_image_and_all() {
        assert_eq!(args_setup("whpx", "noble").unwrap(), vec!["setup", "whpx"]);
        assert_eq!(args_setup("qemu", "noble").unwrap(), vec!["setup", "qemu"]);
        assert_eq!(
            args_setup("image", "jammy").unwrap(),
            vec!["setup", "image", "--distro", "jammy"]
        );
        assert_eq!(
            args_setup("all", "noble").unwrap(),
            vec!["setup", "all", "--distro", "noble"]
        );
        assert!(args_setup("nope", "noble").is_err());
    }

    #[test]
    fn vm_create_argv_carries_all_specs_and_auto_setup_flag() {
        let request = QemuVmCreateRequest {
            name: "node1".into(),
            image_path: Some("C:/img/noble.img".into()),
            cpus: 4,
            mem_mib: 4096,
            disk_gib: 40,
            adb_port_count: 32,
            auto_setup: true,
        };
        assert_eq!(
            args_vm_create(&request).unwrap(),
            vec![
                "vm", "create", "node1", "--image", "C:/img/noble.img", "--cpus", "4", "--mem",
                "4096", "--disk-gib", "40", "--adb-port-count", "32", "--auto-setup",
            ]
        );
    }

    #[test]
    fn vm_create_argv_omits_auto_setup_when_unchecked() {
        let request = QemuVmCreateRequest {
            name: "node2".into(),
            image_path: Some("D:/i.img".into()),
            cpus: 2,
            mem_mib: 2048,
            disk_gib: 20,
            adb_port_count: 8,
            auto_setup: false,
        };
        let args = args_vm_create(&request).unwrap();
        assert!(!args.iter().any(|a| a == "--auto-setup"));
        assert_eq!(args[2], "node2");
    }

    #[test]
    fn vm_create_rejects_zero_port_count() {
        let request = QemuVmCreateRequest {
            name: "node3".into(),
            image_path: Some("D:/i.img".into()),
            cpus: 2,
            mem_mib: 2048,
            disk_gib: 20,
            adb_port_count: 0,
            auto_setup: false,
        };
        assert!(args_vm_create(&request).is_err());
    }

    #[test]
    fn default_image_path_is_derived_from_distro_and_state_dir() {
        let base = PathBuf::from("C:/Users/u/AppData/Roaming/QemuCenter");
        assert_eq!(
            default_image_path_in(&base, "noble"),
            base.join("images").join("noble-server-cloudimg-amd64.img")
        );
        assert_eq!(
            default_image_path_in(&base, "jammy"),
            base.join("images").join("jammy-server-cloudimg-amd64.img")
        );
    }

    // --- portable state-dir pin (all artifacts inside the project) ---

    #[test]
    fn portable_state_dir_prefers_an_existing_state_dir_then_first_root() {
        let a = temp_dir("roots-a");
        let b = temp_dir("roots-b");
        // No `state` anywhere → the first root wins (deterministic fallback;
        // the CLI creates the dir on demand).
        assert_eq!(
            portable_state_dir_in(&[a.clone(), b.clone()]),
            a.join("state")
        );
        // A root that already has `state` wins over the first root.
        std::fs::create_dir_all(b.join("state")).unwrap();
        assert_eq!(portable_state_dir_in(&[a.clone(), b.clone()]), b.join("state"));
        // Empty roots: neutral relative fallback (unreachable in production).
        assert_eq!(
            portable_state_dir_in(&[]),
            PathBuf::from("qemu-center").join("state")
        );
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn state_dir_pin_is_appended_and_strips_any_previous_pin() {
        let pinned = args_with_portable_state_dir(
            &["doctor".to_string(), "--json".to_string()],
            Path::new("F:/repo/qemu-center/state"),
        );
        assert_eq!(
            pinned,
            vec![
                "doctor".to_string(),
                "--json".to_string(),
                "--state-dir".to_string(),
                "F:/repo/qemu-center/state".to_string(),
            ]
        );
        // A pre-existing --state-dir (no argv builder emits one today) is
        // dropped together with its value; the project pin always wins.
        let pinned = args_with_portable_state_dir(
            &[
                "--state-dir".to_string(),
                "C:/elsewhere".to_string(),
                "vm".to_string(),
                "list".to_string(),
            ],
            Path::new("F:/repo/state"),
        );
        assert_eq!(pinned, vec!["vm", "list", "--state-dir", "F:/repo/state"]);
    }

    #[test]
    fn default_image_path_lands_inside_the_portable_state_dir() {
        let text = default_image_path().to_string_lossy().replace('\\', "/");
        assert!(
            text.ends_with("qemu-center/state/images/noble-server-cloudimg-amd64.img"),
            "unexpected default image path: {text}"
        );
    }

    #[test]
    fn guest_wait_argv_carries_timeout() {
        assert_eq!(
            args_guest_wait("node1", 600),
            vec!["guest", "wait", "node1", "--timeout-secs", "600"]
        );
    }

    #[test]
    fn redroid_create_argv_matches_cli_flags() {
        let request = QemuRedroidCreateRequest {
            vm: "node1".into(),
            name: "r1".into(),
            cpus: 2.0,
            memory_mib: 2048,
            width: 720,
            height: 1280,
            dpi: 320,
            ..Default::default()
        };
        assert_eq!(
            args_redroid_create(&request),
            vec![
                "redroid", "create", "node1", "r1", "--cpus", "2", "--memory", "2048", "--width",
                "720", "--height", "1280", "--dpi", "320",
            ]
        );
    }

    #[test]
    fn verify_and_delete_argv_variants() {
        assert_eq!(args_verify(None), vec!["verify", "--json"]);
        assert_eq!(
            args_verify(Some("node1")),
            vec!["verify", "--json", "--vm", "node1"]
        );
        assert_eq!(args_vm_delete("node1", false), vec!["vm", "delete", "node1"]);
        assert_eq!(
            args_vm_delete("node1", true),
            vec!["vm", "delete", "node1", "--purge"]
        );
        assert_eq!(args_redroid_list("node1"), vec!["redroid", "list", "node1", "--json"]);
        assert_eq!(args_adb_list(), vec!["adb", "list", "--json"]);
    }

    #[test]
    fn doctor_json_is_parsed_with_status_normalized_and_missing_fix_tolerated() {
        let report = parse_doctor_json(DOCTOR_JSON).unwrap();
        assert_eq!(report.state_dir, "C:\\Users\\u\\AppData\\Roaming\\QemuCenter");
        assert_eq!(report.checks.len(), 3);
        assert_eq!(report.checks[0].status, "fail");
        assert_eq!(report.checks[0].fix, "run qemu-center setup whpx");
        assert_eq!(report.checks[1].status, "unknown");
        assert_eq!(report.checks[1].fix, "");
        assert_eq!(report.checks[2].status, "ok");
    }

    #[test]
    fn vm_list_json_maps_assignments_to_serial_entries() {
        let vms = parse_vm_list_json(VM_LIST_JSON).unwrap();
        assert_eq!(vms.len(), 1);
        let vm = &vms[0];
        assert_eq!(vm.name, "node1");
        assert_eq!(vm.vcpus, 4);
        assert_eq!(vm.mem_mib, 4096);
        assert_eq!(vm.accel, "whpx");
        assert_eq!(vm.ssh_host_port, 22300);
        assert_eq!(vm.adb_ports, vec![24500, 24501, 24502]);
        assert_eq!(vm.adb_assignments.len(), 2);
        assert_eq!(vm.adb_assignments[0].instance, "r1");
        assert_eq!(vm.adb_assignments[0].serial, "127.0.0.1:24500");
    }

    #[test]
    fn empty_registry_parses_to_no_vms() {
        assert!(parse_vm_list_json("{\"version\":1,\"vms\":[]}").unwrap().is_empty());
        assert!(parse_vm_list_json("{\"version\":1}").unwrap().is_empty());
    }

    #[test]
    fn verify_json_keeps_verdicts_uppercase_and_untested_distinct() {
        let report = parse_verify_json(VERIFY_JSON).unwrap();
        assert_eq!(report.vm, "node1");
        assert_eq!(report.container.as_deref(), Some("qc-r1"));
        assert_eq!(report.checks.len(), 3);
        assert_eq!(report.checks[0].verdict, "PASS");
        assert_eq!(report.checks[1].verdict, "FAIL");
        assert_eq!(report.checks[2].verdict, "UNTESTED");
    }

    #[test]
    fn redroid_list_json_falls_back_to_derived_serial() {
        let instances = parse_redroid_list_json(REDROID_JSON).unwrap();
        assert_eq!(instances.len(), 2);
        assert_eq!(instances[0].serial, "127.0.0.1:24500");
        assert_eq!(instances[0].container, "qc-r1");
        assert_eq!(instances[0].status, "Up 3 minutes");
        assert_eq!(instances[1].serial, "127.0.0.1:24501");
        assert_eq!(instances[1].status, "unknown");
    }

    #[test]
    fn adb_list_json_maps_triples() {
        let rows = parse_adb_list_json(ADB_JSON).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].serial, "127.0.0.1:24500");
        assert_eq!(rows[0].vm, "node1");
        assert_eq!(rows[0].instance, "r1");
        assert_eq!(rows[1].instance, "r2");
    }

    #[test]
    fn malformed_json_reports_a_parse_error() {
        assert!(parse_doctor_json("not json").is_err());
        assert!(parse_verify_json("").is_err());
        assert!(parse_vm_list_json("[1,2,3]").is_err());
        assert!(parse_adb_list_json("{}").is_err());
    }

    #[test]
    fn serial_helper_matches_verify_convention() {
        assert_eq!(adb_serial(24500), "127.0.0.1:24500");
    }

    #[test]
    fn adb_mapping_online_requires_exact_device_state() {
        assert!(mapping_is_online("device"));
        assert!(mapping_is_online("  device\n"));
        assert!(!mapping_is_online("offline"));
        assert!(!mapping_is_online("unauthorized"));
        assert!(!mapping_is_online(""));
    }

    #[test]
    fn vm_snapshot_and_restore_argv_carry_name_and_tag() {
        assert_eq!(
            args_vm_snapshot("node1", "clean-1"),
            vec!["vm", "snapshot", "node1", "clean-1"]
        );
        assert_eq!(
            args_vm_restore("node1", "clean-1"),
            vec!["vm", "restore", "node1", "clean-1"]
        );
    }

    #[test]
    fn vm_list_json_carries_registered_snapshot_tags() {
        let vms = parse_vm_list_json(VM_LIST_JSON).unwrap();
        assert!(vms[0].snapshots.is_empty());
        let raw = r#"{"version":1,"vms":[{"name":"node1","snapshots":["clean-1","v2"]}]}"#;
        let vms = parse_vm_list_json(raw).unwrap();
        assert_eq!(vms[0].snapshots, vec!["clean-1".to_string(), "v2".to_string()]);
    }

    // --- CLI staleness guard (binary older than qemu-center/src/*.rs) ---

    /// Deterministic mtime setter (write-then-write ordering is not reliable:
    /// both writes can land in the same filesystem timestamp tick).
    fn set_mtime(path: &Path, secs: u64) {
        let file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open for mtime");
        file.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(secs))
            .expect("set mtime");
    }

    #[test]
    fn stale_from_mtimes_requires_a_strictly_newer_source() {
        let t = |secs: u64| std::time::UNIX_EPOCH + Duration::from_secs(secs);
        assert!(stale_from_mtimes(Some(t(1_000)), Some(t(2_000))), "source newer → stale");
        assert!(!stale_from_mtimes(Some(t(2_000)), Some(t(1_000))), "rebuilt → fresh");
        assert!(!stale_from_mtimes(Some(t(2_000)), Some(t(2_000))), "equal → fresh");
        // Undecidable (unreadable binary / no sources) → fresh, never blocks.
        assert!(!stale_from_mtimes(None, Some(t(2_000))));
        assert!(!stale_from_mtimes(Some(t(1_000)), None));
        assert!(!stale_from_mtimes(None, None));
    }

    #[test]
    fn newest_source_mtime_scans_rs_files_recursively_only() {
        let root = temp_dir("stale-src");
        let src = root.join("src");
        let nested = src.join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(src.join("lib.rs"), b"stub").unwrap();
        std::fs::write(src.join("notes.txt"), b"ignore me").unwrap();
        std::fs::write(nested.join("late.rs"), b"stub").unwrap();
        set_mtime(&src.join("lib.rs"), 1_000);
        set_mtime(&src.join("notes.txt"), 9_000); // newest overall — must be ignored
        set_mtime(&nested.join("late.rs"), 5_000);
        assert_eq!(
            newest_source_mtime(&src),
            Some(std::time::UNIX_EPOCH + Duration::from_secs(5_000)),
            "newest *.rs wins, non-.rs files ignored, subdirs walked"
        );
        assert_eq!(newest_source_mtime(&root.join("nope")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cli_is_stale_only_when_sources_next_to_the_binary_are_newer() {
        // Repo layout: <root>/qemu-center/target/debug/<bin> + <...>/src/*.rs.
        let root = temp_dir("stale-bin");
        let qc = root.join("qemu-center");
        let bin = qc.join("target").join("debug").join(BIN_FILE_NAME);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::create_dir_all(qc.join("src")).unwrap();
        std::fs::write(&bin, b"stub").unwrap();
        set_mtime(&bin, 1_000);
        let source = qc.join("src").join("doctor.rs");
        std::fs::write(&source, b"stub").unwrap();
        set_mtime(&source, 2_000);
        assert!(cli_is_stale(&bin), "source edited after the build");
        // Rebuild (binary newer than every source) → fresh.
        set_mtime(&bin, 3_000);
        assert!(!cli_is_stale(&bin));
        let _ = std::fs::remove_dir_all(&root);

        // Same layout WITHOUT a src dir → never stale ("src 存在才比较").
        let root = temp_dir("stale-nosrc");
        let bin = root
            .join("qemu-center")
            .join("target")
            .join("debug")
            .join(BIN_FILE_NAME);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"stub").unwrap();
        set_mtime(&bin, 1_000);
        assert!(!cli_is_stale(&bin), "no comparable sources → fresh");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_warning_carries_the_rebuild_hint() {
        let warning =
            stale_cli_warning(Path::new("F:/repo/qemu-center/target/debug/qemu-center.exe"));
        assert!(warning.starts_with("[warn]"));
        assert!(warning.contains("qemu-center.exe"));
        assert!(warning.contains("落后于源码"));
        assert!(warning.contains("cargo build --manifest-path qemu-center/Cargo.toml"));
        // Fallback name when the path has no file component.
        assert!(stale_cli_warning(Path::new("")).contains("qemu-center"));
    }
}
