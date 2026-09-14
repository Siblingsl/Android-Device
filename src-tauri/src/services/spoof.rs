//! Device spoof profiles ("设备伪装档案库").
//!
//! A profile is the typed source of truth for the `set|key|value` / `del|key`
//! lines that `rdc_apply_spoof.sh` applies at boot. `render_spoof_conf` is the
//! only place that turns a profile back into that wire format, and
//! `validate_profile` keeps every profile internally self-consistent (the
//! fingerprint, description and identity fields must agree with each other).

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::models::{ShellResult, SpoofIdentity, SpoofProfile, SpoofProfileSummary, SpoofProfileUsage};
use crate::services::{adb, cloak, docker, log, root, traces, util};

/// Build a profile and derive its fingerprint / description. All bundled
/// profiles share the same `user` / `release-keys` build type and tags, so the
/// two strings can be derived deterministically instead of repeated by hand.
fn profile(
    id: &'static str,
    brand: &'static str,
    manufacturer: &'static str,
    model: &'static str,
    market_name: &'static str,
    device: &'static str,
    product: &'static str,
    android_version: &'static str,
    build_id: &'static str,
    incremental: &'static str,
    display_id: &'static str,
    security_patch: &'static str,
    notes: Option<&'static str>,
    remove_props: &'static [&'static str],
    extra_props: &'static [&'static str],
) -> SpoofProfile {
    let build_type = "user";
    let build_tags = "release-keys";
    SpoofProfile {
        id: id.to_string(),
        brand: brand.to_string(),
        manufacturer: manufacturer.to_string(),
        model: model.to_string(),
        market_name: market_name.to_string(),
        device: device.to_string(),
        product: product.to_string(),
        android_version: android_version.to_string(),
        build_fingerprint: format!(
            "{brand}/{product}/{device}:{android_version}/{build_id}/{incremental}:{build_type}/{build_tags}"
        ),
        build_description: format!(
            "{device}-{build_type} {android_version} {build_id} {incremental} {build_tags}"
        ),
        build_display_id: display_id.to_string(),
        build_incremental: incremental.to_string(),
        security_patch: security_patch.to_string(),
        build_tags: build_tags.to_string(),
        build_type: build_type.to_string(),
        extra_props: extra_props.iter().map(|s| s.to_string()).collect(),
        remove_props: remove_props.iter().map(|s| s.to_string()).collect(),
        notes: notes.map(|s| s.to_string()),
        geo: None,
    }
}

const CONSTRUCTED_NOTE: &str = "指纹为合理构造，强对抗场景请自行核对真机。";

/// Hardening `removeProps` shared by non-anchor phone profiles. On x86_64
/// images these drop the qemu/goldfish defaults (safe); we deliberately do NOT
/// set a qcom hardware string — the bundled conf notes that breaks some services.
const PHONE_REMOVE_PROPS: &[&str] = &["ro.hardware", "ro.boot.hardware"];

/// Phone-only `extraProps` — a constructed SIM-ready state and a plausible
/// baseband string (only meaningful for cellular-identity checks).
const PHONE_EXTRA_PROPS: &[&str] = &[
    "gsm.sim.state=READY",
    "gsm.version.baseband=MPSS.HI.4.0.c11-00045-8953_GEN_PACK-1",
];

static PROFILES: Lazy<Vec<SpoofProfile>> = Lazy::new(|| {
    vec![
        // Default / compatibility anchor. Field values match the bundled
        // vendor/magisk-overlay/system/etc/init/magisk/spoof.conf exactly.
        profile(
            "redmi-k40-alioth",
            "Xiaomi",
            "Xiaomi",
            "2210132C",
            "Redmi K40",
            "alioth",
            "alioth",
            "13",
            "TKQ1.220829.002",
            "V14.0.6.0.TKHCNXM",
            "V14.0.6.0.TKHCNXM",
            "2023-11-01",
            Some("默认档案，字段来自真机实测（Redmi K40 / alioth，Android 13）。"),
            &[],
            &[],
        ),
        profile(
            "samsung-galaxy-s23",
            "samsung",
            "samsung",
            "SM-S9110",
            "Galaxy S23",
            "dm1qzc",
            "dm1qzc",
            "14",
            "UP1A.231005.007",
            "S9110ZCU1BWL1",
            "S9110ZCU1BWL1",
            "2023-12-01",
            Some("指纹参考公开渠道（Galaxy S23 / SM-S9110）；强对抗场景请自行核对真机。"),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "google-pixel-6",
            "google",
            "Google",
            "Pixel 6",
            "Pixel 6",
            "oriole",
            "oriole",
            "13",
            "TQ3A.230805.001",
            "10721624",
            "TQ3A.230805.001",
            "2023-08-05",
            Some("指纹参考公开真机（Pixel 6 / oriole）；强对抗场景请自行核对真机。"),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "xiaomi-13",
            "Xiaomi",
            "Xiaomi",
            "2211133C",
            "Xiaomi 13",
            "fuxi",
            "fuxi",
            "13",
            "TKQ1.220905.001",
            "V14.0.30.0.TMCCNXM",
            "V14.0.30.0.TMCCNXM",
            "2023-12-01",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "samsung-galaxy-a54",
            "samsung",
            "samsung",
            "SM-A5460",
            "Galaxy A54",
            "a54x",
            "a54x",
            "14",
            "UP1A.231005.007",
            "A5460ZCU1BWL1",
            "A5460ZCU1BWL1",
            "2023-12-01",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "oppo-find-x5-pro",
            "OPPO",
            "OPPO",
            "PFEM10",
            "Find X5 Pro",
            "PFEM10",
            "PFEM10",
            "13",
            "TP1A.220905.001",
            "PFEM10_13.1.0.522CN01",
            "PFEM10_13.1.0.522CN01",
            "2023-05-05",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "vivo-x90-pro",
            "vivo",
            "vivo",
            "V2242A",
            "X90 Pro",
            "PD2242",
            "PD2242",
            "13",
            "TP1A.220624.014",
            "PD2242_A_13.0.6.4",
            "PD2242_A_13.0.6.4",
            "2023-06-01",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "honor-magic5-pro",
            "HONOR",
            "HONOR",
            "PGT-AN10",
            "Magic5 Pro",
            "PGT-AN10",
            "PGT-AN10",
            "13",
            "TP1A.220624.014",
            "7.1.0.132C00E130R5P6",
            "7.1.0.132C00E130R5P6",
            "2023-06-01",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "oneplus-11",
            "OnePlus",
            "OnePlus",
            "PHB110",
            "OnePlus 11",
            "PHB110",
            "PHB110",
            "13",
            "TP1A.220905.001",
            "PHB110_13.1.0.502CN01",
            "PHB110_13.1.0.502CN01",
            "2023-05-05",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
        profile(
            "redmi-note-12",
            "Redmi",
            "Xiaomi",
            "22101317C",
            "Redmi Note 12",
            "sunstone",
            "sunstone",
            "13",
            "TP1A.220624.014",
            "V14.0.5.0.TMQCNXM",
            "V14.0.5.0.TMQCNXM",
            "2023-06-01",
            Some(CONSTRUCTED_NOTE),
            PHONE_REMOVE_PROPS,
            PHONE_EXTRA_PROPS,
        ),
    ]
});

/// The 10 built-in profiles. The default (redmi-k40-alioth) is first.
pub fn built_in_profiles() -> &'static [SpoofProfile] {
    &PROFILES
}

/// Directory for user-captured profiles (persisted next to settings.json, so
/// they survive app restarts and image rebuilds). Follows the same
/// `dirs::config_dir()/RedroidDeviceCenter` pattern as `services::settings`.
fn spoof_profiles_dir() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("RedroidDeviceCenter")
        .join("spoof-profiles");
    util::ensure_dir(&dir.to_string_lossy());
    dir
}

/// Read every persisted `<id>.json` profile from a directory. Split out from
/// `custom_profiles` so tests can point it at a temp dir.
fn read_custom_profiles(dir: &Path) -> Vec<SpoofProfile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str::<SpoofProfile>(&content).ok())
        })
        .collect()
}

fn custom_profiles() -> Vec<SpoofProfile> {
    read_custom_profiles(&spoof_profiles_dir())
}

/// Built-in + captured profiles, merged in that order (built-ins first, so the
/// picker keeps its stable default ordering while captured entries append).
pub fn list_all_profiles() -> Vec<SpoofProfile> {
    let mut all = built_in_profiles().to_vec();
    all.extend(custom_profiles());
    all
}

/// Look up a profile by snake-case id across built-in and captured profiles.
pub fn profile_by_id(id: &str) -> Option<SpoofProfile> {
    list_all_profiles().into_iter().find(|p| p.id == id)
}

fn summary_of(p: &SpoofProfile, source: &str) -> SpoofProfileSummary {
    SpoofProfileSummary {
        id: p.id.clone(),
        brand: p.brand.clone(),
        manufacturer: p.manufacturer.clone(),
        model: p.model.clone(),
        market_name: p.market_name.clone(),
        android_version: p.android_version.clone(),
        security_patch: p.security_patch.clone(),
        fingerprint: p.build_fingerprint.clone(),
        notes: p.notes.clone(),
        source: source.to_string(),
    }
}

/// Lightweight rows for the picker UI. Captured profiles are appended after
/// the built-ins and marked with `source = "captured"`.
pub fn list_summaries() -> Vec<SpoofProfileSummary> {
    let mut out: Vec<SpoofProfileSummary> = built_in_profiles()
        .iter()
        .map(|p| summary_of(p, "builtin"))
        .collect();
    out.extend(
        custom_profiles()
            .iter()
            .map(|p| summary_of(p, "captured")),
    );
    out
}

/// Extract the `rdc.spoof-profile` value from one `{{.Labels}}` row
/// (`docker ps --format` renders labels as `k1=v1,k2=v2` or `<no value>`).
pub(crate) fn parse_spoof_label(labels_row: &str) -> Option<String> {
    for pair in labels_row.trim().split(',') {
        if let Some((k, v)) = pair.split_once('=') {
            if k.trim() == "rdc.spoof-profile" && !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Census of spoof-profile usage across all containers (running or stopped),
/// read from the `rdc.spoof-profile` label stamped at create time. Best
/// effort: when Docker is unreachable this returns an empty census instead of
/// an error — the UI simply hides the diversity warnings.
pub fn spoof_profile_usage() -> Vec<SpoofProfileUsage> {
    let r = util::run_command_timeout(
        &docker::docker_bin(),
        &[
            "ps",
            "-a",
            "--filter",
            "label=rdc.spoof-profile",
            "--format",
            "{{.Labels}}",
        ],
        Duration::from_secs(10),
    );
    if !r.success {
        log::warn(
            "Spoof",
            &format!("spoof_profile_usage: docker ps failed: {}", r.stderr.trim()),
        );
        return Vec::new();
    }
    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for line in r.stdout.lines() {
        if let Some(id) = parse_spoof_label(line) {
            *counts.entry(id).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .map(|(profile_id, count)| SpoofProfileUsage {
            profile_id,
            count,
        })
        .collect()
}

/// Match a running identity against the built-in profiles. Only exact
/// brand+model+fingerprint equality counts (a partial match is not a match).
pub fn matching_profile_id(brand: &str, model: &str, fingerprint: &str) -> Option<String> {
    let brand = brand.trim();
    let model = model.trim();
    let fingerprint = fingerprint.trim();
    built_in_profiles()
        .iter()
        .find(|p| p.brand == brand && p.model == model && p.build_fingerprint == fingerprint)
        .map(|p| p.id.clone())
}

/// True when `model` is an un-spoofed default value, i.e. there is no evidence
/// that a spoof profile has been applied. Used to avoid labeling real hardware
/// or plain redroid containers as "伪装".
pub fn looks_unspoofed_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    if model.is_empty() || model == "unknown" {
        return true;
    }
    if model.starts_with("redroid") {
        return true;
    }
    matches!(
        model.as_str(),
        "generic_x86_64" | "generic_arm64" | "generic_x86" | "generic_arm"
    )
}

/// `getprop` keys captured from a real device. Key names feed both the adb
/// batch shell command and `build_captured_profile`'s parser.
const CAPTURE_PROPS: &[(&str, &str)] = &[
    ("brand", "ro.product.brand"),
    ("manufacturer", "ro.product.manufacturer"),
    ("model", "ro.product.model"),
    ("device", "ro.product.device"),
    ("name", "ro.product.name"),
    ("marketname", "ro.product.marketname"),
    ("fingerprint", "ro.build.fingerprint"),
    ("description", "ro.build.description"),
    ("display_id", "ro.build.display.id"),
    ("incremental", "ro.build.version.incremental"),
    ("release", "ro.build.version.release"),
    ("security_patch", "ro.build.version.security_patch"),
    ("tags", "ro.build.tags"),
    ("type", "ro.build.type"),
];

/// Parse `echo KEY=$(getprop ...)` batch output into a map. Values are taken
/// verbatim after the first `=` (getprop values never contain a leading `=`).
pub(crate) fn parse_getprop_batch(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    map
}

/// Snake-case an id hint: lowercase, non-alphanumerics become `-`, runs of
/// separators collapse, leading/trailing separators drop. Empty → "captured".
pub(crate) fn sanitize_id(hint: &str) -> String {
    let mut out = String::new();
    for ch in hint.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cleaned = out.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "captured".to_string()
    } else {
        cleaned
    }
}

/// Pick a non-colliding id: `base`, then `base-2`, `base-3`, …
pub(crate) fn resolve_unique_id(base: &str, existing: &[String]) -> String {
    if !existing.iter().any(|id| id == base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|id| id == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Turn a raw `getprop` map into a validated `SpoofProfile`. The fingerprint
/// is kept verbatim (100% real values); `build_id` is derived from the 4th
/// `/`-separated segment of the fingerprint as the on-device build id. Empty
/// `marketname` falls back to `model`. The result must pass `validate_profile`.
fn build_captured_profile(
    props: &HashMap<String, String>,
    id: &str,
) -> Result<SpoofProfile, String> {
    let get = |key: &str| props.get(key).map(|v| v.trim().to_string()).unwrap_or_default();
    let brand = get("brand");
    let manufacturer = get("manufacturer");
    let model = get("model");
    let device = get("device");
    let product = get("name");
    let market_name = get("marketname");
    let market_name = if market_name.is_empty() {
        model.clone()
    } else {
        market_name
    };
    let fingerprint = get("fingerprint");
    let description = get("description");
    let display_id = get("display_id");
    let incremental = get("incremental");
    let android_version = get("release");
    let security_patch = get("security_patch");
    let build_tags = get("tags");
    let build_type = get("type");
    // `brand/product/device:version/build_id/incremental:type/tags` — splitting
    // on '/' yields [brand, product, "device:version", build_id, ...], so the
    // build id is the 4th segment.
    let build_id = fingerprint
        .split('/')
        .nth(3)
        .map(|segment| segment.trim().to_string())
        .unwrap_or_default();
    let build_description = if description.is_empty() {
        format!("{device}-{build_type} {android_version} {build_id} {incremental} {build_tags}")
    } else {
        description
    };

    let profile = SpoofProfile {
        id: id.to_string(),
        brand,
        manufacturer,
        model,
        market_name,
        device,
        product,
        android_version,
        build_fingerprint: fingerprint,
        build_description,
        build_display_id: display_id,
        build_incremental: incremental,
        security_patch,
        build_tags,
        build_type,
        extra_props: Vec::new(),
        remove_props: Vec::new(),
        notes: Some("从真机采集（getprop 真实值）。".to_string()),
        geo: None,
    };
    validate_profile(&profile)?;
    Ok(profile)
}

/// Capture a profile from a real device (physical / LAN). Runs one `adb shell`
/// batch of getprops, validates the result, persists it, and returns the
/// summary row. A userdebug/eng build is allowed (real hardware ships these);
/// only a structurally-invalid fingerprint is rejected.
pub fn capture_spoof_profile(serial: &str, id_hint: &str) -> Result<SpoofProfileSummary, String> {
    let serial = serial.trim();
    if serial.is_empty() {
        return Err("设备 serial 为空".into());
    }
    let mut script = String::new();
    for (key, prop) in CAPTURE_PROPS {
        script.push_str(&format!("echo {key}=$(getprop {prop});"));
    }
    let result = adb::shell(serial, &script);
    if !result.success {
        let detail = [result.stderr.trim(), result.stdout.trim()]
            .into_iter()
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if detail.is_empty() {
            "读取 getprop 失败".into()
        } else {
            detail
        });
    }
    let props = parse_getprop_batch(&result.stdout);
    let base = sanitize_id(id_hint);
    let existing: Vec<String> = list_all_profiles().iter().map(|p| p.id.clone()).collect();
    let id = resolve_unique_id(&base, &existing);
    let profile = build_captured_profile(&props, &id)?;
    let path = spoof_profiles_dir().join(format!("{id}.json"));
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入档案失败: {e}"))?;
    Ok(summary_of(&profile, "captured"))
}

/// Delete a captured profile. Built-ins are protected and return an error.
pub fn delete_custom_profile(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("档案 id 为空".into());
    }
    if built_in_profiles().iter().any(|p| p.id == id) {
        return Err(format!("内置档案不可删除: {id}"));
    }
    // The id becomes a file name — allow only the same charset sanitize_id
    // produces so traversal/odd paths cannot be constructed here.
    if id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        return Err("档案 id 包含非法字符".into());
    }
    let path = spoof_profiles_dir().join(format!("{id}.json"));
    if !path.exists() {
        return Err(format!("档案不存在: {id}"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除档案失败: {e}"))
}

/// Read the effective spoofed identity from a running device.
pub fn get_spoof_identity(serial: &str) -> SpoofIdentity {
    let brand = adb::get_prop(serial, "ro.product.brand");
    let model = adb::get_prop(serial, "ro.product.model");
    let market_name = adb::get_prop(serial, "ro.product.marketname");
    let fingerprint = adb::get_prop(serial, "ro.build.fingerprint");
    let device = adb::get_prop(serial, "ro.product.device");
    let matched_profile_id = matching_profile_id(&brand, &model, &fingerprint);
    SpoofIdentity {
        brand: brand.trim().to_string(),
        model: model.trim().to_string(),
        market_name: market_name.trim().to_string(),
        fingerprint: fingerprint.trim().to_string(),
        device: device.trim().to_string(),
        matched_profile_id,
    }
}

/// Hot-swap a built-in spoof profile on a running container.
///
/// Three layers move together so the switch never *introduces* a signature
/// that contradicts the new identity:
/// 1. **props** — render the conf (including the parameterized
///    `net.hostname`) and re-run `rdc_apply_spoof.sh`;
/// 2. **Java hooks** — push the matching `rdc-cloak.json` so DeviceCloak
///    reports the new GL/telephony identity;
/// 3. **native / bind-mount traces** — regenerate the container's fake
///    `/proc/cpuinfo` + `/proc/version` *in place* (same inode, so the
///    create-time bind mounts see the new bytes immediately) — only when the
///    instance was created with trace cleansing (label `rdc.clean-traces`).
///    Without that label only the cloak config is pushed, and the output says
///    so.
///
/// Container instances only — physical / LAN devices need their own root +
/// file placement, which this does not wire.
pub fn apply_spoof_profile(serial: &str, profile_id: &str) -> ShellResult {
    let profile = match profile_by_id(profile_id.trim()) {
        Some(p) => p,
        None => {
            let ids = list_all_profiles()
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("伪装档案 id 无效: {profile_id}\n可用 id: {ids}"),
                exit_code: -1,
            };
        }
    };
    let Some(container) = root::container_id_for(serial) else {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "仅容器实例支持热切换伪装档案（物理设备请自行 root 后手动写入）".into(),
            exit_code: -1,
        };
    };
    // The conf's net.hostname must match the `docker run --hostname` value the
    // instance was created with (same brand + adb-port derivation).
    let hostname = derive_hostname(&profile.brand, adb_port_from_serial(serial));
    let conf = render_spoof_conf_with(&profile, false, Some(&hostname));
    let remote = "/data/local/tmp/rdc-spoof.conf";
    let write = util::run_command_stdin(
        &docker::docker_bin(),
        &[
            "exec",
            "-i",
            &container,
            "sh",
            "-c",
            &format!("cat > {remote}"),
        ],
        conf.as_bytes(),
        Duration::from_secs(15),
    );
    if !write.success {
        return write;
    }
    let mut result = util::run_command_timeout(
        &docker::docker_bin(),
        &[
            "exec",
            &container,
            "sh",
            "-c",
            &format!("RDC_SPOOF_CONF={remote} sh /data/adb/service.d/rdc_apply_spoof.sh 2>&1"),
        ],
        Duration::from_secs(30),
    );
    if !result.success {
        return result;
    }

    // ---- Layer sync (only after the props applied successfully) ----
    let mut notes: Vec<String> = vec![format!(
        "props 层已应用（含 net.hostname={hostname}）"
    )];
    let mut warnings: Vec<String> = Vec::new();

    // (a) Java hook config: keep rdc-cloak.json on the new identity.
    let cloak_push = cloak::push_cloak_config(serial, &profile);
    if cloak_push.success {
        notes.push("Java hook 配置已推送（rdc-cloak.json 已同步为新身份）".into());
    } else {
        warnings.push(format!(
            "推送 rdc-cloak.json 失败（props 已生效）: {}",
            cloak_push.stderr.trim()
        ));
    }

    // (b) native / bind-mount traces: overwrite the bind-mounted files in
    // place so the running container observes the new content without a
    // restart. Skipped when the create flow did not enable trace cleansing.
    match docker::container_clean_traces_enabled(&container) {
        Some(true) => match traces::regenerate_container_traces(&container, &profile) {
            Ok(_) => notes.push(
                "native/bind-mount 层已同步（/proc/cpuinfo、/proc/version 就地覆写，立即生效）".into(),
            ),
            Err(e) => warnings.push(format!("重新生成容器痕迹失败（props 已生效）: {e}")),
        },
        Some(false) => notes.push(
            "创建时未启用容器痕迹清理：native/bind-mount 层跳过，仅推送 Java hook 配置".into(),
        ),
        None => notes.push(
            "未读取到 rdc.clean-traces 标签：native/bind-mount 层跳过，仅推送 Java hook 配置".into(),
        ),
    }

    result.stdout = format!("{}\n{}", result.stdout.trim(), notes.join("\n"));
    if !warnings.is_empty() {
        result.stderr = warnings.join("\n");
    }
    result
}

/// Host port of a container ADB serial (`127.0.0.1:5555` → 5555). Unparsable
/// serials yield 0, which simply gives the hostname suffix `00`.
pub(crate) fn adb_port_from_serial(serial: &str) -> u16 {
    serial
        .rsplit(':')
        .next()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(0)
}

/// Lowercase a brand into a hostname-safe token (ascii alnum + hyphen).
fn sanitize_hostname_token(brand: &str) -> String {
    let token: String = brand
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    token.trim_matches('-').to_string()
}

/// Derive a legal DHCP hostname from the profile brand, ≤15 chars (the
/// classic DHCP option-12 label limit Android enforces for `net.hostname`).
///
/// The last two digits of the instance's ADB port are always appended so two
/// same-brand instances on one host do not answer the same DHCP name. Long
/// brands shed the `android-` prefix first, then truncate, so the result stays
/// within budget and deterministic:
///
/// | brand | port | hostname |
/// | --- | --- | --- |
/// | Xiaomi | 5555 | `xiaomi-55` |
/// | Redmi | 5555 | `redmi-55` |
/// | vivo | 5555 | `android-vivo-55` |
/// | (none) | 5555 | `generic-55` |
pub fn derive_hostname(brand: &str, adb_port: u16) -> String {
    const MAX: usize = 15;
    let mut token = sanitize_hostname_token(brand);
    if token.is_empty() {
        token = "generic".to_string();
    }
    let nn = adb_port % 100;
    // Longest form first; the shorter forms only kick in for long brands.
    let truncated: String = token.chars().take(MAX - 3).collect();
    let candidates = [
        format!("android-{token}"),
        token.clone(),
        truncated,
    ];
    for form in candidates {
        let name = format!("{form}-{nn:02}");
        if name.chars().count() <= MAX {
            return name;
        }
    }
    format!("android-{nn:02}")
}

/// Render a profile to the `spoof.conf` text format (no `net.hostname` line).
///
/// Line order matches the bundled alioth conf so the compatibility anchor test
/// can compare effective lines verbatim. `spoof_abilist` additionally appends
/// arm64-v8a `ro.product.cpu.abilist*` lines (dangerous on x86_64 without a
/// translation layer — see the create-form warning).
pub fn render_spoof_conf(p: &SpoofProfile, spoof_abilist: bool) -> String {
    render_spoof_conf_with(p, spoof_abilist, None)
}

/// Render a profile to the `spoof.conf` text format, optionally including the
/// per-instance `net.hostname` line (see `derive_hostname`).
///
/// The bundled conf carries no `net.hostname` line, so `None` keeps the
/// compatibility-anchor rendering byte-identical; create / hot-swap flows pass
/// the derived hostname so `docker run --hostname` and `resetprop
/// net.hostname` always agree.
pub fn render_spoof_conf_with(p: &SpoofProfile, spoof_abilist: bool, hostname: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("# Generated by Redroid Device Center\n");
    out.push_str(&format!("# profile id: {}\n", p.id));
    if let Some(notes) = &p.notes {
        out.push_str(&format!("# {}\n", notes));
    }
    out.push('\n');

    // 身份块
    out.push_str(&format!("set|ro.product.brand|{}\n", p.brand));
    out.push_str(&format!("set|ro.product.manufacturer|{}\n", p.manufacturer));
    out.push_str(&format!("set|ro.product.model|{}\n", p.model));
    out.push_str(&format!("set|ro.product.device|{}\n", p.device));
    out.push_str(&format!("set|ro.product.name|{}\n", p.product));
    out.push_str(&format!("set|ro.product.marketname|{}\n", p.market_name));
    out.push('\n');

    // 构建块
    out.push_str(&format!("set|ro.build.fingerprint|{}\n", p.build_fingerprint));
    out.push_str(&format!("set|ro.build.description|{}\n", p.build_description));
    out.push_str(&format!("set|ro.build.display.id|{}\n", p.build_display_id));
    out.push_str(&format!(
        "set|ro.build.version.incremental|{}\n",
        p.build_incremental
    ));
    out.push_str(&format!("set|ro.build.tags|{}\n", p.build_tags));
    out.push_str(&format!("set|ro.build.type|{}\n", p.build_type));
    out.push_str(&format!("set|ro.build.flavor|{}-{}\n", p.device, p.build_type));
    out.push_str(&format!("set|ro.build.version.release|{}\n", p.android_version));
    out.push_str(&format!(
        "set|ro.build.version.security_patch|{}\n",
        p.security_patch
    ));
    out.push('\n');

    // 反模拟器固定块（顺序与现有 alioth conf 一致）
    out.push_str("del|ro.kernel.qemu\n");
    out.push_str("del|ro.boot.qemu\n");
    out.push_str("set|ro.bootmode|unknown\n");
    out.push_str("set|ro.boot.mode|unknown\n");
    out.push_str("set|ro.boot.bootreason|reboot\n");

    // 网络身份：net.hostname 与 docker run --hostname 同值派生（None 时不落行，
    // 保持与捆绑 conf 的逐行兼容）。
    if let Some(hostname) = hostname {
        out.push_str(&format!("set|net.hostname|{hostname}\n"));
    }

    // 自定义扩展
    for prop in &p.extra_props {
        match prop.split_once('=') {
            Some((key, value)) => out.push_str(&format!("set|{key}|{value}\n")),
            None => out.push_str(&format!("set|{prop}|\n")),
        }
    }
    for prop in &p.remove_props {
        out.push_str(&format!("del|{prop}\n"));
    }

    // CPU abilist 伪装（默认关，x86_64 镜像上会让 GApps 拉取 arm native 分包崩溃）
    if spoof_abilist {
        out.push_str("set|ro.product.cpu.abilist|arm64-v8a\n");
        out.push_str("set|ro.product.cpu.abilist32|\n");
        out.push_str("set|ro.product.cpu.abilist64|arm64-v8a\n");
    }
    out
}

/// Validate that a profile is internally self-consistent.
///
/// Checks: required fields non-empty; fingerprint shape
/// `brand/product/device:version/build_id/incremental:type/tags` with
/// brand/product/device/android_version matching the profile; description
/// starting with `{device}-{build_type} ` and containing the Android version.
/// Id uniqueness is enforced by the test suite, not here.
pub fn validate_profile(p: &SpoofProfile) -> Result<(), String> {
    let required: [(&str, &str); 15] = [
        ("id", &p.id),
        ("brand", &p.brand),
        ("manufacturer", &p.manufacturer),
        ("model", &p.model),
        ("market_name", &p.market_name),
        ("device", &p.device),
        ("product", &p.product),
        ("android_version", &p.android_version),
        ("build_fingerprint", &p.build_fingerprint),
        ("build_description", &p.build_description),
        ("build_display_id", &p.build_display_id),
        ("build_incremental", &p.build_incremental),
        ("security_patch", &p.security_patch),
        ("build_tags", &p.build_tags),
        ("build_type", &p.build_type),
    ];
    for (name, value) in required {
        if value.trim().is_empty() {
            return Err(format!("字段 {name} 不能为空"));
        }
    }

    let fp = &p.build_fingerprint;
    let parts: Vec<&str> = fp.split(|c: char| c == '/' || c == ':').collect();
    if parts.len() != 8 {
        return Err(format!(
            "fingerprint 格式不正确（应为 brand/product/device:version/build_id/incremental:type/tags）: {fp}"
        ));
    }
    let [brand, product, device, version, build_id, incremental, build_type, build_tags] =
        [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7]];
    if brand.is_empty()
        || product.is_empty()
        || device.is_empty()
        || version.is_empty()
        || build_id.is_empty()
        || incremental.is_empty()
        || build_type.is_empty()
        || build_tags.is_empty()
    {
        return Err(format!("fingerprint 存在空分段: {fp}"));
    }
    if brand != p.brand {
        return Err(format!(
            "fingerprint brand（{brand}）与档案 brand（{}）不一致",
            p.brand
        ));
    }
    if product != p.product {
        return Err(format!(
            "fingerprint product（{product}）与档案 product（{}）不一致",
            p.product
        ));
    }
    if device != p.device {
        return Err(format!(
            "fingerprint device（{device}）与档案 device（{}）不一致",
            p.device
        ));
    }
    if version != p.android_version {
        return Err(format!(
            "fingerprint 版本（{version}）与档案 android_version（{}）不一致",
            p.android_version
        ));
    }

    let desc_prefix = format!("{}-{} ", p.device, p.build_type);
    if !p.build_description.starts_with(&desc_prefix) {
        return Err(format!(
            "build_description 应以 \"{desc_prefix}\" 开头: {}",
            p.build_description
        ));
    }
    if !p.build_description.contains(&p.android_version) {
        return Err(format!(
            "build_description 应包含 android_version（{}）: {}",
            p.android_version, p.build_description
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effective_lines(text: &str) -> Vec<&str> {
        text.lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect()
    }

    fn alioth() -> SpoofProfile {
        profile_by_id("redmi-k40-alioth").expect("default profile must exist")
    }

    #[test]
    fn alioth_renders_effective_lines_identical_to_bundled_conf() {
        let bundled = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor/magisk-overlay/system/etc/init/magisk/spoof.conf");
        let bundled_text = std::fs::read_to_string(&bundled)
            .unwrap_or_else(|e| panic!("read {}: {e}", bundled.display()));

        let rendered = render_spoof_conf(&alioth(), false);
        assert_eq!(effective_lines(&rendered), effective_lines(&bundled_text));
    }

    #[test]
    fn all_built_in_profiles_pass_validation() {
        for p in built_in_profiles() {
            if let Err(e) = validate_profile(p) {
                panic!("profile {} failed validation: {e}", p.id);
            }
        }
    }

    #[test]
    fn built_in_profile_ids_are_unique_and_nonempty() {
        let ids: Vec<&str> = built_in_profiles().iter().map(|p| p.id.as_str()).collect();
        let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(ids.len(), unique.len(), "duplicate ids found: {ids:?}");
        assert!(!ids.is_empty());
        for p in built_in_profiles() {
            assert!(!p.brand.trim().is_empty(), "{}: empty brand", p.id);
            assert!(!p.model.trim().is_empty(), "{}: empty model", p.id);
            assert!(!p.market_name.trim().is_empty(), "{}: empty market_name", p.id);
        }
    }

    #[test]
    fn validator_rejects_inconsistent_fingerprint() {
        // brand mismatch
        let mut p = alioth().clone();
        p.build_fingerprint =
            "WrongBrand/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys"
                .to_string();
        let err = validate_profile(&p).unwrap_err();
        assert!(err.contains("brand"), "unexpected error: {err}");

        // device mismatch
        let mut p = alioth().clone();
        p.build_fingerprint =
            "Xiaomi/alioth/wrongdevice:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys"
                .to_string();
        let err = validate_profile(&p).unwrap_err();
        assert!(err.contains("device"), "unexpected error: {err}");

        // broken format
        let mut p = alioth().clone();
        p.build_fingerprint = "not-a-fingerprint".to_string();
        let err = validate_profile(&p).unwrap_err();
        assert!(err.contains("fingerprint 格式"), "unexpected error: {err}");

        // version mismatch
        let mut p = alioth().clone();
        p.build_fingerprint =
            "Xiaomi/alioth/alioth:12/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys"
                .to_string();
        let err = validate_profile(&p).unwrap_err();
        assert!(err.contains("android_version"), "unexpected error: {err}");
    }

    #[test]
    fn renderer_includes_anti_emulator_block_and_extras() {
        let mut p = alioth().clone();
        p.extra_props = vec!["gsm.sim.state=READY".to_string()];
        p.remove_props = vec!["ro.hardware".to_string()];
        let rendered = render_spoof_conf(&p, false);

        assert!(rendered.contains("del|ro.kernel.qemu\n"));
        assert!(rendered.contains("del|ro.boot.qemu\n"));
        assert!(rendered.contains("set|ro.bootmode|unknown\n"));
        assert!(rendered.contains("set|ro.boot.mode|unknown\n"));
        assert!(rendered.contains("set|ro.boot.bootreason|reboot\n"));
        assert!(rendered.contains("set|gsm.sim.state|READY\n"));
        assert!(rendered.contains("del|ro.hardware\n"));
    }

    #[test]
    fn flavor_and_release_are_derived() {
        let rendered = render_spoof_conf(&alioth(), false);
        assert!(rendered.contains("set|ro.build.flavor|alioth-user\n"));
        assert!(rendered.contains("set|ro.build.version.release|13\n"));
    }

    #[test]
    fn matching_profile_requires_exact_brand_model_fingerprint() {
        let p = alioth();
        assert_eq!(
            matching_profile_id(&p.brand, &p.model, &p.build_fingerprint),
            Some("redmi-k40-alioth".into())
        );
        // A brand-only match is not enough.
        assert_eq!(matching_profile_id(&p.brand, "wrong-model", &p.build_fingerprint), None);
        // A fingerprint-only mismatch is not enough.
        assert_eq!(
            matching_profile_id(&p.brand, &p.model, "Xiaomi/alioth/alioth:13/TKQ1.220829.002/x:user/release-keys"),
            None
        );
        assert_eq!(matching_profile_id("", "", ""), None);
    }

    #[test]
    fn non_anchor_profiles_harden_props_but_anchor_stays_clean() {
        let s23 = profile_by_id("samsung-galaxy-s23").expect("profile exists");
        assert!(s23.remove_props.iter().any(|p| p == "ro.hardware"));
        assert!(s23.remove_props.iter().any(|p| p == "ro.boot.hardware"));
        assert!(s23.extra_props.iter().any(|p| p == "gsm.sim.state=READY"));
        assert!(s23
            .extra_props
            .iter()
            .any(|p| p.starts_with("gsm.version.baseband=")));
        // The compatibility anchor must stay byte-for-byte stable.
        let anchor = alioth();
        assert!(anchor.remove_props.is_empty());
        assert!(anchor.extra_props.is_empty());
    }

    #[test]
    fn renderer_appends_abilist_only_when_requested() {
        let off = render_spoof_conf(&alioth(), false);
        assert!(!off.contains("ro.product.cpu.abilist"));
        let on = render_spoof_conf(&alioth(), true);
        assert!(on.contains("set|ro.product.cpu.abilist|arm64-v8a\n"));
        assert!(on.contains("set|ro.product.cpu.abilist32|\n"));
        assert!(on.contains("set|ro.product.cpu.abilist64|arm64-v8a\n"));
    }

    #[test]
    fn hostname_derivation_is_brand_based_port_suffixed_and_short() {
        assert_eq!(derive_hostname("Xiaomi", 5555), "xiaomi-55");
        assert_eq!(derive_hostname("Redmi", 5555), "redmi-55");
        assert_eq!(derive_hostname("vivo", 5555), "android-vivo-55");
        assert_eq!(derive_hostname("OPPO", 5555), "android-oppo-55");
        assert_eq!(derive_hostname("Samsung", 5555), "samsung-55");
        assert_eq!(derive_hostname("", 0), "generic-00");
        assert_eq!(derive_hostname("  ", 12345), "generic-45");
        // adbPort 后两位做后缀，不同端口不同名。
        assert_eq!(derive_hostname("Xiaomi", 5556), "xiaomi-56");
        assert_eq!(derive_hostname("Xiaomi", 6123), "xiaomi-23");
        // 非法字符被剔除，过长品牌先丢 android- 前缀再截断，总长 ≤15。
        let long = derive_hostname("VeryLongBrandName+X", 5555);
        assert!(long.chars().count() <= 15, "{long}");
        assert!(long.ends_with("-55"));
        assert!(long.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        // 确定性。
        assert_eq!(derive_hostname("Xiaomi", 5555), derive_hostname("Xiaomi", 5555));
    }

    #[test]
    fn renderer_includes_net_hostname_only_when_provided() {
        // Compatibility anchor: no hostname → no net.hostname line.
        assert!(!render_spoof_conf(&alioth(), false).contains("net.hostname"));
        let with = render_spoof_conf_with(&alioth(), false, Some("xiaomi-55"));
        assert!(with.contains("set|net.hostname|xiaomi-55\n"));
        // Hot-swap rendering for a real profile derives the same value.
        let p = profile_by_id("redmi-k40-alioth").unwrap();
        let rendered = render_spoof_conf_with(
            &p,
            false,
            Some(&derive_hostname(&p.brand, 5555)),
        );
        assert!(rendered.contains("set|net.hostname|xiaomi-55\n"));
    }

    #[test]
    fn serial_port_extraction() {
        assert_eq!(adb_port_from_serial("127.0.0.1:5555"), 5555);
        assert_eq!(adb_port_from_serial("192.168.1.8:5557"), 5557);
        assert_eq!(adb_port_from_serial("emulator-5554"), 0);
        assert_eq!(adb_port_from_serial(""), 0);
    }

    #[test]
    fn empty_or_unknown_model_is_unspoofed() {
        assert!(looks_unspoofed_model(""));
        assert!(looks_unspoofed_model("unknown"));
    }

    #[test]
    fn redroid_prefixed_model_is_unspoofed() {
        assert!(looks_unspoofed_model("redroid_x86_64"));
        assert!(looks_unspoofed_model("redroid13_arm64"));
    }

    #[test]
    fn generic_default_model_is_unspoofed() {
        assert!(looks_unspoofed_model("generic_x86_64"));
        assert!(looks_unspoofed_model("generic_arm64"));
        assert!(looks_unspoofed_model("generic_x86"));
        assert!(looks_unspoofed_model("generic_arm"));
    }

    #[test]
    fn real_spoofed_models_are_not_unspoofed() {
        assert!(!looks_unspoofed_model("2210132C"));
        assert!(!looks_unspoofed_model("SM-S9110"));
        assert!(!looks_unspoofed_model("Pixel 6"));
    }

    #[test]
    fn unspoofed_detection_is_case_insensitive() {
        assert!(looks_unspoofed_model("Redroid_X86_64"));
        assert!(looks_unspoofed_model("UNKNOWN"));
        assert!(!looks_unspoofed_model("SM-S9110"));
    }

    #[test]
    fn unspoofed_detection_ignores_surrounding_whitespace() {
        assert!(looks_unspoofed_model("  redroid_x86_64  "));
        assert!(looks_unspoofed_model("  unknown  "));
        assert!(!looks_unspoofed_model("  SM-S9110  "));
    }

    #[test]
    fn getprop_batch_parsing_reads_key_value_lines() {
        let sample = "\
BRAND=Xiaomi
MANUFACTURER=Xiaomi
MODEL=2210132C
MARKETNAME=Redmi K40
FINGERPRINT=Xiaomi/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys
DESCRIPTION=alioth-user 13 TKQ1.220829.002 V14.0.6.0.TKHCNXM release-keys
DISPLAY_ID=V14.0.6.0.TKHCNXM
INCREMENTAL=V14.0.6.0.TKHCNXM
RELEASE=13
SECURITY_PATCH=2023-11-01
TAGS=release-keys
TYPE=user
";
        let map = parse_getprop_batch(sample);
        assert_eq!(map.get("MODEL").map(String::as_str), Some("2210132C"));
        assert_eq!(map.get("RELEASE").map(String::as_str), Some("13"));
        assert_eq!(map.get("TYPE").map(String::as_str), Some("user"));
    }

    #[test]
    fn captured_profile_builds_and_passes_validation() {
        let mut map = HashMap::new();
        for (k, v) in [
            ("brand", "Xiaomi"),
            ("manufacturer", "Xiaomi"),
            ("model", "2210132C"),
            ("device", "alioth"),
            ("name", "alioth"),
            ("marketname", ""),
            ("fingerprint", "Xiaomi/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys"),
            ("description", "alioth-user 13 TKQ1.220829.002 V14.0.6.0.TKHCNXM release-keys"),
            ("display_id", "V14.0.6.0.TKHCNXM"),
            ("incremental", "V14.0.6.0.TKHCNXM"),
            ("release", "13"),
            ("security_patch", "2023-11-01"),
            ("tags", "release-keys"),
            ("type", "user"),
        ] {
            map.insert(k.to_string(), v.to_string());
        }
        let p = build_captured_profile(&map, "my-device").expect("must build");
        assert_eq!(p.market_name, "2210132C"); // marketname empty → model fallback
        assert!(p.build_description.contains("TKQ1.220829.002"));
        validate_profile(&p).expect("captured profile must validate");
    }

    #[test]
    fn captured_profile_accepts_real_userdebug_build() {
        let mut map = HashMap::new();
        for (k, v) in [
            ("brand", "google"),
            ("manufacturer", "Google"),
            ("model", "Pixel 6"),
            ("device", "oriole"),
            ("name", "oriole"),
            ("marketname", "Pixel 6"),
            ("fingerprint", "google/oriole/oriole:13/TQ3A.230805.001/10721624:userdebug/dev-keys"),
            ("description", "oriole-userdebug 13 TQ3A.230805.001 10721624 dev-keys"),
            ("display_id", "TQ3A.230805.001"),
            ("incremental", "10721624"),
            ("release", "13"),
            ("security_patch", "2023-08-05"),
            ("tags", "dev-keys"),
            ("type", "userdebug"),
        ] {
            map.insert(k.to_string(), v.to_string());
        }
        let p = build_captured_profile(&map, "pixel").expect("userdebug is a real-world build");
        assert_eq!(p.build_type, "userdebug");
        validate_profile(&p).unwrap();
    }

    #[test]
    fn id_sanitization_and_conflict_suffix() {
        assert_eq!(sanitize_id("Samsung Galaxy S23"), "samsung-galaxy-s23");
        assert_eq!(sanitize_id("  Xiaomi__13  "), "xiaomi-13");
        assert_eq!(sanitize_id("!!!"), "captured");
        let existing = vec!["xiaomi-13".to_string(), "xiaomi-13-2".to_string()];
        assert_eq!(resolve_unique_id("xiaomi-13", &existing), "xiaomi-13-3");
        assert_eq!(resolve_unique_id("fresh", &existing), "fresh");
    }

    #[test]
    fn built_in_summaries_are_marked_builtin_and_custom_reads_from_dir() {
        let summaries = list_summaries();
        assert!(summaries
            .iter()
            .any(|s| s.id == "redmi-k40-alioth" && s.source == "builtin"));

        let dir = std::env::temp_dir().join(format!("rdc-spoof-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = profile_by_id("redmi-k40-alioth").expect("anchor exists");
        std::fs::write(
            dir.join("captured-device.json"),
            serde_json::to_string_pretty(&p).unwrap(),
        )
        .unwrap();
        let custom = read_custom_profiles(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(custom.len(), 1);
        assert_eq!(summary_of(&custom[0], "captured").source, "captured");
    }

    #[test]
    fn delete_protects_builtins() {
        assert!(delete_custom_profile("redmi-k40-alioth").is_err());
        assert!(delete_custom_profile("").is_err());
        assert!(delete_custom_profile("../../etc/passwd").is_err());
    }

    #[test]
    fn spoof_label_parsing() {
        assert_eq!(
            parse_spoof_label("rdc.spoof-profile=xiaomi-13,rdc.clean-traces=true"),
            Some("xiaomi-13".into())
        );
        assert_eq!(
            parse_spoof_label("rdc.clean-traces=false,rdc.spoof-profile=google-pixel-6"),
            Some("google-pixel-6".into())
        );
        // "custom" is a valid value (custom conf path selected at create).
        assert_eq!(
            parse_spoof_label("rdc.spoof-profile=custom"),
            Some("custom".into())
        );
        assert_eq!(parse_spoof_label(""), None);
        assert_eq!(parse_spoof_label("<no value>"), None);
        assert_eq!(parse_spoof_label("other-label=1"), None);
        assert_eq!(parse_spoof_label("rdc.spoof-profile="), None);
    }
}
