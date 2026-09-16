//! First-use readiness checklist ("待办清单") rendered on the Dashboard.
//!
//! Aggregates probes that already exist elsewhere — nothing is re-implemented:
//! - Docker engine running  → `docker::is_running_fast`
//! - ADB server running     → `adb::server_status`
//! - scrcpy binary usable   → settings path + a `--version` probe
//! - WHPX feature enabled   → PowerShell `Get-WindowsOptionalFeature` (the same
//!   query qemu-center's doctor uses; duplicated as a *simplified* probe on
//!   purpose — this crate must not import the qemu-center crate)
//! - qemu-center binary     → `qemu::resolve_qemu_center_bin`
//! - Ubuntu cloud image     → `qemu::default_image_path().exists()`
//! - Android image / ABI / GApps → existing image and preset validation
//!
//! Honest status split:
//! - ✅ unit-tested pure functions: item assembly (ids/routes/hints, done
//!   propagation) and the PowerShell WHPX state parser.
//! - ⚠️ runtime: `checklist()` shells out (docker / adb / scrcpy / powershell /
//!   `where`) — unverified in this environment.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::services::util::run_command_timeout;
use crate::services::{adb, docker, preset, qemu, settings};

/// One row of the first-use checklist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessItem {
    /// Stable id: docker | adb | scrcpy | whpx | qemu-bin | cloud-image.
    pub id: String,
    /// Short title (Chinese; the UI renders it as-is, like doctor checks).
    pub title: String,
    pub done: bool,
    /// One-line explanation of what to do when not done.
    pub hint: String,
    /// Frontend route the "去处理" button navigates to.
    pub cta: String,
    /// ready | action_required | unsupported | unknown.
    #[serde(default)]
    pub status: String,
    /// shared | docker | qemu.
    #[serde(default)]
    pub track: String,
    /// Concrete probe result or compatibility explanation.
    #[serde(default)]
    pub detail: String,
}

/// A probe result is deliberately richer than a boolean: a dependency can be
/// unavailable, unsupported on this host, or simply not answer in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeState {
    Ready,
    ActionRequired,
    Unsupported,
    Unknown,
}

impl ProbeState {
    fn status(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::ActionRequired => "action_required",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
        }
    }

    fn done(self) -> bool {
        matches!(self, Self::Ready)
    }
}

fn probe_state(ok: bool) -> ProbeState {
    if ok {
        ProbeState::Ready
    } else {
        ProbeState::ActionRequired
    }
}

fn item(
    id: &str,
    title: &str,
    state: ProbeState,
    track: &str,
    hint: &str,
    cta: &str,
) -> ReadinessItem {
    let detail = match state {
        ProbeState::Ready => format!("{title} 已就绪。"),
        ProbeState::ActionRequired => format!("未检测到可用的{title}，请按提示处理后重新检查。"),
        ProbeState::Unsupported => format!("当前运行环境不支持{title}，该能力不会被误报为可用。"),
        ProbeState::Unknown => format!("{title} 本次无法判定，可能是探测超时或系统未返回结果。"),
    };
    item_with_detail(id, title, state, track, hint, cta, detail)
}

fn item_with_detail(
    id: &str,
    title: &str,
    state: ProbeState,
    track: &str,
    hint: &str,
    cta: &str,
    detail: String,
) -> ReadinessItem {
    ReadinessItem {
        id: id.to_string(),
        title: title.to_string(),
        done: state.done(),
        hint: hint.to_string(),
        cta: cta.to_string(),
        status: state.status().to_string(),
        track: track.to_string(),
        detail,
    }
}

/// Pure: assemble the six core checklist rows from already-measured probe
/// results. whpx is None on non-Windows hosts and is omitted entirely.
pub fn build_checklist(
    docker_running: bool,
    adb_running: bool,
    scrcpy_ok: bool,
    whpx: Option<bool>,
    qemu_bin_found: bool,
    cloud_image_exists: bool,
) -> Vec<ReadinessItem> {
    build_checklist_with_states(
        probe_state(docker_running),
        probe_state(adb_running),
        probe_state(scrcpy_ok),
        whpx.map(probe_state),
        probe_state(qemu_bin_found),
        probe_state(cloud_image_exists),
    )
}

/// Pure: assemble the checklist from four-state probe results. The boolean
/// build_checklist wrapper remains for older callers and tests.
pub fn build_checklist_with_states(
    docker: ProbeState,
    adb: ProbeState,
    scrcpy: ProbeState,
    whpx: Option<ProbeState>,
    qemu_bin: ProbeState,
    cloud_image: ProbeState,
) -> Vec<ReadinessItem> {
    let mut items = vec![
        item(
            "docker",
            "Docker 引擎",
            docker,
            "docker",
            "启动 Docker Desktop 后回到本页刷新（云机实例依赖它）",
            "/docker",
        ),
        item(
            "adb",
            "ADB 服务",
            adb,
            "shared",
            "在 ADB 页启动 adb server，否则任何设备都无法连接",
            "/adb",
        ),
        item(
            "scrcpy",
            "scrcpy 投屏工具",
            scrcpy,
            "shared",
            "在「设置 → 工具与路径」里指定 scrcpy 可执行文件（或加入 PATH）",
            "/settings",
        ),
    ];
    if let Some(enabled) = whpx {
        items.push(item(
            "whpx",
            "WHPX 加速",
            enabled,
            "qemu",
            "在 QEMU 节点页点「启用 WHPX」（需重启一次 Windows）",
            "/qemu",
        ));
    }
    items.push(item(
        "qemu-bin",
        "qemu-center 命令行",
        qemu_bin,
        "qemu",
        "在仓库根执行 cargo build --manifest-path qemu-center/Cargo.toml，或设置 QEMU_CENTER_BIN",
        "/qemu",
    ));
    items.push(item(
        "cloud-image",
        "Ubuntu 云镜像",
        cloud_image,
        "qemu",
        "在 QEMU 节点页点「下载镜像」（QEMU 轨道的节点磁盘基于它）",
        "/qemu",
    ));
    items
}

/// Pure: extract the enabled/disabled verdict from
/// `Get-WindowsOptionalFeature … | ConvertTo-Json` output (JSON or the
/// human-readable `State : 1|2|3` / `State : Enabled|Disabled|Absent` layout).
/// `None` means "could not tell" — the caller then omits the item.
pub fn parse_whpx_state(stdout: &str) -> Option<bool> {
    let state_name = |raw: &str| -> Option<bool> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "enabled" | "1" => Some(true),
            "disabled" | "absent" | "2" | "3" => Some(false),
            _ => None,
        }
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        match v.get("State") {
            Some(serde_json::Value::Number(n)) => return state_name(&n.to_string()),
            Some(serde_json::Value::String(s)) => return state_name(s),
            _ => {}
        }
    }
    for line in stdout.lines() {
        let mut parts = line.trim().split(':');
        if parts
            .next()
            .map(|k| k.trim().eq_ignore_ascii_case("State"))
            == Some(true)
        {
            if let Some(value) = parts.next() {
                if let Some(verdict) = state_name(value) {
                    return Some(verdict);
                }
            }
        }
    }
    None
}

/// Map the existing GApps validator's error vocabulary onto the readiness
/// model. Version/ABI mismatches are unsupported combinations; malformed or
/// unreadable local assets are actionable setup problems.
pub fn classify_gapps_error(error: &str) -> ProbeState {
    if error.contains("版本") || error.contains("架构") {
        ProbeState::Unsupported
    } else {
        ProbeState::ActionRequired
    }
}

fn android_major_from_image(image: &str) -> Option<String> {
    let tag = image.rsplit(':').next()?.trim();
    let number = tag
        .split(|ch: char| !ch.is_ascii_digit())
        .find(|part| !part.is_empty())?;
    let major = number.parse::<u32>().ok()?;
    (5..=30).contains(&major).then(|| major.to_string())
}

fn append_capability_items(items: &mut Vec<ReadinessItem>) {
    let app_settings = settings::get();
    let image = app_settings.last_image.trim();
    let image_state = if image.is_empty() {
        ProbeState::ActionRequired
    } else if preset::validate_image(image).is_ok() {
        ProbeState::Ready
    } else {
        ProbeState::ActionRequired
    };
    let image_detail = if image_state == ProbeState::Ready {
        format!("目标镜像引用：{image}；实际拉取或读取会在创建时按所选轨道进行。")
    } else {
        "默认 Android 镜像引用为空或格式无效，请在创建表单中修正。".into()
    };
    items.push(item_with_detail(
        "android-image",
        "Android 基础镜像",
        image_state,
        "shared",
        "先使用无 GApps 的基础 Redroid 验证首台设备路径；镜像本身不会由体检自动下载。",
        "/containers?track=docker",
        image_detail,
    ));

    let abi_state = if cfg!(target_arch = "x86_64") {
        ProbeState::Ready
    } else {
        ProbeState::Unsupported
    };
    let abi_detail = if abi_state == ProbeState::Ready {
        "当前程序为 x86_64 构建；Docker/QEMU 的首版 Beta 目标 ABI 为 x86_64。".into()
    } else {
        format!(
            "当前程序架构为 {}；首版 Beta 只支持 x86_64/amd64 设备镜像。",
            std::env::consts::ARCH
        )
    };
    items.push(item_with_detail(
        "abi",
        "目标 ABI",
        abi_state,
        "shared",
        "使用 x86_64/amd64 Android 镜像；不要用 arm64 GApps 覆盖 x86_64 镜像。",
        "/containers?track=docker",
        abi_detail,
    ));

    let gapps_path = docker::resolve_gapps_zip("", image);
    let (gapps_state, gapps_detail) = if !app_settings.install_gapps {
        (
            ProbeState::Ready,
            "已关闭创建时 GApps 预装；基础 Redroid 首台设备路径不受影响。".into(),
        )
    } else if gapps_path.is_empty() {
        (
            ProbeState::ActionRequired,
            "已开启创建时 GApps 预装，但未找到本地 ZIP；如需先跑基础 Redroid，可关闭预装。".into(),
        )
    } else if let Some(target) = android_major_from_image(image) {
        match preset::validate_gapps(std::path::Path::new(&gapps_path), &target) {
            Ok(()) => (
                ProbeState::Ready,
                format!("已验证与 Android {target} / x86_64 匹配：{gapps_path}"),
            ),
            Err(error) => (classify_gapps_error(&error), error),
        }
    } else {
        (
            ProbeState::Unknown,
            format!("已找到 GApps：{gapps_path}，但无法从默认镜像引用判定 Android 版本。"),
        )
    };
    items.push(item_with_detail(
        "gapps",
        "GApps 预装包",
        gapps_state,
        "shared",
        "准备与 Android 版本匹配的 x86_64 MindTheGapps；应用不会自动下载，也不会把 ZIP 放进 Git。",
        "/settings",
        gapps_detail,
    ));
}

/// Runtime probe: WHPX optional feature. None on non-Windows hosts; a
/// Windows probe that cannot answer is retained as unknown so the user sees
/// an honest state instead of a missing row.
#[cfg(target_os = "windows")]
fn probe_whpx_state() -> Option<ProbeState> {
    let result = run_command_timeout(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform | ConvertTo-Json -Compress",
        ],
        Duration::from_secs(30),
    );
    if !result.success && result.stdout.trim().is_empty() {
        return Some(ProbeState::Unknown);
    }
    Some(
        parse_whpx_state(&result.stdout)
            .map(probe_state)
            .unwrap_or(ProbeState::Unknown),
    )
}

#[cfg(not(target_os = "windows"))]
fn probe_whpx_state() -> Option<ProbeState> {
    // WHPX is a Windows Hypervisor Platform feature: not applicable elsewhere.
    None
}

/// Runtime probe: does the configured scrcpy actually run? An absolute path is
/// checked on disk first; anything else (a bare name) is probed on PATH.
fn probe_scrcpy(path: &str) -> bool {
    let bin = path.trim();
    if bin.is_empty() {
        return false;
    }
    if Path::new(bin).is_file() {
        return true;
    }
    run_command_timeout(bin, &["--version"], Duration::from_secs(8)).success
}

/// Runtime: the full checklist. Every probe is best-effort — a failing probe
/// yields "not done" rather than an error, because this is onboarding UI.
pub fn checklist() -> Vec<ReadinessItem> {
    let scrcpy_path = settings::scrcpy_path();
    let qemu_bin = qemu::resolve_qemu_center_bin();
    let image_path = qemu::default_image_path();
    let scrcpy_ok = probe_scrcpy(&scrcpy_path);
    let mut items = build_checklist_with_states(
        probe_state(docker::is_running_fast()),
        probe_state(adb::server_status()),
        probe_state(scrcpy_ok),
        probe_whpx_state(),
        probe_state(qemu_bin.is_some()),
        probe_state(image_path.is_file()),
    );
    append_capability_items(&mut items);
    if let Some(entry) = items.iter_mut().find(|item| item.id == "scrcpy") {
        entry.detail = if scrcpy_ok {
            format!("已找到并可运行：{}", scrcpy_path.trim())
        } else if scrcpy_path.trim().is_empty() {
            "未配置 scrcpy 路径，也未在 PATH 中找到它。".into()
        } else {
            format!("已配置路径但无法运行：{}", scrcpy_path.trim())
        };
    }
    if let Some(entry) = items.iter_mut().find(|item| item.id == "qemu-bin") {
        entry.detail = match qemu_bin {
            Some(path) => format!("已找到：{}", path.display()),
            None => "未找到 qemu-center；可设置 QEMU_CENTER_BIN 或构建 qemu-center。".into(),
        };
    }
    if let Some(entry) = items.iter_mut().find(|item| item.id == "cloud-image") {
        entry.detail = if image_path.is_file() {
            format!("已找到：{}", image_path.display())
        } else {
            format!("未找到默认镜像：{}", image_path.display())
        };
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_green_checklist_has_every_item_done() {
        let items = build_checklist(true, true, true, Some(true), true, true);
        assert!(items.iter().all(|i| i.done));
        assert_eq!(
            items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["docker", "adb", "scrcpy", "whpx", "qemu-bin", "cloud-image"]
        );
        assert!(items.iter().all(|i| i.cta.starts_with('/')));
    }

    #[test]
    fn failing_probes_map_to_pending_items_with_hints() {
        let items = build_checklist(false, false, false, Some(false), false, false);
        assert!(items.iter().all(|i| !i.done));
        for it in &items {
            assert!(!it.hint.is_empty(), "pending item {} needs a hint", it.id);
        }
        let docker = items.iter().find(|i| i.id == "docker").unwrap();
        assert_eq!(docker.cta, "/docker");
        assert_eq!(items.iter().find(|i| i.id == "scrcpy").unwrap().cta, "/settings");
        assert_eq!(items.iter().find(|i| i.id == "whpx").unwrap().cta, "/qemu");
    }

    #[test]
    fn whpx_item_is_omitted_when_the_probe_cannot_answer() {
        let items = build_checklist(true, true, true, None, true, true);
        assert!(!items.iter().any(|i| i.id == "whpx"));
        assert_eq!(items.len(), 5);
    }

    #[test]
    fn whpx_state_parses_json_and_text_layouts() {
        assert_eq!(parse_whpx_state(r#"{"FeatureName":"HypervisorPlatform","State":1}"#), Some(true));
        assert_eq!(parse_whpx_state(r#"{"FeatureName":"HypervisorPlatform","State":2}"#), Some(false));
        assert_eq!(parse_whpx_state(r#"{"FeatureName":"x","State":"Enabled"}"#), Some(true));
        assert_eq!(parse_whpx_state("FeatureName : HypervisorPlatform\nState : Disabled"), Some(false));
        assert_eq!(parse_whpx_state("State : Enabled"), Some(true));
        assert_eq!(parse_whpx_state("State : Absent"), Some(false));
        assert_eq!(parse_whpx_state(""), None);
        assert_eq!(parse_whpx_state("Get-WindowsOptionalFeature : Access denied"), None);
        assert_eq!(parse_whpx_state(r#"{"FeatureName":"x","State":0}"#), None);
    }

    #[test]
    fn readiness_states_keep_track_scope_and_unknown_honest() {
        let items = build_checklist_with_states(
            ProbeState::Ready,
            ProbeState::ActionRequired,
            ProbeState::Unsupported,
            Some(ProbeState::Unknown),
            ProbeState::Unknown,
            ProbeState::Ready,
        );

        let docker = items.iter().find(|i| i.id == "docker").unwrap();
        assert_eq!(docker.status, "ready");
        assert_eq!(docker.track, "docker");
        assert!(docker.done);
        assert!(!docker.detail.is_empty());

        let adb = items.iter().find(|i| i.id == "adb").unwrap();
        assert_eq!(adb.status, "action_required");
        assert_eq!(adb.track, "shared");
        assert!(!adb.done);

        let scrcpy = items.iter().find(|i| i.id == "scrcpy").unwrap();
        assert_eq!(scrcpy.status, "unsupported");
        assert!(!scrcpy.done);

        let whpx = items.iter().find(|i| i.id == "whpx").unwrap();
        assert_eq!(whpx.status, "unknown");
        assert_eq!(whpx.track, "qemu");
        assert!(!whpx.done);

        let qemu_bin = items.iter().find(|i| i.id == "qemu-bin").unwrap();
        assert_eq!(qemu_bin.status, "unknown");
        assert!(!qemu_bin.done);
    }

    #[test]
    fn gapps_version_or_abi_mismatch_is_unsupported_but_bad_asset_is_actionable() {
        assert_eq!(
            classify_gapps_error("GApps Android 版本 [13] 与目标 Android 14 不兼容。"),
            ProbeState::Unsupported
        );
        assert_eq!(
            classify_gapps_error(r#"GApps 架构 ["arm64"] 不兼容；需要 x86_64。"#),
            ProbeState::Unsupported
        );
        assert_eq!(
            classify_gapps_error("GApps zip 无效"),
            ProbeState::ActionRequired
        );
    }
}
