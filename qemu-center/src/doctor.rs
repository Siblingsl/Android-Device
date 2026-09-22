//! `doctor` — host environment diagnosis the operator can run *right now* on
//! their Windows machine (no VM needed).
//!
//! Checks: WHPX optional feature (CIM, no elevation needed), QEMU binary
//! discovery, a real WHPX acceleration probe via
//! `qemu-system-x86_64 -accel whpx -machine q35`, free disk space, ssh/adb/
//! Every check has its command assembly and output parsing as separate pure
//! functions (unit-tested); the runtime part only shells out and feeds the
//! parser.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::exec;

/// Minimum free space on the state-dir drive before `vm create` is sensible
/// (one Ubuntu cloud image ≈ 3 GiB + qcow2 growth for a 40 GiB virtual disk).
pub const MIN_FREE_BYTES: u64 = 40 * 1024 * 1024 * 1024;

/// PowerShell/CIM argv for the host's currently available physical memory.
/// `FreePhysicalMemory` is a locale-neutral KiB value.
pub fn free_physical_memory_command() -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        "(Get-CimInstance -ClassName Win32_OperatingSystem).FreePhysicalMemory".into(),
    ]
}

/// Parse the bare KiB value emitted by [`free_physical_memory_command`].
/// Empty output, localized error text, commas, and trailing tokens remain
/// unknown rather than being guessed as a safe amount.
pub fn parse_free_physical_memory_kib(stdout: &str) -> Option<u64> {
    let value = stdout.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()?.checked_mul(1024)
}

/// Parse Linux `/proc/meminfo`'s `MemAvailable` field into bytes.
pub fn parse_meminfo_available_bytes(contents: &str) -> Option<u64> {
    for line in contents.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("MemAvailable:") {
            continue;
        }
        let kib = fields.next()?.parse::<u64>().ok()?;
        if fields.next() != Some("kB") {
            return None;
        }
        return kib.checked_mul(1024);
    }
    None
}

/// Read host available memory without changing any state. The Windows path
/// uses CIM; Linux uses the kernel's MemAvailable estimate. Other platforms
/// deliberately remain unknown rather than inventing a value.
pub fn host_available_memory_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        let result = exec::run_command(&free_physical_memory_command(), Duration::from_secs(10));
        return result
            .success
            .then(|| parse_free_physical_memory_kib(&result.stdout))
            .flatten();
    }

    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|contents| parse_meminfo_available_bytes(&contents));
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

// ------------------------------------------------------------------ models --

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Fail,
    Unknown,
}

impl CheckStatus {
    pub fn marker(self) -> &'static str {
        match self {
            CheckStatus::Ok => "[ ok ]",
            CheckStatus::Fail => "[FAIL]",
            CheckStatus::Unknown => "[ ?  ]",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorCheck {
    pub id: &'static str,
    pub title: &'static str,
    pub status: CheckStatus,
    pub detail: String,
    /// Actionable hint when the check is not ok.
    pub fix: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub state_dir: String,
    pub checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    pub fn to_text(&self) -> String {
        let mut s = String::new();
        s.push_str("QemuCenter doctor — host readiness report\n");
        s.push_str(&format!("state dir: {}\n\n", self.state_dir));
        for c in &self.checks {
            s.push_str(&format!("{} {:<14} {}\n", c.status.marker(), c.id, c.title));
            if !c.detail.is_empty() {
                for line in c.detail.lines() {
                    s.push_str(&format!("       {line}\n"));
                }
            }
            if c.status != CheckStatus::Ok && !c.fix.is_empty() {
                s.push_str(&format!("       fix: {}\n", c.fix));
            }
        }
        let ok = self
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Ok)
            .count();
        let fail = self
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Fail)
            .count();
        let unknown = self.checks.len() - ok - fail;
        s.push_str(&format!(
            "\nsummary: {ok} ok / {fail} fail / {unknown} unknown\n"
        ));
        s
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

// ------------------------------------------------------- WHPX feature check --

/// PowerShell argv to read the state of a Windows optional feature via the
/// DISM cmdlet (requires elevation). JSON output is requested so parsing
/// stays machine-readable. Kept for the ELEVATED `setup whpx` path — doctor's
/// non-admin detection switched to [`cim_feature_command`].
pub fn powershell_feature_command(feature: &str) -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "Get-WindowsOptionalFeature -Online -FeatureName {feature} | ConvertTo-Json -Compress"
        ),
    ]
}

/// CIM argv to read a Windows optional feature's `InstallState`. Works for
/// NON-ADMIN users — `Get-WindowsOptionalFeature` / DISM cmdlets always fail
/// without elevation, which turned every non-admin doctor run into a WHPX
/// false alarm (confirmed on Windows 11 + QEMU 11.1). Pure.
pub fn cim_feature_command(feature: &str) -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "(Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name='{feature}'\").InstallState"
        ),
    ]
}

/// `Get-WindowsOptionalFeature` State values (Win32_OptionalFeature.InstallState
/// numbering; PowerShell may print either the number or the name).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureState {
    Enabled,  // 1
    Disabled, // 2
    Absent,   // 3
    Unknown,
}

impl FeatureState {
    pub fn from_raw(v: i64) -> Self {
        match v {
            1 => FeatureState::Enabled,
            2 => FeatureState::Disabled,
            3 => FeatureState::Absent,
            _ => FeatureState::Unknown,
        }
    }

    pub fn from_name(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "enabled" | "1" => FeatureState::Enabled,
            "disabled" | "2" => FeatureState::Disabled,
            "absent" | "3" => FeatureState::Absent,
            _ => FeatureState::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FeatureState::Enabled => "Enabled",
            FeatureState::Disabled => "Disabled",
            FeatureState::Absent => "Absent",
            FeatureState::Unknown => "Unknown",
        }
    }
}

/// Parse `Get-WindowsOptionalFeature … | ConvertTo-Json` output. Falls back to
/// the human-readable `State : 1` / `State : Enabled` layout (older shells,
/// `-Command` reformatting, localized setups). Pure.
pub fn parse_feature_state(stdout: &str) -> FeatureState {
    // 1) JSON: {"FeatureName":"HypervisorPlatform",…,"State":1,…}
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        match v.get("State") {
            Some(serde_json::Value::Number(n)) => {
                return FeatureState::from_raw(n.as_i64().unwrap_or(-1));
            }
            Some(serde_json::Value::String(s)) => return FeatureState::from_name(s),
            _ => {}
        }
    }
    // 2) Text: a line whose first token is "State" (name : value).
    for line in stdout.lines() {
        let mut it = line.trim().split(':');
        if it.next().map(|k| k.trim().eq_ignore_ascii_case("State")) == Some(true) {
            if let Some(v) = it.next() {
                let st = FeatureState::from_name(v);
                if st != FeatureState::Unknown {
                    return st;
                }
                // Numeric but unrecognized (e.g. 0) — still report what we saw.
                if let Ok(n) = v.trim().parse::<i64>() {
                    return FeatureState::from_raw(n);
                }
            }
        }
    }
    FeatureState::Unknown
}

/// Parse the stdout of [`cim_feature_command`]: PowerShell prints the bare
/// `InstallState` number on stdout. Real samples (non-admin Windows 11):
/// `1` → Enabled, `2` → Disabled, `3` → Absent; empty (no matching instance)
/// → Absent. Garbage (incl. PowerShell error text) → Unknown — this parser
/// never invents "Disabled" out of nothing; outright query failures are the
/// caller's concern (it maps them to Unknown before parsing). Pure.
pub fn parse_cim_install_state(stdout: &str) -> FeatureState {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return FeatureState::Absent;
    }
    match trimmed.parse::<i64>() {
        Ok(n) => FeatureState::from_raw(n),
        Err(_) => FeatureState::from_name(trimmed),
    }
}

// --------------------------------------------------------- QEMU discovery --

/// QEMU program name this crate looks for (platform-correct extension).
pub fn qemu_program_name() -> &'static str {
    crate::vm::qemu_binary_name()
}

/// Parse a PATH-style environment string (`;` on Windows, `:` elsewhere).
pub fn parse_path_env(path_env: &str) -> Vec<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    path_env
        .split(sep)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

/// All candidate directories that commonly hold qemu-system-x86_64 on Windows:
/// every PATH entry, scoop shims, winget links, chocolatey bin, and
/// `Program Files\QEMU`. Pure (env values are passed in) and testable.
pub fn candidate_qemu_dirs(
    path_env: &str,
    home: Option<&Path>,
    program_files: Option<&Path>,
    program_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = parse_path_env(path_env);
    if let Some(h) = home {
        dirs.push(h.join("scoop").join("shims"));
        dirs.push(
            h.join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        );
    }
    if let Some(pf) = program_files {
        dirs.push(pf.join("QEMU"));
        dirs.push(pf.join("qemu"));
    }
    if let Some(pd) = program_data {
        dirs.push(pd.join("chocolatey").join("bin"));
    }
    // Dedup, keep order (PATH first — the operator's explicit choice wins).
    let mut seen = std::collections::BTreeSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// First directory in `dirs` containing an existing `qemu-system-x86_64(.exe)`.
pub fn find_qemu_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    let name = qemu_program_name();
    for d in dirs {
        let p = d.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// qemu-img sits next to qemu-system-x86_64 in every distribution layout.
pub fn find_qemu_img_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "qemu-img.exe"
    } else {
        "qemu-img"
    };
    for d in dirs {
        let p = d.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

// ------------------------------------------------------------ WHPX probe ----

/// argv for the real WHPX probe. `-machine q35` — NOT `-machine none`, which
/// newer QEMU (11.1 confirmed on Windows 11) rejects with
/// "Object … is not an instance of type x86-machine". `-S` pauses the vCPUs;
/// with WHPX working QEMU then STAYS ALIVE, so a probe still running at the
/// timeout is the SUCCESS signature — see [`classify_whpx_probe`].
pub fn qemu_whpx_probe_command(qemu_bin: &Path) -> Vec<String> {
    vec![
        qemu_bin.display().to_string(),
        "-name".into(),
        "qemu-center-whpx-probe".into(),
        "-accel".into(),
        "whpx".into(),
        "-machine".into(),
        "q35".into(),
        "-display".into(),
        "none".into(),
        "-S".into(),
    ]
}

/// Verdict of the WHPX probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeVerdict {
    Available,
    NotAvailable(String),
    Unknown(String),
}

/// How a probe run ended — mirrors the two shapes of `exec::RunOutcome` that
/// matter for the q35 probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcomeKind {
    /// The process exited on its own; `exit_code` is meaningful.
    Exited,
    /// The process was still alive when the timeout hit and got killed. With
    /// `-machine q35 -S` and a working accelerator QEMU never exits — this is
    /// the SUCCESS signature, not a failure.
    TimedOut,
}

/// Classify a probe run. Pure. Rules (q35 probe, confirmed against QEMU 11.1):
/// * timed out (killed while alive) → **Available** — WHPX initialized and
///   QEMU kept running;
/// * exited 0 → Available (defensive: some QEMU builds may exit cleanly);
/// * exited nonzero with a stderr line carrying "whpx" → NotAvailable (e.g.
///   `-accel whpx: WHPX is not available on this platform`);
/// * anything else → Unknown, reported verbatim rather than guessed.
pub fn classify_whpx_probe(kind: ProbeOutcomeKind, exit_code: i32, stderr: &str) -> ProbeVerdict {
    match kind {
        ProbeOutcomeKind::TimedOut => ProbeVerdict::Available,
        ProbeOutcomeKind::Exited => {
            if exit_code == 0 {
                return ProbeVerdict::Available;
            }
            let err_line = stderr
                .lines()
                .rev()
                .find(|l| l.to_ascii_lowercase().contains("whpx"));
            match err_line {
                Some(l) => ProbeVerdict::NotAvailable(l.trim().to_string()),
                None => {
                    let tail = stderr
                        .lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("(no stderr)")
                        .trim();
                    ProbeVerdict::Unknown(format!(
                        "probe exited nonzero without a WHPX error: {tail}"
                    ))
                }
            }
        }
    }
}

// ------------------------------------------------------------ disk / tools --

/// CIM argv to read a logical disk's `FreeSpace`. Primary probe for the
/// disk-space check: PowerShell prints a bare locale-neutral integer, which
/// survives the app-spawn environment (codepage / locale / column-layout
/// drift) that broke the fsutil text parse — fsutil is kept only as a
/// fallback. `drive` includes the colon (`"F:"`). Pure.
pub fn cim_diskfree_command(drive: &str) -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "(Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='{drive}'\").FreeSpace"
        ),
    ]
}

/// Parse the stdout of [`cim_diskfree_command`]: PowerShell prints the bare
/// `FreeSpace` integer (real sample: `339468333056` + CRLF). Trim, require
/// all-digit output; empty or anything else (PowerShell error text, localized
/// noise) → None — the caller falls back to fsutil. Pure.
pub fn parse_cim_free_bytes(stdout: &str) -> Option<u64> {
    let t = stdout.trim();
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        t.parse::<u64>().ok()
    } else {
        None
    }
}

/// `fsutil volume diskfree <drive>` argv. Fallback probe — text parsing is
/// fragile under app-spawn environments (see [`cim_diskfree_command`]).
pub fn fsutil_diskfree_command(drive: &str) -> Vec<String> {
    vec![
        "fsutil".into(),
        "volume".into(),
        "diskfree".into(),
        drive.into(),
    ]
}

/// Parse `fsutil volume diskfree C:` — observed Windows output formats:
///   newer:  `Total free bytes :  96,967,008,256 ( 90.3 GB)`   (bytes outside parens)
///   older:  `Total free bytes :  890.5 GB (956,301,750,272 bytes)` (bytes inside parens)
/// Both lines carry exactly one large comma-grouped number; the human-readable
/// one always contains a `.` (e.g. `90.3`), so taking the **largest digit
/// candidate** on the line is correct for both. If no label line matches
/// (fsutil is localized on some systems), the first line that yields a
/// candidate is used — `diskfree`'s first line is always the free-byte count.
pub fn parse_fsutil_free_bytes(stdout: &str) -> Option<u64> {
    /// Largest pure-digit (comma-grouped) number on a line.
    fn largest_candidate(line: &str) -> Option<u64> {
        line.split_whitespace()
            .filter_map(|tok| {
                let cleaned: String = tok
                    .chars()
                    .filter(|c| c.is_ascii_digit() || *c == ',')
                    .collect();
                let digits = cleaned.replace(',', "");
                // Skip tokens that only became digits by stripping a '.' out
                // of a human-readable size AND are implausibly small either way;
                // the max below makes false candidates harmless.
                if digits.is_empty() {
                    None
                } else {
                    digits.parse::<u64>().ok()
                }
            })
            .max()
    }
    let mut fallback = None;
    for line in stdout.lines() {
        let lower = line.to_ascii_lowercase();
        let is_label =
            lower.starts_with("total") && lower.contains("free bytes") && !lower.contains("avail");
        if let Some(v) = largest_candidate(line) {
            if is_label {
                return Some(v);
            }
            if fallback.is_none() {
                fallback = Some(v);
            }
        }
    }
    fallback
}

/// First non-empty line of a command's stdout, trimmed and truncated to 80
/// chars — an inline diagnostic snippet, not a full transcript. Blank output
/// renders as `empty`. 80 CHARS (not bytes) so CJK output truncates cleanly.
/// Pure.
pub fn first_line_snippet(stdout: &str) -> String {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        "empty".to_string()
    } else {
        line.chars().take(80).collect()
    }
}

/// Detail for the disk-free check when neither probe yielded a number. It
/// carries BOTH commands' real stdout (first line, truncated) so the next
/// user-reported screenshot shows what each probe actually printed. Pure.
pub fn diskfree_unknown_detail(cim_stdout: &str, fsutil_stdout: &str) -> String {
    format!(
        "could not determine free space (cim: {}; fsutil: {})",
        first_line_snippet(cim_stdout),
        first_line_snippet(fsutil_stdout)
    )
}

/// Judge free bytes against [`MIN_FREE_BYTES`]. Pure.
pub fn judge_disk_free(free: Option<u64>) -> (CheckStatus, String) {
    match free {
        Some(b) if b >= MIN_FREE_BYTES => (
            CheckStatus::Ok,
            format!(
                "{:.1} GiB free (>= {} GiB)",
                b as f64 / (1 << 30) as f64,
                MIN_FREE_BYTES >> 30
            ),
        ),
        Some(b) => (
            CheckStatus::Fail,
            format!(
                "{:.1} GiB free, but at least {} GiB is needed for a node disk",
                b as f64 / (1 << 30) as f64,
                MIN_FREE_BYTES >> 30
            ),
        ),
        None => (
            CheckStatus::Unknown,
            "could not determine free space".into(),
        ),
    }
}

/// `where <exe>` (Windows) / `which <exe>` (Unix) argv.
pub fn where_command(exe: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["where".into(), exe.into()]
    } else {
        vec!["which".into(), exe.into()]
    }
}

/// First non-empty stdout line of a `where` run, if any. Pure.
pub fn parse_where_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

// ------------------------------------------------------------------ runtime --

/// State-dir writability probe (creates the dir and touches a file).
fn check_state_dir(state_dir: &Path) -> DoctorCheck {
    let mk = |status, detail, fix| DoctorCheck {
        id: "state-dir",
        title: "state directory writable",
        status,
        detail,
        fix,
    };
    match std::fs::create_dir_all(state_dir) {
        Ok(()) => {
            let probe = state_dir.join(".doctor-probe");
            match std::fs::write(&probe, b"ok") {
                Ok(()) => {
                    let _ = std::fs::remove_file(&probe);
                    mk(
                        CheckStatus::Ok,
                        state_dir.display().to_string(),
                        String::new(),
                    )
                }
                Err(e) => mk(
                    CheckStatus::Fail,
                    format!("cannot write into {}: {e}", state_dir.display()),
                    "check folder permissions or pass --state-dir".into(),
                ),
            }
        }
        Err(e) => mk(
            CheckStatus::Fail,
            format!("cannot create {}: {e}", state_dir.display()),
            "check folder permissions or pass --state-dir".into(),
        ),
    }
}

/// WHPX optional feature check (runtime shell-out + pure parse). Uses CIM so
/// the query works WITHOUT elevation; the old DISM-cmdlet command stays in
/// [`powershell_feature_command`] for the elevated `setup whpx` path.
fn check_whpx_feature() -> DoctorCheck {
    let mk = |status, detail, fix| DoctorCheck {
        id: "whpx-feature",
        title: "WHPX optional feature (HypervisorPlatform)",
        status,
        detail,
        fix,
    };
    let argv = cim_feature_command("HypervisorPlatform");
    let out = exec::run_command(&argv, std::time::Duration::from_secs(30));
    if out.timed_out {
        return mk(
            CheckStatus::Unknown,
            "CIM query timed out".into(),
            "run manually: (Get-CimInstance -ClassName Win32_OptionalFeature \
             -Filter \"Name='HypervisorPlatform'\").InstallState"
                .into(),
        );
    }
    if !out.success && out.stdout.trim().is_empty() {
        return mk(
            CheckStatus::Unknown,
            format!("CIM query failed: {}", out.stderr_last_line()),
            "run the command above manually to inspect".into(),
        );
    }
    match parse_cim_install_state(&out.stdout) {
        FeatureState::Enabled => mk(
            CheckStatus::Ok,
            "HypervisorPlatform is Enabled".into(),
            String::new(),
        ),
        st @ (FeatureState::Disabled | FeatureState::Absent) => mk(
            CheckStatus::Fail,
            format!("HypervisorPlatform state: {}", st.as_str()),
            "run `qemu-center setup whpx` (self-elevates; needs one reboot) — \
             or manually: DISM /Online /Enable-Feature /All /FeatureName:HypervisorPlatform"
                .into(),
        ),
        // Unparseable output must NOT become "Disabled" — that would repeat
        // the false-positive the CIM switch exists to fix.
        FeatureState::Unknown => mk(
            CheckStatus::Unknown,
            format!(
                "unrecognized CIM output: {:?}",
                out.stdout.trim().chars().take(80).collect::<String>()
            ),
            "run the CIM command above manually to inspect".into(),
        ),
    }
}

/// QEMU binary discovery check (includes the portable `<state-dir>/qemu`
/// candidate).
fn check_qemu_binary(state_dir: Option<&Path>) -> (DoctorCheck, Option<PathBuf>) {
    let dirs = candidate_qemu_dirs_with(state_dir);
    let mk = |status, detail, fix| DoctorCheck {
        id: "qemu-binary",
        title: "QEMU binary (qemu-system-x86_64)",
        status,
        detail,
        fix,
    };
    match find_qemu_in(&dirs) {
        Some(p) => (
            mk(
                CheckStatus::Ok,
                p.display().to_string(),
                String::new(),
            ),
            Some(p),
        ),
        None => (
            mk(
                CheckStatus::Fail,
                format!(
                    "{} not found on PATH, in known install locations, or in the portable <state-dir>/qemu folder",
                    qemu_program_name()
                ),
                "install via `qemu-center setup qemu` (default: portable into <state-dir>/qemu — \
                 nothing touches C:\\Program Files; `--machine` opts into a machine-wide install)"
                    .into(),
            ),
            None,
        ),
    }
}

/// Discover the QEMU binary from the current process environment (PATH +
/// known install locations). Back-compat: equals
/// [`discover_qemu_bin_with`]`(None)` — the portable `<state-dir>/qemu`
/// dir is NOT consulted. Shared by doctor and verify.
pub fn discover_qemu_bin() -> Option<PathBuf> {
    discover_qemu_bin_with(None)
}

/// Discover the QEMU binary, honoring the portable install dir
/// `<state_dir>/qemu` as the LAST candidate: environment candidates (PATH,
/// scoop shims, winget links, Program Files, choco) come first, so a
/// pre-existing machine-wide install still wins; on clean machines the
/// project-internal portable copy is what gets found.
pub fn discover_qemu_bin_with(state_dir: Option<&Path>) -> Option<PathBuf> {
    find_qemu_in(&candidate_qemu_dirs_with(state_dir))
}

/// qemu-img discovery with the same candidate order as
/// [`discover_qemu_bin_with`] (qemu-img ships next to qemu-system-x86_64 in
/// the portable layout too).
pub fn discover_qemu_img_with(state_dir: Option<&Path>) -> Option<PathBuf> {
    find_qemu_img_in(&candidate_qemu_dirs_with(state_dir))
}

/// Candidate dirs = [`candidate_qemu_dirs_from_env`] + the portable
/// `<state_dir>/qemu` dir appended last (deduped). Pure.
pub fn candidate_qemu_dirs_with(state_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = candidate_qemu_dirs_from_env();
    if let Some(sd) = state_dir {
        dirs.push(crate::setup::portable_qemu_dir(sd));
    }
    // Dedup, keep order.
    let mut seen = std::collections::BTreeSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// Candidate dirs built from this process's environment variables.
pub fn candidate_qemu_dirs_from_env() -> Vec<PathBuf> {
    candidate_qemu_dirs(
        &std::env::var("PATH").unwrap_or_default(),
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .as_deref(),
    )
}

/// The live WHPX probe — only meaningful when a QEMU binary exists.
fn check_whpx_probe(qemu_bin: Option<&Path>) -> DoctorCheck {
    let mk = |status, detail, fix| DoctorCheck {
        id: "whpx-accel",
        title: "WHPX acceleration probe (qemu -accel whpx)",
        status,
        detail,
        fix,
    };
    let Some(qemu_bin) = qemu_bin else {
        return mk(
            CheckStatus::Unknown,
            "skipped: QEMU binary not found".into(),
            "install QEMU first".into(),
        );
    };
    let argv = qemu_whpx_probe_command(qemu_bin);
    // Short budget ON PURPOSE: with a working WHPX the q35 probe never exits
    // (QEMU keeps running), so "killed at the deadline" IS the success
    // signature. 8 s is plenty for accelerator init.
    let out = exec::run_command(&argv, std::time::Duration::from_secs(8));
    let kind = if out.timed_out {
        ProbeOutcomeKind::TimedOut
    } else {
        ProbeOutcomeKind::Exited
    };
    match classify_whpx_probe(kind, out.exit_code, &out.stderr) {
        ProbeVerdict::Available => mk(
            CheckStatus::Ok,
            "WHPX acceleration available (q35 probe kept running with WHPX \
             initialized, or exited cleanly)"
                .into(),
            String::new(),
        ),
        ProbeVerdict::NotAvailable(line) => mk(
            CheckStatus::Fail,
            line,
            "ensure HypervisorPlatform is enabled AND Virtual Machine Platform / \
             Hyper-V conflicts are understood (see README 'WHPX 前置'); reboot after enabling"
                .into(),
        ),
        ProbeVerdict::Unknown(line) => mk(
            CheckStatus::Unknown,
            line,
            "inspect manually: run the probe command from --verbose output".into(),
        ),
    }
}

/// Disk space check for the drive that hosts the state dir. Primary probe is
/// the CIM `Win32_LogicalDisk.FreeSpace` query (a bare locale-neutral integer
/// — robust under app-spawn environments where fsutil's localized /
/// codepage-dependent text layout broke parsing); fsutil text parsing stays
/// as the fallback, and when BOTH fail the detail carries both stdout
/// snippets so the failure is self-diagnosing.
fn check_disk_free(state_dir: &Path) -> DoctorCheck {
    let mk = |status, detail, fix| DoctorCheck {
        id: "disk-free",
        title: "disk space (state dir drive)",
        status,
        detail,
        fix,
    };
    if !cfg!(windows) {
        return mk(
            CheckStatus::Unknown,
            "disk-space probes are Windows-only; skipped on this platform".into(),
            String::new(),
        );
    }
    // Derive the drive prefix from the state dir ("C:\..." or "\\?\C:\...").
    let drive = state_dir
        .to_string_lossy()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>();
    let drive = if drive.len() == 1 {
        format!("{drive}:")
    } else {
        "C:".to_string()
    };

    // Primary: CIM — structured, locale-neutral.
    let cim_argv = cim_diskfree_command(&drive);
    let cim_out = exec::run_command(&cim_argv, std::time::Duration::from_secs(20));
    let cim_free = if cim_out.success {
        parse_cim_free_bytes(&cim_out.stdout)
    } else {
        None
    };

    // Fallback: fsutil text parse (kept for hosts where the CIM cmdlet is
    // unavailable or blocked).
    let (free, fsutil_stdout) = match cim_free {
        Some(_) => (cim_free, String::new()),
        None => {
            let argv = fsutil_diskfree_command(&drive);
            let out = exec::run_command(&argv, std::time::Duration::from_secs(20));
            let free = if out.success {
                parse_fsutil_free_bytes(&out.stdout)
            } else {
                None
            };
            (free, out.stdout)
        }
    };

    let (status, detail) = match free {
        Some(_) => judge_disk_free(free),
        None => (
            CheckStatus::Unknown,
            diskfree_unknown_detail(&cim_out.stdout, &fsutil_stdout),
        ),
    };
    mk(
        status,
        detail,
        "free space or move --state-dir to a larger drive".into(),
    )
}

/// ssh / adb availability checks (`where`-only tools).
fn check_tool(id: &'static str, title: &'static str, exe: &str, required: bool) -> DoctorCheck {
    let argv = where_command(exe);
    let out = exec::run_command(&argv, std::time::Duration::from_secs(15));
    let (status, detail) = match parse_where_output(&out.stdout) {
        Some(p) if out.success => (CheckStatus::Ok, p),
        _ => (
            if required {
                CheckStatus::Fail
            } else {
                CheckStatus::Unknown
            },
            format!("{exe} not found"),
        ),
    };
    let fix = if required {
        format!(
            "install {exe} (Windows: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'; \
             adb ships with Android platform-tools)"
        )
    } else {
        format!("{exe} is optional but recommended ({title})")
    };
    DoctorCheck {
        id,
        title,
        status,
        detail,
        fix,
    }
}

/// qemu-img availability: `where` first, then the full discovery candidates
/// (covers the portable `<state-dir>/qemu` layout, where qemu-img ships next
/// to qemu-system-x86_64 but is not on PATH).
fn check_qemu_img(state_dir: Option<&Path>) -> DoctorCheck {
    let mk = |status, detail, fix| DoctorCheck {
        id: "qemu-img",
        title: "qemu-img (disks, snapshots, clones)",
        status,
        detail,
        fix,
    };
    let argv = where_command("qemu-img");
    let out = exec::run_command(&argv, std::time::Duration::from_secs(15));
    if let Some(p) = parse_where_output(&out.stdout).filter(|_| out.success) {
        return mk(CheckStatus::Ok, p, String::new());
    }
    match discover_qemu_img_with(state_dir) {
        Some(p) => mk(
            CheckStatus::Ok,
            p.display().to_string(),
            String::new(),
        ),
        None => mk(
            CheckStatus::Unknown,
            "qemu-img not found".to_string(),
            "install QEMU via `qemu-center setup qemu` (portable) — qemu-img ships in the same folder"
                .to_string(),
        ),
    }
}

/// Assemble the full report (the `doctor` entry point).
pub fn run_doctor(state_dir: &Path) -> DoctorReport {
    let mut checks = Vec::new();
    checks.push(check_state_dir(state_dir));
    checks.push(check_whpx_feature());
    let (qemu_check, qemu_bin) = check_qemu_binary(Some(state_dir));
    checks.push(qemu_check);
    checks.push(check_whpx_probe(qemu_bin.as_deref()));
    checks.push(check_disk_free(state_dir));
    checks.push(check_tool(
        "ssh",
        "OpenSSH client (guest provisioning)",
        "ssh",
        true,
    ));
    checks.push(check_tool(
        "adb",
        "adb (verify item 6, host-side)",
        "adb",
        false,
    ));
    checks.push(check_qemu_img(Some(state_dir)));
    DoctorReport {
        state_dir: state_dir.display().to_string(),
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- feature state parsing ---

    #[test]
    fn feature_command_uses_powershell_and_json() {
        let cmd = powershell_feature_command("HypervisorPlatform");
        assert_eq!(cmd[0], "powershell");
        assert!(cmd.iter().any(|a| a == "-NoProfile"));
        let full = cmd.join(" ");
        assert!(full.contains("Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform"));
        assert!(full.contains("ConvertTo-Json -Compress"));
    }

    #[test]
    fn feature_state_parses_json_output() {
        let json = r#"{"FeatureName":"HypervisorPlatform","DisplayName":"Windows Hypervisor Platform","Description":"...","RestartRequired":"Possible","State":1,"CustomProperties":[]}"#;
        assert_eq!(parse_feature_state(json), FeatureState::Enabled);
        let json2 = r#"{"FeatureName":"HypervisorPlatform","State":2,"CustomProperties":[]}"#;
        assert_eq!(parse_feature_state(json2), FeatureState::Disabled);
        let json3 = r#"{"FeatureName":"HypervisorPlatform","State":3,"CustomProperties":[]}"#;
        assert_eq!(parse_feature_state(json3), FeatureState::Absent);
    }

    #[test]
    fn feature_state_parses_text_output() {
        let text = "FeatureName     : HypervisorPlatform\n\
                    RestartRequired : Possible\n\
                    State           : 1\n";
        assert_eq!(parse_feature_state(text), FeatureState::Enabled);
        let text2 = "FeatureName : HypervisorPlatform\nState : Enabled\n";
        assert_eq!(parse_feature_state(text2), FeatureState::Enabled);
        let text3 = "State : Disabled\n";
        assert_eq!(parse_feature_state(text3), FeatureState::Disabled);
    }

    #[test]
    fn feature_state_unknown_when_unparseable() {
        assert_eq!(parse_feature_state(""), FeatureState::Unknown);
        assert_eq!(parse_feature_state("garbage"), FeatureState::Unknown);
        assert_eq!(parse_feature_state("{}"), FeatureState::Unknown);
        assert_eq!(parse_feature_state(r#"{"State":0}"#), FeatureState::Unknown);
    }

    // --- CIM feature state (non-admin path) ---

    #[test]
    fn cim_feature_command_uses_powershell_and_cim() {
        let cmd = cim_feature_command("HypervisorPlatform");
        assert_eq!(cmd[0], "powershell");
        assert!(cmd.iter().any(|a| a == "-NoProfile"));
        let full = cmd.join(" ");
        assert!(full.contains("Get-CimInstance -ClassName Win32_OptionalFeature"));
        assert!(full.contains("Name='HypervisorPlatform'"));
    }

    #[test]
    fn cim_install_state_parses_real_outputs() {
        // Real non-admin Windows 11 samples: a bare number, CRLF line ending,
        // and no output at all when the feature object does not exist.
        assert_eq!(parse_cim_install_state("1"), FeatureState::Enabled);
        assert_eq!(parse_cim_install_state("2"), FeatureState::Disabled);
        assert_eq!(parse_cim_install_state("3"), FeatureState::Absent);
        assert_eq!(parse_cim_install_state("1\r\n"), FeatureState::Enabled);
        assert_eq!(parse_cim_install_state(""), FeatureState::Absent);
        assert_eq!(parse_cim_install_state("   \n"), FeatureState::Absent);
    }

    #[test]
    fn cim_install_state_never_guesses_disabled_from_garbage() {
        // PowerShell error text and anything unparseable must stay Unknown.
        assert_eq!(
            parse_cim_install_state("Get-CimInstance : Access denied"),
            FeatureState::Unknown
        );
        assert_eq!(parse_cim_install_state("garbage"), FeatureState::Unknown);
        assert_eq!(parse_cim_install_state("0"), FeatureState::Unknown);
        assert_eq!(parse_cim_install_state("42"), FeatureState::Unknown);
        assert_eq!(parse_cim_install_state(" enabled "), FeatureState::Enabled);
    }

    // --- qemu discovery ---

    #[test]
    fn path_env_parsing_splits_and_dedups() {
        let dirs = candidate_qemu_dirs(
            "C:\\a;C:\\b;C:\\a",
            Some(Path::new("C:\\Users\\op")),
            Some(Path::new("C:\\Program Files")),
            Some(Path::new("C:\\ProgramData")),
        );
        assert!(dirs.contains(&PathBuf::from("C:\\a")));
        assert_eq!(
            dirs.iter()
                .filter(|d| **d == PathBuf::from("C:\\a"))
                .count(),
            1,
            "duplicates removed"
        );
        assert!(dirs.contains(&PathBuf::from("C:\\Users\\op\\scoop\\shims")));
        assert!(dirs.contains(&PathBuf::from("C:\\Program Files\\QEMU")));
        assert!(dirs.contains(&PathBuf::from("C:\\ProgramData\\chocolatey\\bin")));
        // PATH comes first: operator's explicit ordering wins.
        assert_eq!(dirs[0], PathBuf::from("C:\\a"));
    }

    #[test]
    fn find_qemu_requires_existing_file() {
        let tmp = std::env::temp_dir().join(format!("qc-doctor-{}", crate::vm::now_unix()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(find_qemu_in(&[tmp.clone()]), None);
        let exe = tmp.join(qemu_program_name());
        std::fs::write(&exe, b"stub").unwrap();
        assert_eq!(find_qemu_in(&[tmp.clone()]), Some(exe.clone()));
        assert_eq!(
            find_qemu_img_in(&[tmp.clone()]),
            None,
            "qemu-img not written"
        );
        std::fs::write(
            tmp.join(if cfg!(windows) {
                "qemu-img.exe"
            } else {
                "qemu-img"
            }),
            b"x",
        )
        .unwrap();
        assert!(find_qemu_img_in(&[tmp.clone()]).is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // --- portable discovery (state_dir/qemu candidate) ---

    #[test]
    fn candidates_with_state_dir_append_the_portable_qemu_dir() {
        let dirs = candidate_qemu_dirs_with(Some(Path::new("F:/repo/qemu-center/state")));
        let portable = PathBuf::from("F:/repo/qemu-center/state/qemu");
        assert!(dirs.contains(&portable));
        // Portable is the LAST candidate: a machine-wide install (PATH /
        // Program Files) still wins when both exist.
        assert_eq!(dirs.last(), Some(&portable));
        // Deduped when the operator already put the portable dir on PATH.
        let with_path = candidate_qemu_dirs_with(Some(Path::new("F:/repo/state")));
        let count = with_path
            .iter()
            .filter(|d| **d == PathBuf::from("F:/repo/state/qemu"))
            .count();
        assert_eq!(count, 1);
        // None = environment candidates only (back-compat surface).
        assert_eq!(
            candidate_qemu_dirs_with(None),
            candidate_qemu_dirs_from_env()
        );
    }

    #[test]
    fn discover_with_finds_the_portable_binary_and_qemu_img() {
        let state = std::env::temp_dir().join(format!("qc-portable-{}", crate::vm::now_unix()));
        let portable = state.join("qemu");
        std::fs::create_dir_all(&portable).unwrap();
        // No QEMU anywhere else in this test's candidate set (PATH may still
        // carry one, so assert on the dir-level scan, not global discovery).
        assert_eq!(find_qemu_in(&[portable.clone()]), None);
        let exe = portable.join(qemu_program_name());
        std::fs::write(&exe, b"stub").unwrap();
        std::fs::write(
            portable.join(if cfg!(windows) {
                "qemu-img.exe"
            } else {
                "qemu-img"
            }),
            b"stub",
        )
        .unwrap();
        // On a machine with no machine-wide QEMU, the portable copy is what
        // gets found (it is the only remaining candidate).
        if discover_qemu_bin_with(None).is_none() {
            assert_eq!(
                discover_qemu_bin_with(Some(&state)).as_deref(),
                Some(exe.as_path()),
                "portable dir is honored once it holds the binary"
            );
            assert!(discover_qemu_img_with(Some(&state)).is_some());
        }
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn discover_without_state_dir_is_environment_only() {
        // Back-compat: the None variant must not invent a portable candidate.
        // (Equality of candidate lists is covered above; here we only pin the
        // function identity contract.)
        assert_eq!(
            discover_qemu_bin_with(None).is_some(),
            discover_qemu_bin().is_some()
        );
    }

    // --- whpx probe ---

    #[test]
    fn probe_command_uses_q35_and_stays_safe_and_minimal() {
        let cmd =
            qemu_whpx_probe_command(Path::new("C:/Program Files/QEMU/qemu-system-x86_64.exe"));
        assert_eq!(cmd[0], "C:/Program Files/QEMU/qemu-system-x86_64.exe");
        let s = cmd.join(" ");
        assert!(s.contains("-accel whpx"));
        assert!(
            s.contains("-machine q35"),
            "QEMU 11.x rejects -machine none"
        );
        assert!(!s.contains("-machine none"));
        assert!(s.contains("-display none"));
        assert!(s.contains("-S"), "CPU paused — nothing actually executes");
    }

    #[test]
    fn probe_timed_out_means_available() {
        // The q35 probe with working WHPX never exits — killed at the timeout
        // is the success signature, even if some stderr dribbled out.
        assert_eq!(
            classify_whpx_probe(ProbeOutcomeKind::TimedOut, -1, ""),
            ProbeVerdict::Available
        );
        assert_eq!(
            classify_whpx_probe(ProbeOutcomeKind::TimedOut, -1, "warning: no -kernel"),
            ProbeVerdict::Available
        );
    }

    #[test]
    fn probe_exit_zero_means_available() {
        assert_eq!(
            classify_whpx_probe(ProbeOutcomeKind::Exited, 0, ""),
            ProbeVerdict::Available
        );
    }

    #[test]
    fn probe_classifies_whpx_failure() {
        let na = classify_whpx_probe(
            ProbeOutcomeKind::Exited,
            1,
            "qemu-system-x86_64.exe: -accel whpx: WHPX is not available on this platform\n",
        );
        assert!(matches!(na, ProbeVerdict::NotAvailable(l) if l.contains("WHPX is not available")));
        let na2 = classify_whpx_probe(
            ProbeOutcomeKind::Exited,
            1,
            "qemu: whpx: failed to initialize\nsome earlier warning\n",
        );
        assert!(matches!(na2, ProbeVerdict::NotAvailable(_)));
    }

    #[test]
    fn probe_unknown_without_whpx_error() {
        // Nonzero exit without a WHPX line (spawn failure, missing firmware…)
        // stays Unknown — never a false FAIL.
        let u = classify_whpx_probe(ProbeOutcomeKind::Exited, -1, "spawn failed: not found\n");
        assert!(matches!(u, ProbeVerdict::Unknown(l) if l.contains("spawn failed: not found")));
        let u2 = classify_whpx_probe(ProbeOutcomeKind::Exited, 1, "");
        assert!(matches!(u2, ProbeVerdict::Unknown(l) if l.contains("(no stderr)")));
        let u3 = classify_whpx_probe(ProbeOutcomeKind::Exited, 1, "cannot find bios.bin\n");
        assert!(matches!(u3, ProbeVerdict::Unknown(l) if l.contains("cannot find bios.bin")));
    }

    // --- disk ---

    #[test]
    fn fsutil_output_parse_all_observed_formats() {
        // Older Windows: bytes inside the parentheses.
        let older = "Total free bytes        : 890.5 GB (956,301,750,272 bytes)\n\
                     Total bytes             : 952.7 GB (1,022,964,203,520 bytes)\n\
                     Total quota free bytes  : 890.5 GB (956,301,750,272 bytes)\n";
        assert_eq!(parse_fsutil_free_bytes(older), Some(956_301_750_272));
        // Newer Windows (observed on build 26200): bytes outside the parens,
        // human-readable size inside.
        let newer = "Total free bytes                :  96,967,008,256 ( 90.3 GB)\n\
                     Total bytes                     : 510,987,857,920 (475.9 GB)\n\
                     Total quota free bytes          :  96,967,008,256 ( 90.3 GB)\n\
                     Unavailable pool bytes          :               0 (  0.0 KB)\n";
        assert_eq!(parse_fsutil_free_bytes(newer), Some(96_967_008_256));
        // Localized labels: fall back to the first line with a candidate
        // (diskfree's first line is always the free-byte count).
        let localized = "可用字节总数                :  96,967,008,256 ( 90.3 GB)\n\
                         字节总数                     : 510,987,857,920 (475.9 GB)\n";
        assert_eq!(parse_fsutil_free_bytes(localized), Some(96_967_008_256));
        assert_eq!(parse_fsutil_free_bytes("no match"), None);
        assert_eq!(parse_fsutil_free_bytes(""), None);
    }

    #[test]
    fn disk_free_judgement_thresholds() {
        let ok = judge_disk_free(Some(MIN_FREE_BYTES));
        assert_eq!(ok.0, CheckStatus::Ok);
        let low = judge_disk_free(Some(10 * 1024 * 1024 * 1024));
        assert_eq!(low.0, CheckStatus::Fail);
        assert!(low.1.contains("GiB is needed"));
        let unk = judge_disk_free(None);
        assert_eq!(unk.0, CheckStatus::Unknown);
    }

    #[test]
    fn cim_diskfree_command_builds_logicaldisk_query() {
        let cmd = cim_diskfree_command("F:");
        assert_eq!(cmd[0], "powershell");
        assert!(cmd.iter().any(|a| a == "-NoProfile"));
        let full = cmd.join(" ");
        assert!(full.contains("Get-CimInstance -ClassName Win32_LogicalDisk"));
        assert!(full.contains("DeviceID='F:'"), "drive with colon: {full}");
        assert!(full.ends_with(".FreeSpace"));
    }

    #[test]
    fn cim_free_bytes_parses_real_and_rejects_garbage() {
        // Real sample shape: bare integer + CRLF.
        assert_eq!(
            parse_cim_free_bytes("339468333056\r\n"),
            Some(339_468_333_056)
        );
        assert_eq!(parse_cim_free_bytes("339468333056"), Some(339_468_333_056));
        assert_eq!(
            parse_cim_free_bytes("  339468333056 \n"),
            Some(339_468_333_056)
        );
        // Empty / whitespace-only output (no matching instance).
        assert_eq!(parse_cim_free_bytes(""), None);
        assert_eq!(parse_cim_free_bytes("   \r\n"), None);
        // PowerShell error text and anything non-numeric → None (caller
        // falls back to fsutil; never invent a size).
        assert_eq!(
            parse_cim_free_bytes("Get-CimInstance : Access denied"),
            None
        );
        assert_eq!(parse_cim_free_bytes("not-a-number"), None);
        assert_eq!(parse_cim_free_bytes("12,345"), None);
        assert_eq!(parse_cim_free_bytes("339468333056 bytes"), None);
    }

    #[test]
    fn free_physical_memory_probe_parses_kib_without_accepting_noise() {
        assert_eq!(
            parse_free_physical_memory_kib("3145728\r\n"),
            Some(3 * 1024 * 1024 * 1024)
        );
        assert_eq!(
            parse_free_physical_memory_kib("  1024 \n"),
            Some(1024 * 1024)
        );
        assert_eq!(parse_free_physical_memory_kib(""), None);
        assert_eq!(parse_free_physical_memory_kib("Access denied"), None);
        assert_eq!(parse_free_physical_memory_kib("1,024"), None);
    }

    #[test]
    fn meminfo_available_parser_accepts_only_a_valid_memavailable_line() {
        assert_eq!(
            parse_meminfo_available_bytes("MemTotal: 16384000 kB\nMemAvailable: 3145728 kB\n"),
            Some(3 * 1024 * 1024 * 1024)
        );
        assert_eq!(parse_meminfo_available_bytes("MemFree: 1024 kB\n"), None);
        assert_eq!(
            parse_meminfo_available_bytes("MemAvailable: nope kB\n"),
            None
        );
    }

    #[test]
    fn free_physical_memory_command_is_a_locale_neutral_cim_query() {
        let command = free_physical_memory_command();
        assert_eq!(command[0], "powershell");
        assert!(command.iter().any(|arg| arg == "-NoProfile"));
        let joined = command.join(" ");
        assert!(joined.contains("Win32_OperatingSystem"));
        assert!(joined.contains("FreePhysicalMemory"));
    }

    #[test]
    fn diskfree_unknown_detail_carries_both_snippets_truncated() {
        let long = "x".repeat(120);
        let detail = diskfree_unknown_detail(&long, "");
        assert!(
            detail.starts_with("could not determine free space (cim: "),
            "{detail}"
        );
        assert!(detail.ends_with("; fsutil: empty)"), "{detail}");
        // Exactly 80 chars survive for the CIM snippet (plus the frame text).
        let cim_snip = detail
            .strip_prefix("could not determine free space (cim: ")
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        assert_eq!(cim_snip.len(), 80);
        assert_eq!(cim_snip, "x".repeat(80));
        // Error text shows up verbatim (first line, trimmed).
        let detail2 = diskfree_unknown_detail(
            "Get-CimInstance : The service cannot be started\nmore lines",
            "Total free bytes   : (garbage)",
        );
        assert!(
            detail2.contains("cim: Get-CimInstance : The service cannot be started;"),
            "{detail2}"
        );
        assert!(
            detail2.contains("fsutil: Total free bytes   : (garbage)"),
            "{detail2}"
        );
        // Blank stdout on both sides renders as `empty`.
        let blank = diskfree_unknown_detail("\r\n", "");
        assert_eq!(
            blank,
            "could not determine free space (cim: empty; fsutil: empty)"
        );
    }

    #[test]
    fn first_line_snippet_takes_first_line_and_80_chars() {
        // Multi-line output: only the first line matters.
        assert_eq!(first_line_snippet("one\ntwo\nthree"), "one");
        // Exactly 80 chars kept, the 81st+ dropped.
        assert_eq!(first_line_snippet(&"y".repeat(80)), "y".repeat(80));
        assert_eq!(first_line_snippet(&"y".repeat(81)).len(), 80);
        // 80 CHARS, not bytes: CJK truncation must not panic or split mid-char.
        let cjk: String = "设".repeat(100);
        assert_eq!(first_line_snippet(&cjk), "设".repeat(80));
        // CR from CRLF endings is trimmed away.
        assert_eq!(first_line_snippet("value\r"), "value");
        assert_eq!(first_line_snippet(""), "empty");
    }

    // --- where/tool discovery ---

    #[test]
    fn where_command_and_parse() {
        let cmd = if cfg!(windows) {
            vec!["where".to_string(), "ssh".to_string()]
        } else {
            vec!["which".to_string(), "ssh".to_string()]
        };
        assert_eq!(where_command("ssh"), cmd);
        assert_eq!(
            parse_where_output("C:\\Windows\\System32\\OpenSSH\\ssh.exe\n"),
            Some("C:\\Windows\\System32\\OpenSSH\\ssh.exe".to_string())
        );
        assert_eq!(parse_where_output("\n \n"), None);
    }

    // --- report rendering ---

    #[test]
    fn report_text_and_json_rendering() {
        let report = DoctorReport {
            state_dir: "C:/qc".into(),
            checks: vec![
                DoctorCheck {
                    id: "whpx-feature",
                    title: "WHPX optional feature (HypervisorPlatform)",
                    status: CheckStatus::Ok,
                    detail: "Enabled".into(),
                    fix: String::new(),
                },
                DoctorCheck {
                    id: "qemu-binary",
                    title: "QEMU binary (qemu-system-x86_64)",
                    status: CheckStatus::Fail,
                    detail: "not found".into(),
                    fix: "winget install SoftwareFreedomConservancy.Qemu".into(),
                },
            ],
        };
        let text = report.to_text();
        assert!(text.contains("[ ok ] whpx-feature"));
        assert!(text.contains("[FAIL] qemu-binary"));
        assert!(text.contains("fix: winget install"));
        assert!(text.contains("summary: 1 ok / 1 fail / 0 unknown"));
        let json = report.to_json().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["checks"][0]["status"], "ok");
        assert_eq!(v["checks"][1]["status"], "fail");
        assert_eq!(v["state_dir"], "C:/qc");
    }

    #[test]
    fn check_status_markers_are_distinct() {
        let a = CheckStatus::Ok.marker();
        let b = CheckStatus::Fail.marker();
        let c = CheckStatus::Unknown.marker();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }
}
