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
use crate::services::{adb, docker, qemu, settings};

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
}

fn item(id: &str, title: &str, done: bool, hint: &str, cta: &str) -> ReadinessItem {
    ReadinessItem {
        id: id.to_string(),
        title: title.to_string(),
        done,
        hint: hint.to_string(),
        cta: cta.to_string(),
    }
}

/// Pure: assemble the checklist from already-measured probe results. `whpx` is
/// `None` on non-Windows hosts (the item is omitted entirely) and on hosts
/// where the PowerShell probe could not answer.
pub fn build_checklist(
    docker_running: bool,
    adb_running: bool,
    scrcpy_ok: bool,
    whpx: Option<bool>,
    qemu_bin_found: bool,
    cloud_image_exists: bool,
) -> Vec<ReadinessItem> {
    let mut items = vec![
        item(
            "docker",
            "Docker 引擎",
            docker_running,
            "启动 Docker Desktop 后回到本页刷新（云机实例依赖它）",
            "/docker",
        ),
        item(
            "adb",
            "ADB 服务",
            adb_running,
            "在 ADB 页启动 adb server，否则任何设备都无法连接",
            "/adb",
        ),
        item(
            "scrcpy",
            "scrcpy 投屏工具",
            scrcpy_ok,
            "在「设置 → 工具与路径」里指定 scrcpy 可执行文件（或加入 PATH）",
            "/settings",
        ),
    ];
    if let Some(enabled) = whpx {
        items.push(item(
            "whpx",
            "WHPX 加速",
            enabled,
            "在 QEMU 节点页点「启用 WHPX」（需重启一次 Windows）",
            "/qemu",
        ));
    }
    items.push(item(
        "qemu-bin",
        "qemu-center 命令行",
        qemu_bin_found,
        "在仓库根执行 cargo build --manifest-path qemu-center/Cargo.toml，或设置 QEMU_CENTER_BIN",
        "/qemu",
    ));
    items.push(item(
        "cloud-image",
        "Ubuntu 云镜像",
        cloud_image_exists,
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

/// Runtime probe: WHPX optional feature. `None` on non-Windows hosts or when
/// PowerShell cannot answer (the item is then omitted instead of nagging).
#[cfg(target_os = "windows")]
fn probe_whpx() -> Option<bool> {
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
        return None;
    }
    parse_whpx_state(&result.stdout)
}

#[cfg(not(target_os = "windows"))]
fn probe_whpx() -> Option<bool> {
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
    build_checklist(
        docker::is_running_fast(),
        adb::server_status(),
        probe_scrcpy(&scrcpy_path),
        probe_whpx(),
        qemu::resolve_qemu_center_bin().is_some(),
        qemu::default_image_path().is_file(),
    )
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
}
