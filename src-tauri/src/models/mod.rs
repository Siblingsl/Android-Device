use serde::{Deserialize, Serialize};

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
    /// Effective spoofed model reported by `ro.product.model` (may differ from
    /// the container name when a spoof profile is active).
    #[serde(default)]
    pub spoofed_model: Option<String>,
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
    /// Built-in spoof profile id to render into the image at build time.
    /// Takes precedence over `spoof_profile` when non-empty.
    #[serde(default)]
    pub spoof_profile_id: Option<String>,
    /// When true, also spoof `ro.product.cpu.abilist*` to arm64-v8a (unsafe on
    /// x86_64 images without libhoudini/libndk — see UI warning).
    #[serde(default)]
    pub spoof_abilist: Option<bool>,
    /// Packages to add to the Magisk denylist (hidden from these apps).
    #[serde(default)]
    pub hide_packages: Vec<String>,
    /// When true, bind-mount fake /proc/cpuinfo + /proc/version for the spoof
    /// profile and run the container under `--cgroup-parent system.slice`.
    #[serde(default)]
    pub clean_traces: Option<bool>,
    /// When false, skip adb wait_ready after docker run.
    #[serde(default = "default_true")]
    pub wait_adb: bool,
    /// Install the DeviceCloak LSPosed module (deep spoofing) after first boot
    /// and push the matching rdc-cloak.json. Requires an existing built APK at
    /// vendor/lsposed-module/dist/RDC-DeviceCloak.apk; missing APK only warns.
    #[serde(default)]
    pub install_cloak: bool,
    /// GPU passthrough (`androidboot.redroid_gpu_mode=host` + `--device
    /// /dev/dri`). Requires the host to actually expose GPU nodes (Linux
    /// /dev/dri or a WSL2 kernel with GPU-PV paravirtualization); when the
    /// host has none, `docker run` itself fails — surfaced verbatim.
    #[serde(default)]
    pub gpu_passthrough: Option<bool>,
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

fn default_runtime_idle_timeout_minutes() -> u32 {
    30
}

fn default_runtime_max_parallel_starts() -> u32 {
    1
}

fn default_gnirehtet_path() -> String {
    "gnirehtet".into()
}

fn default_update_channel() -> String {
    "stable".into()
}

fn default_build_tags() -> String {
    "release-keys".into()
}

fn default_build_type() -> String {
    "user".into()
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

/// Read-only per-container runtime metrics used by the cross-track comparison.
/// `None` means Docker did not report that field; the explicit `*_unlimited`
/// flags distinguish a known unlimited resource from an unreadable quota.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetrics {
    #[serde(default)]
    pub cpu_quota_cores: Option<f64>,
    #[serde(default)]
    pub cpu_unlimited: Option<bool>,
    #[serde(default)]
    pub memory_quota_bytes: Option<u64>,
    #[serde(default)]
    pub memory_unlimited: Option<bool>,
    #[serde(default)]
    pub disk_bytes: Option<u64>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<RuntimeMetrics>,
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
pub struct FileTransferProgress {
    pub operation_id: String,
    pub direction: String,
    pub status: String,
    pub bytes_transferred: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub message: String,
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
pub struct StreamSession {
    pub serial: String,
    pub status: String,
    pub url: String,
    pub port: u16,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub kind: String,
    pub serial: String,
    pub status: String,
    pub output: String,
    pub cols: u16,
    pub rows: u16,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WirelessDiscovery {
    pub status: String,
    pub services: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSession {
    pub serial: String,
    pub mode: String,
    pub status: String,
    pub output_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GnirehtetSession {
    pub serial: String,
    pub status: String,
    pub message: String,
    pub relay: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTelemetry {
    pub serial: String,
    pub battery_level: i32,
    pub battery_temperature: String,
    pub power_state: String,
    pub voltage: String,
    pub updated_at: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// UI theme preference: "light" | "dark" | None (= follow the system via
    /// prefers-color-scheme). Anything unrecognized is treated as system.
    #[serde(default)]
    pub theme: Option<String>,
    pub language: String,
    pub auto_update: bool,
    pub log_path: String,
    pub screenshot_path: String,
    pub apk_path: String,
    pub proxy: String,
    pub docker_path: String,
    pub adb_path: String,
    pub scrcpy_path: String,
    #[serde(default = "default_gnirehtet_path")]
    pub gnirehtet_path: String,
    #[serde(default)]
    pub recording_path: String,
    #[serde(default)]
    pub close_to_tray: bool,
    #[serde(default)]
    pub launch_at_login: bool,
    #[serde(default)]
    pub edge_hide: bool,
    #[serde(default)]
    pub desktop_shortcut: bool,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    #[serde(default)]
    pub skipped_update_version: String,
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
    /// Last built-in spoof profile id selected in the create form.
    #[serde(default)]
    pub last_spoof_profile_id: String,
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
    /// Local tun2socks binary enabling per-instance transparent proxying.
    /// Empty = transparent takeover disabled (global http_proxy still works).
    #[serde(default)]
    pub tun2socks_path: String,
    /// Apply the simulated battery curve to every open detail page. None is
    /// treated as true (the default keeps curves fresh).
    #[serde(default)]
    pub battery_auto_refresh: Option<bool>,
    /// Preferred runtime track: "docker" (default) | "qemu". Preference only —
    /// the QEMU track stays experimental until its verify report is all-green.
    #[serde(default)]
    pub default_track: Option<String>,
    /// Per-device grouping tags (simplified model: tags ARE the groups).
    /// deviceId (or serial) → list of tag names. Lives in settings.json.
    #[serde(default)]
    pub device_tags: Option<std::collections::BTreeMap<String, Vec<String>>>,
    /// Minutes without a recorded runtime activity before an explicit idle
    /// release may stop a redroid instance.
    #[serde(default = "default_runtime_idle_timeout_minutes")]
    pub runtime_idle_timeout_minutes: u32,
    /// Keep the QEMU VM alive while releasing individual idle containers.
    #[serde(default = "default_false")]
    pub runtime_keep_vm_warm: bool,
    /// Maximum number of serialized QEMU/container starts.
    #[serde(default = "default_runtime_max_parallel_starts")]
    pub runtime_max_parallel_starts: u32,
    /// Instance ids that must never be automatically reclaimed.
    #[serde(default)]
    pub runtime_protected_instance_ids: Vec<String>,
    /// Automatically reclaim one safe idle instance before a critical-pressure
    /// start. Older settings files default to enabled.
    #[serde(default = "default_true")]
    pub runtime_auto_release_idle_on_critical: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let base = home.join("RedroidDeviceCenter");
        Self {
            theme: Some("light".into()),
            language: "zh-CN".into(),
            auto_update: true,
            log_path: base.join("logs").to_string_lossy().into(),
            screenshot_path: base.join("screenshots").to_string_lossy().into(),
            apk_path: base.join("apks").to_string_lossy().into(),
            proxy: String::new(),
            docker_path: "docker".into(),
            adb_path: "adb".into(),
            scrcpy_path: "scrcpy".into(),
            gnirehtet_path: "gnirehtet".into(),
            recording_path: base.join("recordings").to_string_lossy().into(),
            close_to_tray: false,
            launch_at_login: false,
            edge_hide: false,
            desktop_shortcut: false,
            update_channel: "stable".into(),
            skipped_update_version: String::new(),
            gapps_zip_path: String::new(),
            install_gapps: true,
            last_cpu: "2".into(),
            last_ram: "2g".into(),
            last_resolution: "1080x1920".into(),
            last_dpi: "320".into(),
            last_image: "redroid/redroid:13.0.0-latest".into(),
            last_spoof_profile_id: "redmi-k40-alioth".into(),
            auto_start_device_ids: Vec::new(),
            create_auto_start: false,
            create_stay_on_form: false,
            create_wait_adb: true,
            tun2socks_path: String::new(),
            battery_auto_refresh: Some(true),
            default_track: None,
            device_tags: None,
            runtime_idle_timeout_minutes: 30,
            runtime_keep_vm_warm: false,
            runtime_max_parallel_starts: 1,
            runtime_protected_instance_ids: Vec::new(),
            runtime_auto_release_idle_on_critical: true,
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

/// A device spoof profile ("设备伪装档案"). The renderer turns this into the
/// `set|key|value` / `del|key` lines that `rdc_apply_spoof.sh` applies on boot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoofProfile {
    /// Snake-case unique id, e.g. "redmi-k40-alioth".
    pub id: String,
    pub brand: String,
    pub manufacturer: String,
    pub model: String,
    pub market_name: String,
    pub device: String,
    pub product: String,
    pub android_version: String,
    pub build_fingerprint: String,
    pub build_description: String,
    pub build_display_id: String,
    pub build_incremental: String,
    pub security_patch: String,
    #[serde(default = "default_build_tags")]
    pub build_tags: String,
    #[serde(default = "default_build_type")]
    pub build_type: String,
    /// "key=value" props appended as `set|key|value` lines.
    #[serde(default)]
    pub extra_props: Vec<String>,
    /// Property names appended as `del|key` lines.
    #[serde(default)]
    pub remove_props: Vec<String>,
    /// Human-readable notes shown in the UI (Chinese).
    #[serde(default)]
    pub notes: Option<String>,
    /// Optional geographic identity block for the geo-consistency check
    /// (`services/geo.rs`). Absent (`None`) → the check reports "no geo data".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geo: Option<ProfileGeo>,
}

/// Optional geo block on a `SpoofProfile`. `proxy_country` is user-supplied
/// (the app never does GeoIP lookups on its own) — set it when the instance's
/// egress proxy is known to exit in a specific country.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileGeo {
    /// ISO 3166-1 alpha-2 country code, e.g. "CN".
    #[serde(default)]
    pub country: String,
    /// IANA timezone id the profile claims, e.g. "Asia/Shanghai".
    #[serde(default)]
    pub timezone: String,
    /// BCP-47 locale the profile claims, e.g. "zh-CN".
    #[serde(default)]
    pub locale: String,
    /// Optional: the egress proxy's country code (user-declared).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_country: Option<String>,
}

/// Lightweight spoof profile row for the picker list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoofProfileSummary {
    pub id: String,
    pub brand: String,
    pub manufacturer: String,
    pub model: String,
    pub market_name: String,
    pub android_version: String,
    pub security_patch: String,
    pub fingerprint: String,
    #[serde(default)]
    pub notes: Option<String>,
    /// "builtin" | "captured" — origin of the profile.
    #[serde(default = "default_profile_source")]
    pub source: String,
}

fn default_profile_source() -> String {
    "builtin".into()
}

/// Effective spoofed identity read from a running device.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpoofIdentity {
    pub brand: String,
    pub model: String,
    pub market_name: String,
    pub fingerprint: String,
    pub device: String,
    /// Built-in profile id when brand+model+fingerprint all match exactly.
    #[serde(default)]
    pub matched_profile_id: Option<String>,
}

/// Deep-spoofing (DeviceCloak LSPosed module) state on a running device.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloakStatus {
    /// Whether the module APK (dev.rdc.devicecloak) is installed.
    pub installed: bool,
    /// Module enabled in LSPosed (parasitic "enabled" flag from scope db).
    pub enabled: bool,
    /// Number of apps the module is scoped to hook.
    pub scope_count: usize,
    /// Whether /data/local/tmp/rdc-cloak.json exists on-device.
    #[serde(default)]
    pub config_pushed: bool,
    /// Whether the native Zygisk module (rdc_nativecloak) is installed under
    /// /data/adb/modules — checked via the root channel, so physical devices
    /// without root report false.
    #[serde(default)]
    pub native_installed: bool,
    #[serde(default)]
    pub message: String,
}

/// Per-instance network egress state ("每实例住宅代理分流").
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProxyStatus {
    /// Effective `settings get global http_proxy` value ("" = direct).
    pub http_proxy: String,
    /// Original user-entered proxy string recorded in persist.sys.rdc.proxy.
    pub original: String,
    /// Whether a transparent tun2socks takeover is running in the container.
    pub transparent_running: bool,
    #[serde(default)]
    pub message: String,
}

/// One row of the spoof-profile usage census (label `rdc.spoof-profile`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoofProfileUsage {
    pub profile_id: String,
    pub count: u32,
}

/// Simulated battery state (BatteryManager semantics for `status`:
/// 2=charging, 3=discharging, 4=not charging, 5=full).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatteryState {
    pub level: u32,
    pub status: u32,
    pub charging: bool,
}

/// One row of the adversarial self-audit checklist.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditCheck {
    /// Stable check id (cgroup / qemu / cpuinfo / version / gl / sensors /
    /// fingerprint / securityPatch / mac / hostname / dns / telephony).
    pub id: String,
    /// Coarse grouping for the UI table (also stable, English).
    pub category: String,
    /// "pass" | "fail" | "unknown"
    pub verdict: String,
    /// Human-readable evidence summary (Chinese, includes measured values).
    pub detail: String,
}

/// One inconsistency found by the geo-consistency check.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeoIssue {
    /// Stable issue code: "timezoneMismatch" | "localeMismatch" |
    /// "proxyCountryMismatch" | "noGeoData".
    pub code: String,
    /// Human-readable explanation (Chinese, includes the measured values).
    pub message: String,
}

/// Result of the geo-consistency check for one device + profile.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeoCheck {
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Device timezone read via `getprop persist.sys.timezone` (raw value).
    #[serde(default)]
    pub device_timezone: String,
    /// Device locale read via `getprop ro.product.locale` (raw value).
    #[serde(default)]
    pub device_locale: String,
    pub issues: Vec<GeoIssue>,
    /// Convenience flag for the UI: `issues` is empty.
    pub consistent: bool,
}

/// Result of the adversarial self-audit for one device.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdversarialAudit {
    pub serial: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub ran_at: String,
    /// Non-empty when the whole probe failed (device unreachable).
    #[serde(default)]
    pub message: String,
    pub checks: Vec<AuditCheck>,
}

/// WSL2 custom binder kernel status for Redroid + Docker Desktop.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslKernelStatus {
    pub wsl_available: bool,
    /// "custom" | "default" | "host" | "external-vm" | "unknown"
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
    /// wsl-prebuilt-or-build | host-binder | docker-desktop-vm | unsupported
    pub strategy: String,
    pub platform_supported: bool,
    pub needs_wsl_kernel: bool,
    /// GitHub Release asset filename for this arch (if any)
    pub release_asset_bz_image: String,
    pub release_asset_config: String,
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn runtime_keep_vm_warm_defaults_to_memory_first() {
        assert!(!AppSettings::default().runtime_keep_vm_warm);
    }

    #[test]
    fn missing_runtime_keep_vm_warm_is_memory_first_but_explicit_value_is_preserved() {
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("runtimeKeepVmWarm");
        let missing: AppSettings = serde_json::from_value(legacy).unwrap();
        assert!(!missing.runtime_keep_vm_warm);

        let mut explicit = serde_json::to_value(AppSettings::default()).unwrap();
        explicit
            .as_object_mut()
            .unwrap()
            .insert("runtimeKeepVmWarm".into(), serde_json::Value::Bool(true));
        let explicit: AppSettings = serde_json::from_value(explicit).unwrap();
        assert!(explicit.runtime_keep_vm_warm);
    }
}
