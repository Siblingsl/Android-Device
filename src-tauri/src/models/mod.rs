use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub docker_running: bool,
    pub docker_version: String,
    pub adb_running: bool,
    pub adb_version: String,
    pub online_devices: u32,
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub memory_total_mb: u64,
    pub memory_used_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub serial: String,
    pub android_version: String,
    pub online: bool,
    pub cpu: String,
    pub ram: String,
    #[serde(default)]
    pub cpu_usage: f64,
    #[serde(default)]
    pub memory_usage: f64,
    #[serde(default)]
    pub memory_total_mb: u64,
    #[serde(default)]
    pub memory_used_mb: u64,
    #[serde(default)]
    pub resource_source: String,
    pub fps: f64,
    pub adb_status: String,
    pub scrcpy_status: String,
    pub docker_status: String,
    pub ip: String,
    pub mac: String,
    pub resolution: String,
    pub dpi: String,
    pub container_id: String,
    pub image: String,
    pub started_at: String,
    pub uptime: String,
    pub adb_port: u16,
    pub scrcpy_port: u16,
    #[serde(default)]
    pub data_volume: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceRequest {
    pub name: String,
    pub android_version: String,
    pub cpu: String,
    pub ram: String,
    pub resolution: String,
    pub dpi: String,
    pub adb_port: u16,
    pub scrcpy_port: u16,
    pub image: String,
    /// Overlay OpenGApps / MindTheGapps from a user-provided local zip.
    #[serde(default)]
    pub install_gapps: bool,
    #[serde(default)]
    pub gapps_zip: String,
    /// Build a Magisk-preset image (magiskd + Zygisk, modules, spoof props).
    #[serde(default)]
    pub install_magisk: bool,
    #[serde(default)]
    pub install_lsposed: bool,
    #[serde(default)]
    pub install_shamiko: bool,
    /// Optional spoof.conf profile path; empty = bundled default profile.
    #[serde(default)]
    pub spoof_profile: String,
    /// Packages to add to the Magisk denylist (hidden from these apps).
    #[serde(default)]
    pub hide_packages: Vec<String>,
    /// When false, skip adb wait_ready after docker run.
    #[serde(default = "default_true")]
    pub wait_adb: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerInfo {
    pub running: bool,
    pub version: String,
    pub images: Vec<DockerImage>,
    pub containers: Vec<DockerContainer>,
    pub cpu_usage: f64,
    pub memory_usage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub size: String,
    pub in_use: bool,
    pub is_rdc: bool,
    #[serde(default)]
    pub container_name: String,
    #[serde(default)]
    pub adb_serial: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub created: String,
    pub is_redroid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
    pub product: String,
    pub model: String,
    pub device: String,
    pub transport_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdbInfo {
    pub version: String,
    pub server_running: bool,
    pub devices: Vec<AdbDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub package_name: String,
    pub label: String,
    pub version_name: String,
    pub version_code: String,
    pub system_app: bool,
    pub enabled: bool,
    pub apk_path: String,
    pub first_install_time: String,
    pub last_update_time: String,
    pub size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: String,
    pub permissions: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub success: bool,
    pub path: String,
    pub base64: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMonitorRule {
    #[serde(default)]
    pub preset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_interval_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerts_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub language: String,
    pub auto_update: bool,
    pub log_path: String,
    pub screenshot_path: String,
    pub apk_path: String,
    pub proxy: String,
    pub docker_path: String,
    pub adb_path: String,
    pub scrcpy_path: String,
    /// Local OpenGApps / MindTheGapps zip (user-supplied, never bundled).
    #[serde(default)]
    pub gapps_zip_path: String,
    #[serde(default = "default_true")]
    pub install_gapps: bool,
    #[serde(default)]
    pub last_cpu: String,
    #[serde(default)]
    pub last_ram: String,
    #[serde(default)]
    pub last_resolution: String,
    #[serde(default)]
    pub last_dpi: String,
    #[serde(default)]
    pub last_image: String,
    /// Device ids that should docker-start + adb connect on app launch.
    #[serde(default)]
    pub auto_start_device_ids: Vec<String>,
    #[serde(default)]
    pub create_auto_start: bool,
    #[serde(default)]
    pub create_stay_on_form: bool,
    /// Default for create form: wait until ADB boot_completed.
    #[serde(default = "default_true")]
    pub create_wait_adb: bool,
    #[serde(default = "default_resource_alert_threshold")]
    pub resource_alert_threshold: f64,
    #[serde(default = "default_device_refresh_interval_secs")]
    pub device_refresh_interval_secs: u64,
    #[serde(default)]
    pub device_monitor_rules: BTreeMap<String, DeviceMonitorRule>,
}

fn default_resource_alert_threshold() -> f64 {
    80.0
}

fn default_device_refresh_interval_secs() -> u64 {
    10
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let base = home.join("RedroidDeviceCenter");
        Self {
            theme: "light".into(),
            language: "zh-CN".into(),
            auto_update: true,
            log_path: base.join("logs").to_string_lossy().into(),
            screenshot_path: base.join("screenshots").to_string_lossy().into(),
            apk_path: base.join("apks").to_string_lossy().into(),
            proxy: String::new(),
            docker_path: "docker".into(),
            adb_path: "adb".into(),
            scrcpy_path: "scrcpy".into(),
            gapps_zip_path: String::new(),
            install_gapps: true,
            last_cpu: "2".into(),
            last_ram: "2g".into(),
            last_resolution: "1080x1920".into(),
            last_dpi: "320".into(),
            last_image: "redroid/redroid:13.0.0-latest".into(),
            auto_start_device_ids: Vec::new(),
            create_auto_start: false,
            create_stay_on_form: false,
            create_wait_adb: true,
            resource_alert_threshold: default_resource_alert_threshold(),
            device_refresh_interval_secs: default_device_refresh_interval_secs(),
            device_monitor_rules: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub status: SystemStatus,
    pub devices: Vec<DeviceInfo>,
    pub recent_logs: Vec<LogEntry>,
    pub recent_screenshots: Vec<String>,
    pub recent_apks: Vec<String>,
    pub notifications: Vec<String>,
}

/// Root / Magisk preset state for one device (red team preset panel).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RootModuleInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    /// enabled | disabled
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    /// magisk binary / daemon reachable
    pub magisk: bool,
    pub version: String,
    pub zygisk_enabled: bool,
    /// Zygisk actually injecting the zygote (zygiskd running), not just the
    /// DB flag — enabling the flag needs one more reboot to take effect.
    #[serde(default)]
    pub zygisk_active: bool,
    pub denylist_enforced: bool,
    /// LSPosed daemon (lspd) running — module actually activated.
    #[serde(default)]
    pub lsposed_active: bool,
    /// Manager APKs surfaced as real apps.
    #[serde(default)]
    pub magisk_app: bool,
    #[serde(default)]
    pub lsposed_manager: bool,
    /// Shamiko whitelist-mode marker; None when the module is absent.
    #[serde(default)]
    pub shamiko_whitelist: Option<bool>,
    pub modules: Vec<RootModuleInfo>,
    pub denylist: Vec<String>,
    /// Sampled effective props (model, fingerprint, abi, qemu markers…)
    pub props: std::collections::BTreeMap<String, String>,
    pub preset_log_tail: String,
    #[serde(default)]
    pub message: String,
}

/// One LSPosed module and the apps it is scoped to hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LsposedScopeModule {
    pub pkg: String,
    pub enabled: bool,
    pub scope: Vec<String>,
}

/// Result of reading /data/adb/lspd/config/modules_config.db (pulled to a
/// temp dir and replayed locally — the image's sqlite3 binary is broken).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LsposedScopeReport {
    pub modules: Vec<LsposedScopeModule>,
    #[serde(default)]
    pub message: String,
}

/// One row of Magisk's su policy table (who may request root).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuPolicyEntry {
    pub uid: i64,
    /// Resolved package name, empty when the uid has no installed package.
    pub package: String,
    /// "allow" | "deny"
    pub policy: String,
}

/// Readiness of locally downloaded Magisk assets (vendor/magisk, not in git).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MagiskAssets {
    pub magisk_dir: String,
    pub magisk_ok: bool,
    pub lsposed_ok: bool,
    pub shamiko_ok: bool,
    #[serde(default)]
    pub message: String,
}

/// One ADB-over-TCP candidate found by the LAN scan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanDevice {
    /// ip:port
    pub address: String,
    pub connected: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub message: String,
}

/// Result of a subnet scan for ADB devices.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanScanResult {
    pub subnet: String,
    pub port: u16,
    pub scanned: u32,
    pub found: Vec<LanDevice>,
    pub connected_count: u32,
    pub duration_ms: u64,
    #[serde(default)]
    pub message: String,
}

/// WSL2 custom binder kernel status for Redroid + Docker Desktop.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslKernelStatus {
    pub wsl_available: bool,
    /// "custom" | "default" | "unknown"
    pub mode: String,
    pub configured_kernel: String,
    pub custom_kernel_path: String,
    pub custom_kernel_exists: bool,
    pub custom_kernel_size: u64,
    pub config_snapshot_exists: bool,
    pub live_kernel_version: String,
    pub binder_enabled: bool,
    pub docker_ready_hints: Vec<String>,
    pub message: String,
    pub scripts_dir: String,
    /// e.g. windows-x64, linux-arm64
    pub platform: String,
    pub os: String,
    pub arch: String,
    /// wsl-prebuilt-or-build | host-binder | unsupported
    pub strategy: String,
    pub platform_supported: bool,
    pub needs_wsl_kernel: bool,
    /// GitHub Release asset filename for this arch (if any)
    pub release_asset_bz_image: String,
    pub release_asset_config: String,
}

#[cfg(test)]
mod app_settings_tests {
    use super::{AppSettings, DeviceMonitorRule};

    #[test]
    fn app_settings_without_device_monitor_rules_remain_compatible() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("deviceMonitorRules");

        let settings: AppSettings = serde_json::from_value(value).unwrap();

        assert!(settings.device_monitor_rules.is_empty());
    }

    #[test]
    fn app_settings_round_trip_device_monitor_rules() {
        let mut settings = AppSettings::default();
        settings.device_monitor_rules.insert(
            "device-a".into(),
            DeviceMonitorRule {
                preset: "custom".into(),
                alert_threshold: Some(73.0),
                refresh_interval_secs: Some(12),
                alerts_enabled: Some(false),
                quiet_start: Some("22:00".into()),
                quiet_end: Some("06:30".into()),
            },
        );

        let encoded = serde_json::to_string(&settings).unwrap();
        let decoded: AppSettings = serde_json::from_str(&encoded).unwrap();

        let rule = decoded.device_monitor_rules.get("device-a").unwrap();
        assert_eq!(rule.preset, "custom");
        assert_eq!(rule.alert_threshold, Some(73.0));
        assert_eq!(rule.refresh_interval_secs, Some(12));
        assert_eq!(rule.alerts_enabled, Some(false));
        assert_eq!(rule.quiet_start.as_deref(), Some("22:00"));
        assert_eq!(rule.quiet_end.as_deref(), Some("06:30"));
    }

    #[test]
    fn incomplete_device_monitor_rule_does_not_reject_all_settings() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value["deviceMonitorRules"] = serde_json::json!({
            "device-a": {}
        });

        let settings: AppSettings = serde_json::from_value(value).unwrap();

        let rule = settings.device_monitor_rules.get("device-a").unwrap();
        assert_eq!(rule.preset, "");
        assert_eq!(rule.alert_threshold, None);
        assert_eq!(rule.refresh_interval_secs, None);
        assert_eq!(rule.alerts_enabled, None);
        assert_eq!(rule.quiet_start, None);
        assert_eq!(rule.quiet_end, None);
    }
}
