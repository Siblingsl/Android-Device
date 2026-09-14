//! DeviceCloak LSPosed module integration ("深度伪装").
//!
//! The module itself is an Android Gradle project under
//! `vendor/lsposed-module/`; this environment has no Android SDK so we never
//! build it here. This service only wires the pre-built APK (placed at
//! `vendor/lsposed-module/dist/RDC-DeviceCloak.apk`, gitignored — the same
//! convention as `vendor/magisk`) into the desktop app: install, push the
//! matching `rdc-cloak.json` config, and report runtime status.
//!
//! The native counterpart (`vendor/zygisk-module`, Zygisk) is installed onto
//! *existing* instances via `install_native_cloak`: the module zip is
//! `docker cp`-ed into the container and installed through the on-container
//! Magisk (`--install-module` when the fork supports it, otherwise unpacked
//! into `/data/adb/modules/<id>` with the module skeleton the preset flow
//! uses).

use std::path::PathBuf;

use serde::Serialize;

use crate::models::{CloakStatus, ShellResult, SpoofProfile};
use crate::services::{adb, root, util};

/// Package name of the Xposed module. Matches the app module's `applicationId`.
pub const CLOAK_PACKAGE: &str = "dev.rdc.devicecloak";

/// Remote config path the module reads at load time (see README).
pub const CLOAK_CONFIG_REMOTE: &str = "/data/local/tmp/rdc-cloak.json";

/// Magisk module id of the native (Zygisk) companion — the directory name
/// under /data/adb/modules. Must match vendor/zygisk-module's module.prop.
pub const NATIVE_CLOAK_MODULE_ID: &str = "rdc_nativecloak";

/// Staging path the native-cloak zip is copied to inside the container.
pub const NATIVE_CLOAK_ZIP_REMOTE: &str = "/data/local/tmp/RDC-NativeCloak.zip";

/// Resolve a vendored module artifact: source-checkout + cwd roots (so both
/// `cargo tauri dev` and `cargo test` find it), falling back to the canonical
/// relative path for the error message when the artifact has not been built.
fn vendored_module_artifact(relative: PathBuf) -> PathBuf {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("resources"));
            roots.push(parent.to_path_buf());
        }
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots
        .into_iter()
        .map(|root| root.join(&relative))
        .find(|path| path.is_file())
        .unwrap_or(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(relative))
}

/// Resolve the pre-built module APK.
pub fn cloak_module_apk_path() -> PathBuf {
    vendored_module_artifact(
        PathBuf::from("vendor")
            .join("lsposed-module")
            .join("dist")
            .join("RDC-DeviceCloak.apk"),
    )
}

/// Resolve the pre-built native (Zygisk) module zip.
pub fn native_cloak_zip_path() -> PathBuf {
    vendored_module_artifact(
        PathBuf::from("vendor")
            .join("zygisk-module")
            .join("dist")
            .join("RDC-NativeCloak.zip"),
    )
}

fn apk_missing_result(path: &std::path::Path) -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: format!(
            "未找到 DeviceCloak 模块 APK：{}\n请先在 vendor/lsposed-module 下构建（cd vendor/lsposed-module && gradlew assembleRelease），\
             并将产物放到 vendor/lsposed-module/dist/RDC-DeviceCloak.apk。",
            path.display()
        ),
        exit_code: -1,
    }
}

/// Install the DeviceCloak module APK onto the target device.
pub fn install_cloak_module(serial: &str) -> ShellResult {
    let path = cloak_module_apk_path();
    if !path.is_file() {
        return apk_missing_result(&path);
    }
    adb::install(serial, &path.to_string_lossy(), true)
}

/// In-container install command for the native (Zygisk) module zip.
///
/// Prefers the Magisk CLI (`--install-module`, upstream ≥ v24) when the fork
/// ships it; falls back to unpacking the zip straight into
/// `/data/adb/modules/<module_id>` with busybox (same layout the preset
/// replay uses). Pure function — unit-tested as a string, **not yet executed
/// against a live container** (runtime-unverified, like the transparent-proxy
/// sequences).
pub fn native_cloak_install_command(zip_remote: &str, module_id: &str) -> String {
    format!(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; \
         B=/data/adb/magisk/busybox; [ -x $B ] || B=/system/etc/init/magisk/busybox; [ -x $B ] || B=busybox; \
         if $M --install-module {zip_remote} >/dev/null 2>&1 && [ -d /data/adb/modules/{module_id} ]; then \
             echo installed-via-magisk; \
         else \
             rm -rf /data/adb/modules/{module_id}; \
             mkdir -p /data/adb/modules/{module_id}; \
             $B unzip -o {zip_remote} -d /data/adb/modules/{module_id} >/dev/null 2>&1; \
             chmod -R 755 /data/adb/modules/{module_id} 2>/dev/null; \
             if [ -f /data/adb/modules/{module_id}/module.prop ]; then echo installed-via-unzip; else echo install-failed; exit 1; fi; \
         fi; \
         rm -f {zip_remote}"
    )
}

/// Install the native (Zygisk) module onto an *existing* instance.
///
/// `serial_or_container` accepts a device serial, device id or container id
/// (resolved through `root::container_id_for`). `zip_path` overrides the
/// default artifact (`vendor/zygisk-module/dist/RDC-NativeCloak.zip`) — pass
/// it when testing a locally built zip. The module only takes effect after a
/// container restart; the output says so explicitly.
///
/// ⚠️ Runtime-unverified: the in-container install sequence is unit-tested as
/// a generated string only. `--install-module` availability depends on the
/// Magisk fork inside the preset image; the unzip fallback mirrors the preset
/// module layout.
pub fn install_native_cloak(serial_or_container: &str, zip_path: Option<String>) -> ShellResult {
    let path = match zip_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => native_cloak_zip_path(),
    };
    if !path.is_file() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!(
                "未找到 NativeCloak 模块 zip：{}\n请先在 vendor/zygisk-module 下构建（cd vendor/zygisk-module && ./build.sh，需要 Android NDK），\
                 并将产物放到 vendor/zygisk-module/dist/RDC-NativeCloak.zip；或在高级选项中指定 zip 路径。",
                path.display()
            ),
            exit_code: -1,
        };
    }
    let Some(container) = root::container_id_for(serial_or_container) else {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "NativeCloak 模块仅容器实例支持（需要 docker cp + root 写 /data/adb/modules）".into(),
            exit_code: -1,
        };
    };
    let cp = util::run_command_timeout(
        &crate::services::docker::docker_bin(),
        &[
            "cp",
            &path.to_string_lossy(),
            &format!("{container}:{NATIVE_CLOAK_ZIP_REMOTE}"),
        ],
        std::time::Duration::from_secs(60),
    );
    if !cp.success {
        return cp;
    }
    let cmd = native_cloak_install_command(NATIVE_CLOAK_ZIP_REMOTE, NATIVE_CLOAK_MODULE_ID);
    let mut install = util::run_command_timeout(
        &crate::services::docker::docker_bin(),
        &["exec", &container, "sh", "-c", &cmd],
        std::time::Duration::from_secs(60),
    );
    if install.success {
        install.stdout = format!(
            "{}\nNativeCloak 模块已写入 /data/adb/modules/{NATIVE_CLOAK_MODULE_ID}；需重启容器生效（重启后 Zygisk 注入，PLT 层痕迹清理开始工作）。",
            install.stdout.trim()
        );
    }
    install
}

/// Map a profile's brand/manufacturer to a plausible GPU trio for the module's
/// default GL strings. Real devices expose this via `/proc`/GLES; the module
/// only falls back to these when `rdc-cloak.json` does not override them.
pub fn gl_for(brand: &str, manufacturer: &str) -> (&'static str, &'static str, &'static str) {
    let b = brand.to_ascii_lowercase();
    let m = manufacturer.to_ascii_lowercase();
    if b.contains("samsung") {
        ("Xclipse 920", "Samsung", "OpenGL ES 3.2")
    } else if m.contains("mediatek") || b.contains("mediatek") {
        ("Mali-G715", "ARM", "OpenGL ES 3.2")
    } else {
        ("Adreno (TM) 740", "Qualcomm", "OpenGL ES 3.2 V@0615.73")
    }
}

/// Map a profile's brand to a cellular operator MCC/MNC for telephony hooks.
pub fn operator_for(brand: &str) -> (&'static str, &'static str) {
    let b = brand.to_ascii_lowercase();
    if b.contains("samsung") {
        ("45005", "SK Telecom")
    } else if b.contains("huawei") || b.contains("honor") {
        ("46001", "China Unicom")
    } else if b.contains("oppo") || b.contains("oneplus") || b.contains("vivo") {
        ("46003", "China Telecom")
    } else {
        ("46000", "China Mobile")
    }
}

#[derive(Debug, Serialize)]
struct CloakConfigGl {
    renderer: String,
    vendor: String,
    version: String,
}

#[derive(Debug, Serialize)]
struct CloakConfigTelephony {
    #[serde(rename = "operator")]
    operator_mcc_mnc: String,
    #[serde(rename = "operator_name")]
    operator_name: String,
}

#[derive(Debug, Serialize)]
struct CloakConfigWidevine {
    #[serde(rename = "security_level")]
    security_level: String,
}

#[derive(Debug, Serialize)]
struct CloakConfigGaid {
    #[serde(rename = "limit_ad_tracking")]
    limit_ad_tracking: bool,
}

#[derive(Debug, Serialize)]
struct CloakConfigGsf {
    enabled: bool,
}

#[derive(Debug, Serialize)]
struct CloakConfigSensors {
    gravity: f64,
    noise: f64,
    #[serde(rename = "field_ut")]
    field_ut: f64,
    #[serde(rename = "light_base")]
    light_base: f64,
}

/// usage-baseline window consumed by the module's UsagestatsHooks. Seeded
/// install/last-use times fall within the last `seeded_days` days.
#[derive(Debug, Serialize)]
struct CloakConfigUsage {
    #[serde(rename = "seededDays")]
    seeded_days: u32,
}

#[derive(Debug, Serialize)]
struct CloakConfig {
    gl: CloakConfigGl,
    telephony: CloakConfigTelephony,
    widevine: CloakConfigWidevine,
    gaid: CloakConfigGaid,
    gsf: CloakConfigGsf,
    sensors: CloakConfigSensors,
    usage: CloakConfigUsage,
}

/// Render `/data/local/tmp/rdc-cloak.json` for a profile. GL strings are
/// derived from the brand; telephony operator is derived from the brand.
/// Widevine stays on L3 (an L1 claim without a real TEE is its own detection
/// signal), GAID tracks normally, GSF hooks stay off by default, and sensor
/// generation uses physically-plausible defaults — all overridable in the
/// JSON by hand. Identity values (IMEI / ANDROID_ID / GAID / Widevine ID /
/// GSF ID) are intentionally NOT written here — the module derives them
/// deterministically from the device serial on its own.
pub fn render_cloak_config(profile: &SpoofProfile) -> String {
    let (renderer, vendor, version) = gl_for(&profile.brand, &profile.manufacturer);
    let (operator, operator_name) = operator_for(&profile.brand);
    let config = CloakConfig {
        gl: CloakConfigGl {
            renderer: renderer.to_string(),
            vendor: vendor.to_string(),
            version: version.to_string(),
        },
        telephony: CloakConfigTelephony {
            operator_mcc_mnc: operator.to_string(),
            operator_name: operator_name.to_string(),
        },
        widevine: CloakConfigWidevine {
            security_level: "L3".into(),
        },
        gaid: CloakConfigGaid {
            limit_ad_tracking: false,
        },
        gsf: CloakConfigGsf { enabled: false },
        sensors: CloakConfigSensors {
            gravity: 9.81,
            noise: 0.05,
            field_ut: 45.0,
            light_base: 300.0,
        },
        usage: CloakConfigUsage {
            seeded_days: crate::services::usage::DEFAULT_SEED_DAYS,
        },
    };
    serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".into())
}

/// Push the generated config to the module's remote path.
pub fn push_cloak_config(serial: &str, profile: &SpoofProfile) -> ShellResult {
    let json = render_cloak_config(profile);
    let tmp = std::env::temp_dir().join(format!("rdc-cloak-{}.json", util::now_millis()));
    if let Err(e) = std::fs::write(&tmp, json.as_bytes()) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("写入临时配置文件失败: {e}"),
            exit_code: -1,
        };
    }
    let r = adb::push(serial, &tmp.to_string_lossy(), CLOAK_CONFIG_REMOTE);
    let _ = std::fs::remove_file(&tmp);
    r
}

/// Read the module's runtime state: APK installed, LSPosed enabled flag and
/// scope size (via root.rs's scope reader), whether the config is pushed, and
/// whether the native (Zygisk) companion module is installed.
pub fn get_cloak_status(serial: &str) -> CloakStatus {
    let mut status = CloakStatus::default();

    let installed = adb::shell(serial, &format!("pm list packages {CLOAK_PACKAGE}"));
    status.installed = installed.success && installed.stdout.contains(CLOAK_PACKAGE);

    let config = adb::shell(
        serial,
        &format!("[ -f {CLOAK_CONFIG_REMOTE} ] && echo present || echo missing"),
    );
    status.config_pushed = config.success && config.stdout.trim() == "present";

    let scope = root::lsposed_scope(serial);
    if let Some(module) = scope.modules.iter().find(|m| m.pkg == CLOAK_PACKAGE) {
        status.enabled = module.enabled;
        status.scope_count = module.scope.len();
    }
    if !scope.message.is_empty() {
        status.message = scope.message;
    }

    // The native module dir lives under /data/adb (root-only), so the check
    // goes through the privileged channel, not plain adb shell.
    let native = root::privileged_shell(
        serial,
        &format!(
            "[ -d /data/adb/modules/{NATIVE_CLOAK_MODULE_ID} ] && echo present || echo missing"
        ),
        std::time::Duration::from_secs(10),
    );
    status.native_installed = native.success && native.stdout.contains("present");
    status
}

/// Best-effort first-boot wiring used by the create flow after ADB is ready:
/// install the APK (if present) and push the profile config. A missing APK is
/// a warning, never a hard failure — the user can build it later and use the
/// DeviceDetail buttons.
pub fn cloak_first_boot_install(
    _container_name: &str,
    profile: Option<&SpoofProfile>,
    serial: &str,
) -> Result<String, String> {
    let install = install_cloak_module(serial);
    if !install.success {
        return Err(install.stderr);
    }
    if let Some(profile) = profile {
        let push = push_cloak_config(serial, profile);
        if !push.success {
            return Err(format!("模块已安装，但推送配置失败: {}", push.stderr));
        }
    }
    Ok(format!(
        "DeviceCloak 模块已安装{}；请在实例内 LSPosed 管理器手动启用一次并勾选目标 App",
        if profile.is_some() { "并推送配置" } else { "" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_for(brand: &str, manufacturer: &str) -> SpoofProfile {
        SpoofProfile {
            id: "test".into(),
            brand: brand.into(),
            manufacturer: manufacturer.into(),
            model: "TEST".into(),
            market_name: "Test".into(),
            device: "test".into(),
            product: "test".into(),
            android_version: "13".into(),
            build_fingerprint: format!("{brand}/test/test:13/TQ3A.230805.001/1:user/release-keys"),
            build_description: format!("test-user 13 TQ3A.230805.001 1 release-keys"),
            build_display_id: "TQ3A.230805.001".into(),
            build_incremental: "1".into(),
            security_patch: "2023-08-05".into(),
            build_tags: "release-keys".into(),
            build_type: "user".into(),
            extra_props: Vec::new(),
            remove_props: Vec::new(),
            notes: None,
            geo: None,
        }
    }

    #[test]
    fn gl_mapping_follows_brand_and_manufacturer() {
        assert_eq!(gl_for("samsung", "samsung").0, "Xclipse 920");
        assert_eq!(gl_for("Xiaomi", "MediaTek").0, "Mali-G715");
        assert_eq!(gl_for("Xiaomi", "Xiaomi").0, "Adreno (TM) 740");
    }

    #[test]
    fn operator_mapping_follows_brand() {
        assert_eq!(operator_for("samsung").0, "45005");
        assert_eq!(operator_for("Xiaomi").0, "46000");
        assert_eq!(operator_for("HONOR").0, "46001");
    }

    #[test]
    fn render_cloak_config_maps_profile_fields_to_json() {
        let profile = profile_for("samsung", "samsung");
        let json = render_cloak_config(&profile);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["gl"]["renderer"], "Xclipse 920");
        assert_eq!(value["gl"]["vendor"], "Samsung");
        assert_eq!(value["telephony"]["operator"], "45005");
        assert_eq!(value["telephony"]["operator_name"], "SK Telecom");
        // Extended sections keep their safe defaults.
        assert_eq!(value["widevine"]["security_level"], "L3");
        assert_eq!(value["gaid"]["limit_ad_tracking"], false);
        assert_eq!(value["gsf"]["enabled"], false);
        assert_eq!(value["sensors"]["gravity"], 9.81);
        assert_eq!(value["sensors"]["field_ut"], 45.0);
        // Usage-baseline window consumed by UsagestatsHooks.
        assert_eq!(value["usage"]["seededDays"], 90);
    }

    #[test]
    fn native_cloak_install_command_prefers_magisk_and_falls_back_to_unzip() {
        let cmd = native_cloak_install_command("/data/local/tmp/RDC-NativeCloak.zip", "rdc_nativecloak");
        // Magisk CLI first (matching root.rs's binary discovery pattern).
        assert!(cmd.contains("M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk"));
        assert!(cmd.contains("$M --install-module /data/local/tmp/RDC-NativeCloak.zip"));
        // Unzip fallback into the canonical module dir with fixed permissions.
        assert!(cmd.contains("unzip -o /data/local/tmp/RDC-NativeCloak.zip -d /data/adb/modules/rdc_nativecloak"));
        assert!(cmd.contains("chmod -R 755 /data/adb/modules/rdc_nativecloak"));
        // Success marker keyed on module.prop, staging zip cleaned up.
        assert!(cmd.contains("[ -f /data/adb/modules/rdc_nativecloak/module.prop ]"));
        assert!(cmd.contains("rm -f /data/local/tmp/RDC-NativeCloak.zip"));
        // Module-id is interpolated verbatim (callers pass a fixed constant).
        assert!(!cmd.contains("{module_id}"));
    }

    #[test]
    fn native_cloak_zip_defaults_to_vendor_dist() {
        let path = native_cloak_zip_path();
        assert!(path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("vendor/zygisk-module/dist/RDC-NativeCloak.zip"));
    }

    #[test]
    fn install_native_cloak_reports_missing_zip_with_build_instructions() {
        // The missing-zip error returns before any container resolution, so
        // the test stays free of adb/docker subprocess calls (the
        // not-a-container rejection path itself is exercised only at runtime
        // — it is documented on the function).
        let r = install_native_cloak("definitely-not-a-container", Some("Z:/no/such/zip.zip".into()));
        assert!(!r.success);
        assert!(r.stderr.contains("未找到 NativeCloak 模块 zip"));
        assert!(r.stderr.contains("build.sh"));
        assert!(r.stderr.contains("RDC-NativeCloak.zip"));
    }
}
