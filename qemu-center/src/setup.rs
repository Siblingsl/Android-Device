//! `setup` subcommand family: one-shot host preparation so end users never
//! have to hand-run DISM/winget/download commands.
//!
//! Automation boundary (honest): the *only* steps Windows itself forces are
//! one UAC confirmation per elevated command and one reboot after enabling
//! WHPX — everything else is fully automated here. Every argv builder and
//! output parser is a pure, unit-tested function; the actual DISM/winget/
//! Direct downloads are fail-closed where a trusted digest is required;
//! package-manager channels remain delegated to the platform trust store.

use serde::Serialize;

use crate::doctor::{self, FeatureState};
use crate::exec;

/// State-dir subdirectory that holds downloaded cloud images.
pub const IMAGES_DIR_NAME: &str = "images";

/// Direct NSIS downloads require an operator-pinned digest before execution.
pub const QEMU_INSTALLER_SHA256_ENV: &str = "RDC_QEMU_INSTALLER_SHA256";

/// Canonical Ubuntu cloud image URLs (README documents these as placeholders
/// that follow the upstream cloud-images.ubuntu.com current pages).
pub fn image_url(distro: &str) -> Option<&'static str> {
    match distro {
        "jammy" => {
            Some("https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img")
        }
        "noble" => {
            Some("https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img")
        }
        _ => None,
    }
}

/// The SHA256SUMS companion file for a distro (upstream publishes it next to
/// the image; we parse the image's line out of it rather than hard-coding a
/// digest that upstream rotates).
pub fn sha256sums_url(distro: &str) -> Option<&'static str> {
    match distro {
        "jammy" => Some("https://cloud-images.ubuntu.com/jammy/current/SHA256SUMS"),
        "noble" => Some("https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"),
        _ => None,
    }
}

pub fn image_file_name(distro: &str) -> Option<&'static str> {
    image_url(distro).map(|u| u.rsplit('/').next().unwrap_or(u))
}

// ------------------------------------------------------------- DISM / WHPX ---

/// DISM enabling HypervisorPlatform with /NoRestart so the process does not
/// reboot the machine underneath the user; `setup` prints the reboot notice.
pub fn dism_enable_command() -> Vec<String> {
    vec![
        "dism.exe".into(),
        "/Online".into(),
        "/Enable-Feature".into(),
        "/All".into(),
        "/FeatureName:HypervisorPlatform".into(),
        "/NoRestart".into(),
    ]
}

/// PowerShell wrapper that re-runs this same binary elevated (`-Verb RunAs`).
/// `args` are the subcommand tokens, e.g. ["setup", "whpx"].
pub fn elevate_command(self_exe: &str, args: &[&str]) -> Vec<String> {
    let quoted_args = std::iter::once(self_exe.to_string())
        .chain(args.iter().map(|a| a.to_string()))
        .map(|a| format!("'{}'", powershell_literal(&a)))
        .collect::<Vec<_>>()
        .join(",");
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "Start-Process -FilePath '{}' -ArgumentList {quoted_args} -Verb RunAs -Wait",
            powershell_literal(self_exe)
        ),
    ]
}

/// How a DISM enable run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DismOutcome {
    /// Feature was enabled this run; reboot still required for WHPX.
    Completed,
    /// Feature was already enabled (incl. the 1168 "not applicable" case).
    AlreadyEnabled,
    /// Output explicitly asks for a restart to finish the operation.
    NeedsRestart,
    /// Could not classify — surface the raw tail to the user.
    Unknown,
}

/// Classify DISM output. DISM prints localized text; we match the stable
/// English markers and their common Chinese equivalents, plus exit-code
/// semantics (0 = completed, 3010 = success+restart, 1168 = already enabled /
/// not applicable). Unmatched output degrades to `Unknown` rather than a
/// false claim of success.
pub fn classify_dism_output(exit_code: i32, stdout: &str) -> DismOutcome {
    let hay = format!("{stdout}").to_lowercase();
    let mentions_restart =
        hay.contains("restart") || hay.contains("重启") || hay.contains("重新启动");
    match exit_code {
        0 => {
            if mentions_restart {
                DismOutcome::NeedsRestart
            } else {
                DismOutcome::Completed
            }
        }
        3010 => DismOutcome::NeedsRestart,
        // 1168: ERROR_NOT_FOUND — "the feature is not applicable"/already on.
        1168 => DismOutcome::AlreadyEnabled,
        _ => {
            if hay.contains("already enabled") || hay.contains("已经启用") || hay.contains("已启用")
            {
                DismOutcome::AlreadyEnabled
            } else if hay.contains("completed successfully") || hay.contains("操作成功完成") {
                DismOutcome::Completed
            } else if mentions_restart {
                DismOutcome::NeedsRestart
            } else {
                DismOutcome::Unknown
            }
        }
    }
}

/// Run one setup step that needs elevation: spawn a detached elevated copy of
/// this binary and wait for it via the PowerShell -Wait wrapper. Returns the
/// wrapper's outcome (the elevated child's own stdout is its own console-free
/// window; we therefore also write a marker file the caller can read — see
/// `run_elevated_capture`).
pub fn run_elevated_capture(
    state_dir: &std::path::Path,
    self_exe: &str,
    args: &[&str],
    marker_name: &str,
) -> Result<String, String> {
    let marker = state_dir.join(marker_name);
    let _ = std::fs::remove_file(&marker);
    let argv = vec![
        "powershell".to_string(),
        "-NoProfile".to_string(),
        "-Command".to_string(),
        format!(
            "Start-Process -FilePath '{}' -ArgumentList {} -Verb RunAs -Wait",
            powershell_literal(self_exe),
            args.iter()
                .map(|arg| format!("'{}'", powershell_literal(arg)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    ];
    let out = exec::run_command(&argv, std::time::Duration::from_secs(3600));
    if out.timed_out {
        return Err("elevated run timed out (UAC dialog unanswered?)".into());
    }
    std::fs::read_to_string(&marker).map_err(|e| {
        format!(
            "elevated run produced no marker ({}): {} — UAC declined?",
            marker.display(),
            e
        )
    })
}

/// The elevated child writes its own DISM output into a marker file so the
/// non-elevated parent can report it. This is the child-side helper.
pub fn write_marker(state_dir: &std::path::Path, marker_name: &str, body: &str) {
    let _ = std::fs::create_dir_all(state_dir);
    let _ = std::fs::write(state_dir.join(marker_name), body);
}

// ----------------------------------------------------------------- QEMU -----

/// winget silent install (primary channel).
pub fn winget_install_command() -> Vec<String> {
    vec![
        "winget".into(),
        "install".into(),
        "--id".into(),
        "SoftwareFreedomConservancy.Qemu".into(),
        "--silent".into(),
        "--accept-package-agreements".into(),
        "--accept-source-agreements".into(),
    ]
}

/// scoop fallback (no UAC needed for user-scope scoop).
pub fn scoop_install_command() -> Vec<String> {
    vec!["scoop".into(), "install".into(), "qemu".into()]
}

/// choco fallback (needs an elevated shell, but not self-elevated here).
pub fn choco_install_command() -> Vec<String> {
    vec![
        "choco".into(),
        "install".into(),
        "qemu".into(),
        "-y".into(),
        "--no-progress".into(),
    ]
}

/// Last-resort machine-wide channel: NSIS installer from the QEMU Windows
/// builds page, executed with its silent flag (installs to the machine
/// default, typically `C:\Program Files\QEMU`). Only reached via
/// `setup qemu --machine`; the default is the portable install below. The
/// URL tracks the well-known `weilnetz` build site; it may drift — the
/// command builder takes the URL so callers can pin a version.
pub fn nsis_install_command(installer_path: &std::path::Path) -> Vec<String> {
    vec![installer_path.display().to_string(), "/S".into()]
}

// -------------------------------------------------------- portable QEMU -----

/// State-dir subdirectory holding the portable QEMU installation
/// (`<state-dir>/qemu/qemu-system-x86_64.exe`). Everything stays inside the
/// project; nothing is written to `C:\Program Files`.
pub const PORTABLE_QEMU_DIR_NAME: &str = "qemu";

/// State-dir subdirectory used as scratch space for installer downloads
/// (cleaned up after a successful portable install).
pub const TMP_DIR_NAME: &str = "tmp";

/// Directory listing page of the well-known Weilnetz QEMU Windows builds —
/// upstream of every `qemu-w64-setup-*.exe` release.
pub const WEILNETZ_LISTING_URL: &str = "https://qemu.weilnetz.de/w64/";

/// `<state-dir>/qemu` — the default portable install target.
pub fn portable_qemu_dir(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join(PORTABLE_QEMU_DIR_NAME)
}

/// NSIS silent install into `target_dir`. The `/D=<dir>` switch MUST be the
/// last argument (NSIS ignores everything after it), so the argv is exactly
/// `[installer, "/S", "/D=<target>"]` — the whole path travels as one argv
/// element, which is how NSIS tolerates paths without needing (unreliable)
/// quoting.
pub fn nsis_portable_command(
    installer: &std::path::Path,
    target_dir: &std::path::Path,
) -> Vec<String> {
    vec![
        installer.display().to_string(),
        "/S".into(),
        format!("/D={}", target_dir.display()),
    ]
}

/// Validate a portable install target. NSIS `/D=` handling of paths with
/// whitespace is unreliable across the shell/quoting layers we go through,
/// so such targets are rejected up front with actionable guidance instead of
/// failing mid-install with a cryptic NSIS error.
pub fn validate_portable_target(dir: &std::path::Path) -> Result<(), String> {
    let text = dir.to_string_lossy().into_owned();
    if text.chars().any(char::is_whitespace) {
        return Err(format!(
            "portable install target {text:?} contains whitespace; NSIS /D= cannot take it reliably. \
             Move the repository to a whitespace-free path (e.g. C:\\dev\\Android-Device), \
             pass a --state-dir without spaces, or use `setup qemu --machine` (machine-wide install)."
        ));
    }
    Ok(())
}

/// Extract the newest `qemu-w64-setup-<date>.exe` file name from the Weilnetz
/// w64 directory listing HTML. Hand-rolled scan (no regex dependency — crate
/// red line): every occurrence of the name pattern is collected regardless of
/// whether it sits in an `href`, in link text, in either quote style, and the
/// largest date digits win. Returns the plain file name; combine with
/// [`weilnetz_installer_url`].
pub fn parse_weilnetz_listing(html: &str) -> Option<String> {
    const HEAD: &str = "qemu-w64-setup-";
    const TAIL: &str = ".exe";
    let mut best: Option<(u64, String)> = None;
    let mut rest = html;
    while let Some(pos) = rest.find(HEAD) {
        let after = &rest[pos + HEAD.len()..];
        let digits_end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        if digits_end >= 8 && after[digits_end..].starts_with(TAIL) {
            if let Ok(date) = after[..digits_end].parse::<u64>() {
                let newer = best.as_ref().map_or(true, |(d, _)| date > *d);
                if newer {
                    best = Some((date, format!("{HEAD}{}{TAIL}", &after[..digits_end])));
                }
            }
        }
        rest = after;
    }
    best.map(|(_, name)| name)
}

/// Full download URL for a listing entry (the page links are same-dir
/// relative).
pub fn weilnetz_installer_url(file_name: &str) -> String {
    format!("{WEILNETZ_LISTING_URL}{file_name}")
}

/// Idempotency plan for the default (portable) `setup qemu`. Pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableQemuPlan {
    /// `<state-dir>/qemu` already holds qemu-system-x86_64 — nothing to do.
    AlreadyInstalled,
    /// Target path has whitespace — refuse and print guidance.
    BlockedByWhitespace,
    /// Download listing → installer → NSIS `/S /D=<state>/qemu`.
    PortableInstall,
}

/// Decide the portable flow from the target dir + whether the QEMU binary is
/// already present. Pure.
pub fn portable_qemu_plan(
    target_dir: &std::path::Path,
    qemu_exe_present: bool,
) -> PortableQemuPlan {
    if qemu_exe_present {
        PortableQemuPlan::AlreadyInstalled
    } else if validate_portable_target(target_dir).is_err() {
        PortableQemuPlan::BlockedByWhitespace
    } else {
        PortableQemuPlan::PortableInstall
    }
}

/// IWR download command. PowerShell is the zero-dependency HTTPS transport
/// (std has none); SilentlyContinue speeds it up ~10x on Windows PowerShell.
pub fn download_command(url: &str, dest: &std::path::Path) -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
            powershell_literal(url),
            powershell_literal(&dest.display().to_string())
        ),
    ]
}

pub fn get_file_hash_command(path: &std::path::Path) -> Vec<String> {
    vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-Command".into(),
        format!(
            "(Get-FileHash -Algorithm SHA256 -LiteralPath '{}').Hash.ToLowerInvariant()",
            powershell_literal(&path.display().to_string())
        ),
    ]
}

pub fn powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn validate_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Extract the expected digest for `file_name` from an upstream SHA256SUMS
/// body (`<hash>  <file>` lines, `*` binary-marker tolerated).
pub fn expected_sha256_from_sums(sums_body: &str, file_name: &str) -> Option<String> {
    for line in sums_body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let file = it.next()?;
        let file = file.trim_start_matches('*');
        if file == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_lowercase());
        }
    }
    None
}

/// Compare actual vs expected digest (both normalized lowercase hex).
pub fn sha_matches(actual: &str, expected: &str) -> bool {
    let a = actual.trim().to_lowercase();
    let e = expected.trim().to_lowercase();
    a.len() == 64 && a == e
}

// ------------------------------------------------------------ precheck ------

/// What `vm create` needs that `setup` can provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Prereq {
    WhpxFeature,
    QemuBinary,
    CloudImage,
}

impl Prereq {
    pub fn id(self) -> &'static str {
        match self {
            Prereq::WhpxFeature => "whpx-feature",
            Prereq::QemuBinary => "qemu-binary",
            Prereq::CloudImage => "cloud-image",
        }
    }

    /// The `qemu-center setup ...` hint for a missing prerequisite.
    pub fn setup_hint(self) -> &'static str {
        match self {
            Prereq::WhpxFeature => "qemu-center setup whpx",
            Prereq::QemuBinary => "qemu-center setup qemu",
            Prereq::CloudImage => "qemu-center setup image",
        }
    }
}

/// Non-elevated precheck used by `vm create` (and `setup all`).
pub struct PrereqState {
    pub whpx_enabled: bool,
    pub qemu_found: bool,
    pub image_present: bool,
}

pub fn precheck(state_dir: &std::path::Path, image: &std::path::Path) -> PrereqState {
    // WHPX feature state via the doctor's CIM plumbing — this precheck runs
    // NON-ELEVATED (`vm create` / `setup all`), and the old
    // `Get-WindowsOptionalFeature` command fails for every non-admin user,
    // which used to turn the prereq check into a false alarm. The elevated
    // `setup whpx` path still uses the old command; the two do not conflict.
    let whpx_enabled = {
        let argv = doctor::cim_feature_command("HypervisorPlatform");
        let out = exec::run_command(&argv, std::time::Duration::from_secs(30));
        matches!(
            doctor::parse_cim_install_state(&out.stdout),
            FeatureState::Enabled
        )
    };
    let qemu_found = doctor::discover_qemu_bin_with(Some(state_dir)).is_some();
    PrereqState {
        whpx_enabled,
        qemu_found,
        image_present: image.is_file(),
    }
}

/// Missing prerequisites in stable order (whpx, qemu, image).
pub fn missing_prereqs(state: &PrereqState) -> Vec<Prereq> {
    let mut v = Vec::new();
    if !state.whpx_enabled {
        v.push(Prereq::WhpxFeature);
    }
    if !state.qemu_found {
        v.push(Prereq::QemuBinary);
    }
    if !state.image_present {
        v.push(Prereq::CloudImage);
    }
    v
}

/// The state machine `setup whpx` walks. Pure so it is fully testable.
pub fn whpx_plan(current: FeatureState) -> WhpxAction {
    match current {
        FeatureState::Enabled => WhpxAction::SkipAlreadyEnabled,
        FeatureState::Disabled | FeatureState::Absent => WhpxAction::EnableElevated,
        FeatureState::Unknown => WhpxAction::EnableElevated,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WhpxAction {
    SkipAlreadyEnabled,
    EnableElevated,
}

/// Channel selection for `setup qemu`, decided from what exists on PATH.
pub fn qemu_channel_plan(
    winget_present: bool,
    scoop_present: bool,
    choco_present: bool,
) -> QemuChannel {
    if winget_present {
        QemuChannel::Winget
    } else if scoop_present {
        QemuChannel::Scoop
    } else if choco_present {
        QemuChannel::Choco
    } else {
        QemuChannel::NsisDownload
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QemuChannel {
    Winget,
    Scoop,
    Choco,
    NsisDownload,
}

impl QemuChannel {
    pub fn label(self) -> &'static str {
        match self {
            QemuChannel::Winget => "winget",
            QemuChannel::Scoop => "scoop",
            QemuChannel::Choco => "choco",
            QemuChannel::NsisDownload => "direct NSIS download (digest-pinned)",
        }
    }
}

/// Idempotency decision for `setup image`.
pub fn image_download_plan(
    existing_file: Option<&std::path::Path>,
    existing_sha: Option<&str>,
    expected_sha: Option<&str>,
) -> ImagePlan {
    match (existing_file, existing_sha, expected_sha) {
        (Some(p), Some(actual), Some(expected)) if sha_matches(actual, expected) => {
            ImagePlan::SkipVerified(p.to_path_buf())
        }
        _ => ImagePlan::Download,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImagePlan {
    /// File exists and its digest matched SHA256SUMS.
    SkipVerified(std::path::PathBuf),
    Download,
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- DISM command shape ---

    #[test]
    fn dism_command_targets_hypervisorplatform_without_reboot() {
        let argv = dism_enable_command();
        assert_eq!(argv[0], "dism.exe");
        assert!(argv.contains(&"/FeatureName:HypervisorPlatform".to_string()));
        assert!(argv.contains(&"/NoRestart".to_string()));
        assert!(argv.contains(&"/All".to_string()));
    }

    #[test]
    fn elevate_command_uses_runas_and_passes_subcommand() {
        let argv = elevate_command("C:\\bin\\qemu-center.exe", &["setup", "whpx"]);
        assert_eq!(argv[0], "powershell");
        let joined = argv.join(" ");
        assert!(joined.contains("-Verb RunAs"));
        assert!(joined.contains("-Wait"));
        assert!(joined.contains("qemu-center.exe"));
        assert!(joined.contains("'setup'"));
        assert!(joined.contains("'whpx'"));
    }

    // --- DISM output classification ---

    #[test]
    fn dism_completed_successfully() {
        let out = "Deployment Image Servicing and Management tool\r\n\
                   The operation completed successfully.\r\n";
        assert_eq!(classify_dism_output(0, out), DismOutcome::Completed);
    }

    #[test]
    fn dism_restart_required_via_exit_code_3010() {
        assert_eq!(
            classify_dism_output(3010, "The operation completed successfully."),
            DismOutcome::NeedsRestart
        );
    }

    #[test]
    fn dism_already_enabled_via_exit_code_1168() {
        assert_eq!(classify_dism_output(1168, ""), DismOutcome::AlreadyEnabled);
    }

    #[test]
    fn dism_chinese_output_is_classified() {
        assert_eq!(
            classify_dism_output(0, "操作成功完成。"),
            DismOutcome::Completed
        );
        assert_eq!(
            classify_dism_output(0, "必须重新启动计算机才能完成操作。"),
            DismOutcome::NeedsRestart
        );
        assert_eq!(
            classify_dism_output(5, "功能已经启用。"),
            DismOutcome::AlreadyEnabled
        );
    }

    #[test]
    fn dism_unrecognized_output_is_unknown_not_success() {
        assert_eq!(classify_dism_output(87, "error 87"), DismOutcome::Unknown);
    }

    // --- install channels ---

    #[test]
    fn winget_command_is_silent_and_accepts_agreements() {
        let argv = winget_install_command();
        assert_eq!(argv[0], "winget");
        assert!(argv.contains(&"--silent".to_string()));
        assert!(argv.contains(&"--accept-package-agreements".to_string()));
        assert!(argv.contains(&"--accept-source-agreements".to_string()));
        assert!(argv.contains(&"SoftwareFreedomConservancy.Qemu".to_string()));
    }

    #[test]
    fn fallback_channels_are_well_formed() {
        assert_eq!(scoop_install_command()[0], "scoop");
        assert_eq!(choco_install_command()[0], "choco");
        assert!(choco_install_command().contains(&"-y".to_string()));
    }

    #[test]
    fn nsis_command_uses_silent_flag() {
        let argv = nsis_install_command(std::path::Path::new("D:/dl/qemu-setup.exe"));
        assert!(argv[0].ends_with("qemu-setup.exe"));
        assert_eq!(argv[1], "/S");
    }

    // --- portable install (default channel) ---

    #[test]
    fn nsis_portable_command_puts_install_dir_last() {
        let argv = nsis_portable_command(
            std::path::Path::new("D:/dl/qemu-w64-setup-20250429.exe"),
            std::path::Path::new("F:/code/project/Android-Device/qemu-center/state/qemu"),
        );
        assert_eq!(argv.len(), 3);
        assert!(argv[0].ends_with("qemu-w64-setup-20250429.exe"));
        assert_eq!(argv[1], "/S");
        assert_eq!(
            argv[2],
            "/D=F:/code/project/Android-Device/qemu-center/state/qemu"
        );
        // NSIS rule: /D= must be the very last token (anything after it is
        // silently ignored by the installer).
        assert!(argv.last().unwrap().starts_with("/D="));
        assert_eq!(argv.iter().filter(|a| a.starts_with("/D=")).count(), 1);
    }

    #[test]
    fn portable_target_rejects_whitespace_with_guidance() {
        let spaced = std::path::Path::new("C:/Program Files/Android-Device/qemu-center/state/qemu");
        let err = validate_portable_target(spaced).unwrap_err();
        assert!(err.contains("whitespace"));
        assert!(err.contains("/D="), "explains the NSIS /D= reason");
        assert!(
            err.contains("--machine"),
            "offers the machine-wide escape hatch"
        );
        assert!(validate_portable_target(std::path::Path::new(
            "F:/code/project/Android-Device/qemu-center/state/qemu"
        ))
        .is_ok());
        assert!(validate_portable_target(std::path::Path::new("D:/qc/state/qemu")).is_ok());
    }

    #[test]
    fn weilnetz_listing_picks_the_newest_installer() {
        let html = r#"<html><body><pre>
<a href="qemu-w64-setup-20240313.exe">qemu-w64-setup-20240313.exe</a>
<a href="qemu-w64-setup-20241119.exe">qemu-w64-setup-20241119.exe</a>
<a href="qemu-w64-setup-20250429.exe">qemu-w64-setup-20250429.exe</a>
<a href="qemu-w64-setup-20230111.exe">qemu-w64-setup-20230111.exe</a>
<a href="qemu-w64-setup-20250429.sha512">qemu-w64-setup-20250429.sha512</a>
</pre></body></html>"#;
        assert_eq!(
            parse_weilnetz_listing(html).as_deref(),
            Some("qemu-w64-setup-20250429.exe")
        );
        // Date comparison is numeric, not string length: 2025 > 0999.
        let tricky = r#"<a href="qemu-w64-setup-20250429.exe">x</a>
                        <a href="qemu-w64-setup-09990101.exe">y</a>"#;
        assert_eq!(
            parse_weilnetz_listing(tricky).as_deref(),
            Some("qemu-w64-setup-20250429.exe")
        );
    }

    #[test]
    fn weilnetz_listing_tolerates_link_text_only_and_absolute_hrefs() {
        // Name outside an href (link text / plain listing) still parses.
        let text_only = "QEMU for Windows: qemu-w64-setup-20240801.exe (recommended)";
        assert_eq!(
            parse_weilnetz_listing(text_only).as_deref(),
            Some("qemu-w64-setup-20240801.exe")
        );
        // Single quotes and an absolute href both carry the same file name.
        let quoted = "<a href='https://qemu.weilnetz.de/w64/qemu-w64-setup-20250707.exe'>dl</a>";
        assert_eq!(
            parse_weilnetz_listing(quoted).as_deref(),
            Some("qemu-w64-setup-20250707.exe")
        );
    }

    #[test]
    fn weilnetz_listing_returns_none_when_no_installer_present() {
        assert_eq!(parse_weilnetz_listing(""), None);
        assert_eq!(parse_weilnetz_listing("<html>maintenance</html>"), None);
        // Too few date digits / unrelated exe must not match.
        assert_eq!(parse_weilnetz_listing("qemu-w64-setup-1234.exe"), None);
        assert_eq!(parse_weilnetz_listing("qemu-w64-setup-20250429.zip"), None);
    }

    #[test]
    fn weilnetz_installer_url_is_listing_relative() {
        assert_eq!(
            weilnetz_installer_url("qemu-w64-setup-20250429.exe"),
            "https://qemu.weilnetz.de/w64/qemu-w64-setup-20250429.exe"
        );
        assert!(WEILNETZ_LISTING_URL.ends_with("/w64/"));
    }

    #[test]
    fn portable_qemu_dir_sits_under_the_state_dir() {
        assert_eq!(
            portable_qemu_dir(std::path::Path::new("F:/repo/qemu-center/state")),
            std::path::PathBuf::from("F:/repo/qemu-center/state/qemu")
        );
    }

    #[test]
    fn portable_plan_prefers_already_installed_then_blocks_spaced_paths() {
        let clean = std::path::Path::new("F:/repo/qemu-center/state/qemu");
        let spaced = std::path::Path::new("C:/Program Files/qc/state/qemu");
        assert_eq!(
            portable_qemu_plan(clean, true),
            PortableQemuPlan::AlreadyInstalled
        );
        assert_eq!(
            portable_qemu_plan(clean, false),
            PortableQemuPlan::PortableInstall
        );
        assert_eq!(
            portable_qemu_plan(spaced, false),
            PortableQemuPlan::BlockedByWhitespace
        );
        // Already-present binary wins even on a spaced path (nothing to do).
        assert_eq!(
            portable_qemu_plan(spaced, true),
            PortableQemuPlan::AlreadyInstalled
        );
    }

    #[test]
    fn channel_plan_prefers_winget_then_scoop_then_choco() {
        assert_eq!(qemu_channel_plan(true, true, true), QemuChannel::Winget);
        assert_eq!(qemu_channel_plan(false, true, true), QemuChannel::Scoop);
        assert_eq!(qemu_channel_plan(false, false, true), QemuChannel::Choco);
        assert_eq!(
            qemu_channel_plan(false, false, false),
            QemuChannel::NsisDownload
        );
    }

    // --- image download + verification ---

    #[test]
    fn download_command_silences_progress_and_sets_outfile() {
        let argv = download_command(
            "https://example/x.img",
            std::path::Path::new("C:\\state\\images\\x.img"),
        );
        assert_eq!(argv[0], "powershell");
        let joined = argv.join(" ");
        assert!(joined.contains("SilentlyContinue"));
        assert!(joined.contains("Invoke-WebRequest"));
        assert!(joined.contains("x.img"));
        assert!(joined.contains("-UseBasicParsing"));
    }

    #[test]
    fn powershell_literals_escape_single_quotes() {
        assert_eq!(powershell_literal("C:\\state\\operator's"), "C:\\state\\operator''s");
    }

    #[test]
    fn installer_digest_must_be_a_sha256_hex_string() {
        let digest = "a".repeat(64);
        assert!(validate_sha256_hex(&digest));
        assert!(validate_sha256_hex(&digest.to_uppercase()));
        assert!(!validate_sha256_hex("short"));
        assert!(!validate_sha256_hex(&"g".repeat(64)));
    }

    #[test]
    fn hash_command_targets_sha256() {
        let argv = get_file_hash_command(std::path::Path::new("C:\\x.img"));
        let joined = argv.join(" ");
        assert!(joined.contains("Get-FileHash"));
        assert!(joined.contains("SHA256"));
        assert!(joined.contains("ToLowerInvariant"));
    }

    #[test]
    fn sha256sums_parsing_extracts_the_image_line() {
        let body = "#SHA256 1-focal amd64\n\
                    aaaabbbb1111222233334444555566667777888899990000aaaabbbb11112222  jammy-server-cloudimg-amd64.img\n\
                    ccccdddd1111222233334444555566667777888899990000aaaabbbb11112222*other.img\n";
        let got = expected_sha256_from_sums(body, "jammy-server-cloudimg-amd64.img");
        assert_eq!(
            got.as_deref(),
            Some("aaaabbbb1111222233334444555566667777888899990000aaaabbbb11112222")
        );
        assert_eq!(expected_sha256_from_sums(body, "missing.img"), None);
    }

    #[test]
    fn sha256sums_parsing_tolerates_binary_marker_and_comments() {
        let body = "# comment\nccccdddd1111222233334444555566667777888899990000aaaabbbb11112222 *noble-server-cloudimg-amd64.img\n";
        assert!(expected_sha256_from_sums(body, "noble-server-cloudimg-amd64.img").is_some());
    }

    #[test]
    fn sha_comparison_is_case_insensitive_and_length_checked() {
        let expected = "aaaabbbb1111222233334444555566667777888899990000aaaabbbb11112222";
        assert!(sha_matches(expected, expected));
        assert!(sha_matches(&expected.to_uppercase(), expected));
        assert!(!sha_matches("short", expected));
        assert!(!sha_matches("", expected));
    }

    #[test]
    fn image_urls_cover_both_distros_and_reject_others() {
        assert!(image_url("jammy").is_some());
        assert!(image_url("noble").is_some());
        assert_eq!(
            image_file_name("noble"),
            Some("noble-server-cloudimg-amd64.img")
        );
        assert_eq!(image_url("focal"), None);
        assert_eq!(
            sha256sums_url("noble").map(|u| u.ends_with("SHA256SUMS")),
            Some(true)
        );
    }

    // --- image idempotency ---

    #[test]
    fn image_plan_skips_verified_and_downloads_missing() {
        let p = std::path::Path::new("C:\\state\\images\\noble.img");
        let expected = "aaaabbbb1111222233334444555566667777888899990000aaaabbbb11112222";
        assert_eq!(
            image_download_plan(Some(p), Some(expected), Some(expected)),
            ImagePlan::SkipVerified(p.to_path_buf())
        );
        assert_eq!(
            image_download_plan(Some(p), Some("deadbeef"), Some(expected)),
            ImagePlan::Download
        );
        assert_eq!(
            image_download_plan(None, None, Some(expected)),
            ImagePlan::Download
        );
        assert_eq!(
            image_download_plan(Some(p), Some(expected), None),
            ImagePlan::Download
        );
    }

    // --- prereq matrix ---

    #[test]
    fn missing_prereqs_are_ordered_whpx_qemu_image() {
        let st = PrereqState {
            whpx_enabled: false,
            qemu_found: false,
            image_present: false,
        };
        let missing = missing_prereqs(&st);
        assert_eq!(
            missing.iter().map(|p| p.id()).collect::<Vec<_>>(),
            vec!["whpx-feature", "qemu-binary", "cloud-image"]
        );
        assert_eq!(missing[0].setup_hint(), "qemu-center setup whpx");
        assert_eq!(missing[1].setup_hint(), "qemu-center setup qemu");
        assert_eq!(missing[2].setup_hint(), "qemu-center setup image");
    }

    #[test]
    fn fully_ready_prereqs_yield_empty_missing_list() {
        let st = PrereqState {
            whpx_enabled: true,
            qemu_found: true,
            image_present: true,
        };
        assert!(missing_prereqs(&st).is_empty());
    }

    // --- whpx plan ---

    #[test]
    fn whpx_plan_skips_only_when_enabled() {
        use doctor::FeatureState;
        assert_eq!(
            whpx_plan(FeatureState::Enabled),
            WhpxAction::SkipAlreadyEnabled
        );
        assert_eq!(
            whpx_plan(FeatureState::Disabled),
            WhpxAction::EnableElevated
        );
        assert_eq!(whpx_plan(FeatureState::Absent), WhpxAction::EnableElevated);
        assert_eq!(whpx_plan(FeatureState::Unknown), WhpxAction::EnableElevated);
    }

    // --- url / filename helpers ---

    #[test]
    fn image_file_name_is_derived_from_url_tail() {
        assert_eq!(
            image_file_name("jammy"),
            Some("jammy-server-cloudimg-amd64.img")
        );
    }
}
