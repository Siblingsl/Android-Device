//! Adversarial self-audit ("对抗自检审计").
//!
//! The desktop app cannot see what a target app sees, but it can collect the
//! *shell-layer* evidence an anti-fraud SDK would look for and turn it into a
//! visible checklist. Every probe runs through plain `adb shell` (the same
//! privilege level as an app-visible surface), one batched call per audit.
//!
//! Honest scope note (surfaced in the UI too): this audits what the shell can
//! read. Java/native in-process spoofing (DeviceCloak) only affects the app
//! process it hooks — the shell sees the raw system, so a `fail` here means
//! "the underlying system leaks this", not necessarily "a hooked target app
//! leaks this".

use std::collections::BTreeMap;
use std::time::Duration;

use crate::models::{AdversarialAudit, AuditCheck, SpoofProfile};
use crate::services::{adb, cloak, spoof, util};

/// One batched shell probe covering every check. Section markers
/// (`==NAME==`) split the output; `true` keeps adb's exit code 0 so a missing
/// optional file (wlan0) does not poison the whole batch.
const AUDIT_BATCH: &str = "\
echo ==CGROUP==; cat /proc/self/cgroup 2>/dev/null; \
echo ==QEMU==; getprop ro.kernel.qemu 2>/dev/null; getprop ro.boot.qemu 2>/dev/null; \
echo ==CPUINFO==; cat /proc/cpuinfo 2>/dev/null | head -40; \
echo ==VERSION==; cat /proc/version 2>/dev/null; \
echo ==GLES==; dumpsys SurfaceFlinger 2>/dev/null | grep -i gles | head -10; \
echo ==SENSORS==; dumpsys sensorservice 2>/dev/null | grep -i -m 12 accel; \
echo ==PROPS==; echo fp=$(getprop ro.build.fingerprint); echo patch=$(getprop ro.build.version.security_patch); \
echo ==MAC==; cat /sys/class/net/wlan0/address 2>/dev/null; cat /sys/class/net/eth0/address 2>/dev/null; \
echo ==HOSTNAME==; echo hn=$(getprop net.hostname); \
echo ==DNS==; echo dns1=$(getprop net.dns1); echo dns2=$(getprop net.dns2); \
echo ==TELEPHONY==; dumpsys telephony.registry 2>/dev/null | grep -E 'mCallState|mServiceState' | head -6; \
echo ==END==; true";

/// Category display order for the audit table. Checks are emitted grouped by
/// category (stable sort keeps the insertion order inside a category).
fn category_rank(category: &str) -> usize {
    match category {
        "cgroup" => 0,
        "cpu" => 1,
        "kernel" => 2,
        "gl" => 3,
        "sensors" => 4,
        "props" => 5,
        "identity" => 6,
        "attestation" => 7,
        "network" => 8,
        "telephony" => 9,
        _ => 10,
    }
}

/// Run every check against a device. `profile_id` (when resolvable) adds the
/// profile's expected values to the relevant details.
pub fn adversarial_audit(serial: &str, profile_id: Option<String>) -> AdversarialAudit {
    let profile = profile_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(spoof::profile_by_id);

    let mut audit = AdversarialAudit {
        serial: serial.to_string(),
        profile_id: profile.as_ref().map(|p| p.id.clone()),
        ran_at: util::now_iso(),
        message: String::new(),
        checks: Vec::new(),
    };

    let result = adb::shell_timeout(serial, AUDIT_BATCH, Duration::from_secs(30));
    if !result.success {
        audit.message = if result.stderr.trim().is_empty() {
            "设备不可达，未能采集审计证据".into()
        } else {
            result.stderr.trim().to_string()
        };
        for id in [
            "cgroup",
            "qemu",
            "cpuinfo",
            "version",
            "gl",
            "sensors",
            "fingerprint",
            "securityPatch",
            "mac",
            "hostname",
            "dns",
            "telephony",
        ] {
            audit.checks.push(AuditCheck {
                id: id.into(),
                category: category_of(id).into(),
                verdict: "unknown".into(),
                detail: audit.message.clone(),
            });
        }
        audit.checks.sort_by_key(|c| category_rank(&c.category));
        return audit;
    }

    let sections = split_sections(&result.stdout);
    let empty = String::new();

    let cgroup = sections.get("CGROUP").unwrap_or(&empty);
    audit.checks.push(cgroup_check(cgroup));

    let qemu = sections.get("QEMU").unwrap_or(&empty);
    audit.checks.push(qemu_check(qemu));

    let cpuinfo = sections.get("CPUINFO").unwrap_or(&empty);
    audit.checks.push(cpuinfo_check(cpuinfo));

    let version = sections.get("VERSION").unwrap_or(&empty);
    audit.checks.push(version_check(version));

    let gl = sections.get("GLES").unwrap_or(&empty);
    audit.checks.push(gl_check(gl, profile.as_ref()));

    let sensors = sections.get("SENSORS").unwrap_or(&empty);
    audit.checks.push(sensors_check(sensors));

    let props = sections.get("PROPS").unwrap_or(&empty);
    let (fingerprint, patch) = parse_props(props);
    audit
        .checks
        .push(identity_check(&fingerprint, profile.as_ref()));
    audit.checks.push(patch_check(&patch));

    let mac = sections.get("MAC").unwrap_or(&empty);
    let (wlan, eth) = parse_macs(mac);
    audit.checks.push(mac_check(&wlan, &eth));

    let hostname = sections.get("HOSTNAME").unwrap_or(&empty);
    audit.checks.push(hostname_check(hostname));

    let dns = sections.get("DNS").unwrap_or(&empty);
    audit.checks.push(dns_check(dns));

    let telephony = sections.get("TELEPHONY").unwrap_or(&empty);
    audit.checks.push(telephony_check(telephony));

    // Group by category for the UI table (stable within a category).
    audit.checks.sort_by_key(|c| category_rank(&c.category));
    audit
}

fn category_of(id: &str) -> &'static str {
    match id {
        "cgroup" => "cgroup",
        "qemu" => "props",
        "cpuinfo" => "cpu",
        "version" => "kernel",
        "gl" => "gl",
        "sensors" => "sensors",
        "fingerprint" => "identity",
        "securityPatch" | "mac" => "attestation",
        "hostname" | "dns" => "network",
        "telephony" => "telephony",
        _ => "other",
    }
}

/// Split `==NAME==`-delimited sections into a map. Sections missing from the
/// output are simply absent.
fn split_sections(output: &str) -> BTreeMap<&str, String> {
    let mut sections: BTreeMap<&str, String> = BTreeMap::new();
    let mut current: Option<&str> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("==") && trimmed.ends_with("==") && trimmed.len() > 4 {
            let name = &trimmed[2..trimmed.len() - 2];
            current = Some(name);
            sections.entry(name).or_default();
            continue;
        }
        if let Some(name) = current {
            let entry = sections.entry(name).or_default();
            if !entry.is_empty() {
                entry.push('\n');
            }
            entry.push_str(line);
        }
    }
    sections
}

fn detail_excerpt(content: &str) -> String {
    let first = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut out: String = first.chars().take(140).collect();
    if first.chars().count() > 140 {
        out.push('…');
    }
    out
}

fn check(id: &str, verdict: &str, detail: String) -> AuditCheck {
    AuditCheck {
        id: id.into(),
        category: category_of(id).into(),
        verdict: verdict.into(),
        detail,
    }
}

/// /proc/self/cgroup of the *shell* process. `docker` inside → the shell runs
/// in a container cgroup — a strong leak. Note: this is the shell's own
/// cgroup; the app-process cleanup is DeviceCloak's job.
fn cgroup_check(content: &str) -> AuditCheck {
    let lower = content.to_ascii_lowercase();
    if lower.contains("docker") {
        check(
            "cgroup",
            "fail",
            format!(
                "shell 进程 cgroup 含 docker：{}（本检查读的是 shell 进程自身的 cgroup；应用进程净化由 Zygisk 模块负责）",
                detail_excerpt(content)
            ),
        )
    } else if content.trim().is_empty() {
        check("cgroup", "unknown", "无法读取 /proc/self/cgroup".into())
    } else {
        check(
            "cgroup",
            "pass",
            format!("shell cgroup 未暴露容器特征：{}", detail_excerpt(content)),
        )
    }
}

/// ro.kernel.qemu / ro.boot.qemu — both empty on a properly hardened guest.
fn qemu_check(content: &str) -> AuditCheck {
    let values: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if values.is_empty() {
        check(
            "qemu",
            "pass",
            "ro.kernel.qemu / ro.boot.qemu 均为空".into(),
        )
    } else {
        check(
            "qemu",
            "fail",
            format!("qemu 属性残留：{}", values.join(" / ")),
        )
    }
}

/// /proc/cpuinfo must not advertise x86 to a fingerprinting reader.
fn cpuinfo_check(content: &str) -> AuditCheck {
    let lower = content.to_ascii_lowercase();
    if lower.contains("genuineintel") || lower.contains("authenticamd") || lower.contains("x86") {
        check(
            "cpuinfo",
            "fail",
            format!("/proc/cpuinfo 暴露 x86 特征：{}", detail_excerpt(content)),
        )
    } else if lower.contains("aarch64") || lower.contains("armv") {
        check(
            "cpuinfo",
            "pass",
            "cpuinfo 显示 ARM 架构（或已被 bind-mount 覆盖）".into(),
        )
    } else if content.trim().is_empty() {
        check("cpuinfo", "unknown", "无法读取 /proc/cpuinfo".into())
    } else {
        check(
            "cpuinfo",
            "unknown",
            format!("cpuinfo 架构未知：{}", detail_excerpt(content)),
        )
    }
}

/// /proc/version often embeds the image's kernel build strings.
fn version_check(content: &str) -> AuditCheck {
    let lower = content.to_ascii_lowercase();
    if lower.contains("redroid") || lower.contains("generic") {
        check(
            "version",
            "fail",
            format!(
                "/proc/version 含 redroid/generic 字样：{}",
                detail_excerpt(content)
            ),
        )
    } else if content.trim().is_empty() {
        check("version", "unknown", "无法读取 /proc/version".into())
    } else {
        check(
            "version",
            "pass",
            format!("内核版本未见已知容器字样：{}", detail_excerpt(content)),
        )
    }
}

/// SurfaceFlinger reports the *real* renderer regardless of app-level hooks.
///
/// Verdict tiers: a software renderer (SwiftShader / softpipe / llvmpipe) is a
/// hard `fail` — a flagship fingerprint reporting SwiftShader is one of the
/// loudest emulator tells, and the detail points at the GPU-passthrough
/// option as the remedy; no GLES line at all is `unknown`; anything else
/// passes.
fn gl_check(content: &str, profile: Option<&SpoofProfile>) -> AuditCheck {
    let lower = content.to_ascii_lowercase();
    let expectation = profile
        .map(|p| {
            let (renderer, _, _) = cloak::gl_for(&p.brand, &p.manufacturer);
            format!("（档案 {} 期望 GPU：{renderer}）", p.id)
        })
        .unwrap_or_default();
    let software_hint = "软渲染，可被识别为模拟器特征；创建实例时勾选「GPU 透传」可换用宿主 GPU（需宿主具备直通条件，Windows+WSL2 下视内核而定）";
    if lower.contains("swiftshader") || lower.contains("softpipe") || lower.contains("llvmpipe") {
        check(
            "gl",
            "fail",
            format!(
                "SurfaceFlinger 报告软件渲染器：{}{expectation}\n{software_hint}",
                detail_excerpt(content)
            ),
        )
    } else if content.trim().is_empty() {
        check(
            "gl",
            "unknown",
            "未能从 SurfaceFlinger 读取 GLES 信息".into(),
        )
    } else {
        check(
            "gl",
            "pass",
            format!(
                "SurfaceFlinger 未见软件渲染器字样：{}{expectation}",
                detail_excerpt(content)
            ),
        )
    }
}

/// dumpsys sensorservice greps for accelerometer handles — empty means the
/// HAL exposes no accelerometer at all.
fn sensors_check(content: &str) -> AuditCheck {
    let lower = content.to_ascii_lowercase();
    if lower.contains("accel") {
        check(
            "sensors",
            "pass",
            format!("sensor HAL 暴露加速度计：{}", detail_excerpt(content)),
        )
    } else if content.trim().is_empty() {
        check(
            "sensors",
            "fail",
            "dumpsys sensorservice 中未见加速度计（HAL 层缺失）".into(),
        )
    } else {
        check("sensors", "fail", "传感器服务无加速度计条目".into())
    }
}

/// `fp=…` / `patch=…` lines from the PROPS section.
fn parse_props(content: &str) -> (String, String) {
    let mut fingerprint = String::new();
    let mut patch = String::new();
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("fp=") {
            fingerprint = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("patch=") {
            patch = v.trim().to_string();
        }
    }
    (fingerprint, patch)
}

fn identity_check(fingerprint: &str, profile: Option<&SpoofProfile>) -> AuditCheck {
    let expectation = profile
        .map(|p| format!("（档案 {} 期望：{}）", p.id, p.build_fingerprint))
        .unwrap_or_default();
    let fp = fingerprint.trim();
    if fp.is_empty() {
        return check("fingerprint", "fail", "ro.build.fingerprint 为空".into());
    }
    if fp.to_ascii_lowercase().contains("redroid") {
        return check(
            "fingerprint",
            "fail",
            format!("fingerprint 含 redroid 字样：{fp}"),
        );
    }
    let mismatch = profile.map(|p| p.build_fingerprint != fp).unwrap_or(false);
    if mismatch {
        check(
            "fingerprint",
            "pass",
            format!("fingerprint 已伪装但与所选档案不一致：{fp} {expectation}"),
        )
    } else {
        check(
            "fingerprint",
            "pass",
            format!("fingerprint 已伪装：{fp} {expectation}"),
        )
    }
}

/// Empty security_patch can't anchor a Play-certificate baseline — flagged as
/// unknown rather than fail (it is a weaker signal than the others).
fn patch_check(patch: &str) -> AuditCheck {
    if patch.trim().is_empty() {
        check(
            "securityPatch",
            "unknown",
            "ro.build.version.security_patch 为空，无法核验证书基线".into(),
        )
    } else {
        check(
            "securityPatch",
            "pass",
            format!("security_patch = {}", patch.trim()),
        )
    }
}

fn parse_macs(content: &str) -> (String, String) {
    let values: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let wlan = values.first().copied().unwrap_or("").to_string();
    let eth = values.get(1).copied().unwrap_or("").to_string();
    (wlan, eth)
}

/// wlan0 is the interface a real phone exposes; containers usually have eth0
/// only — that difference is annotated, not hidden.
fn mac_check(wlan: &str, eth: &str) -> AuditCheck {
    if !wlan.trim().is_empty() {
        return check("mac", "pass", format!("wlan0 MAC 存在：{}", wlan.trim()));
    }
    if !eth.trim().is_empty() {
        check(
            "mac",
            "fail",
            format!(
                "无 wlan0，仅 eth0（{}）——真机普遍暴露 wlan0，容器网卡名是可识别特征",
                eth.trim()
            ),
        )
    } else {
        check("mac", "fail", "wlan0 与 eth0 地址均无法读取".into())
    }
}

/// `hn=…` from the HOSTNAME section.
fn parse_hostname(content: &str) -> String {
    for line in content.lines() {
        if let Some(v) = line.trim().strip_prefix("hn=") {
            return v.trim().to_string();
        }
    }
    String::new()
}

/// True when `value` looks like the default Docker hostname (12 hex chars =
/// first 12 of the container id).
fn looks_like_container_id(value: &str) -> bool {
    value.len() == 12 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// `net.hostname` must not carry the container's default id-ish hostname.
/// `None`-ish (empty) is `unknown` rather than `fail`: stock Android also
/// leaves it unset on some images, so emptiness alone proves nothing.
fn hostname_check(content: &str) -> AuditCheck {
    let value = parse_hostname(content);
    if value.is_empty() {
        return check(
            "hostname",
            "unknown",
            "net.hostname 为空（真机/部分镜像默认也为空，无法据此判定）".into(),
        );
    }
    let lower = value.to_ascii_lowercase();
    if looks_like_container_id(&lower) {
        return check(
            "hostname",
            "fail",
            format!(
                "net.hostname = {value} —— 12 位 hex 是 Docker 容器短 ID 特征（创建实例时参数化 hostname 可改善）"
            ),
        );
    }
    if lower.contains("docker") || lower == "localhost" {
        return check(
            "hostname",
            "fail",
            format!("net.hostname = {value} —— 命中容器默认主机名特征"),
        );
    }
    if lower.starts_with("android-") {
        return check(
            "hostname",
            "pass",
            format!("net.hostname 已参数化为品牌派生值：{value}"),
        );
    }
    check(
        "hostname",
        "unknown",
        format!("net.hostname = {value}（非已知容器特征，也未匹配派生规则）"),
    )
}

/// `dns1=…` / `dns2=…` from the DNS section.
fn parse_dns(content: &str) -> (String, String) {
    let (mut dns1, mut dns2) = (String::new(), String::new());
    for line in content.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("dns1=") {
            dns1 = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("dns2=") {
            dns2 = v.trim().to_string();
        }
    }
    (dns1, dns2)
}

/// DNS existence check only — the audit deliberately does **not** judge
/// whether the resolver matches the per-instance rotation pool (that would
/// duplicate deployment config knowledge the shell cannot verify reliably).
/// Both props empty → `unknown`.
fn dns_check(content: &str) -> AuditCheck {
    let (dns1, dns2) = parse_dns(content);
    if dns1.is_empty() && dns2.is_empty() {
        return check(
            "dns",
            "unknown",
            "未能读取 net.dns1 / net.dns2（属性为空，无法判定 DNS 是否已配置）".into(),
        );
    }
    let mut parts = Vec::new();
    if !dns1.is_empty() {
        parts.push(format!("net.dns1={dns1}"));
    }
    if !dns2.is_empty() {
        parts.push(format!("net.dns2={dns2}"));
    }
    check(
        "dns",
        "pass",
        format!(
            "{}（仅检查存在性；与预设 DNS 池的一致性不做判定）",
            parts.join(" / ")
        ),
    )
}

/// `dumpsys telephony.registry` — honest delimiter check.
///
/// The values (`mCallState` / `mServiceState`) live in the telephony
/// service's in-memory state. `/proc`-level or `resetprop`-level spoofing
/// cannot change them, so this check never reports `pass`: it reports the
/// measured state as `unknown` and names the gap (Java-layer
/// `TelephonyHooks` covers API readers; a fraud engine that reads this dump
/// directly is a documented hard wall).
fn telephony_check(content: &str) -> AuditCheck {
    let excerpt = detail_excerpt(content);
    if excerpt.is_empty() {
        return check(
            "telephony",
            "unknown",
            "未能读取 dumpsys telephony.registry（服务不可用或被裁剪）".into(),
        );
    }
    check(
        "telephony",
        "unknown",
        format!(
            "信令态：{excerpt}\n底层信令态来自 telephony 服务内存，shell/resetprop 层不可伪装；DeviceCloak TelephonyHooks 已盖 Java API 读取 —— 强风控若直读本层为已知缺口"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_split_on_markers() {
        let out = "==A==\nline1\nline2\n==B==\nx\n==END==\n";
        let sections = split_sections(out);
        assert_eq!(sections.get("A").unwrap(), "line1\nline2");
        assert_eq!(sections.get("B").unwrap(), "x");
        assert_eq!(sections.get("END").unwrap(), "");
        assert!(sections.get("C").is_none());
    }

    #[test]
    fn cgroup_verdicts() {
        let check = cgroup_check("12:pids:/docker/abc123\n0::/system.slice/docker.service");
        assert_eq!(check.verdict, "fail");
        assert!(check.detail.contains("Zygisk"));

        let check = cgroup_check("0::/system.slice/app");
        assert_eq!(check.verdict, "pass");

        let check = cgroup_check("   ");
        assert_eq!(check.verdict, "unknown");
    }

    #[test]
    fn qemu_verdicts() {
        let check = qemu_check("1\n\n");
        assert_eq!(check.verdict, "fail");
        assert!(check.detail.contains('1'));

        let check = qemu_check("\n \n");
        assert_eq!(check.verdict, "pass");
    }

    #[test]
    fn cpuinfo_verdicts() {
        assert_eq!(
            cpuinfo_check("vendor_id\t: GenuineIntel\nflags: sse4_2").verdict,
            "fail"
        );
        assert_eq!(cpuinfo_check("CPU part\t: 0xd05\naarch64").verdict, "pass");
        assert_eq!(cpuinfo_check("").verdict, "unknown");
    }

    #[test]
    fn version_verdicts() {
        assert_eq!(
            version_check("Linux version 5.10.0-redroid #1 SMP").verdict,
            "fail"
        );
        assert_eq!(
            version_check("Linux version 5.15.0-generic #1").verdict,
            "fail"
        );
        assert_eq!(
            version_check("Linux version 5.15.0-android13-ab123 #1 SMP").verdict,
            "pass"
        );
    }

    #[test]
    fn gl_verdicts() {
        assert_eq!(
            gl_check("GLES:0, Android Emulator (SwiftShader)", None).verdict,
            "fail"
        );
        assert_eq!(
            gl_check("GLES:0, Adreno (TM) 740, OpenGL ES 3.2", None).verdict,
            "pass"
        );
        assert_eq!(gl_check("", None).verdict, "unknown");

        // profile expectation annotation
        let profile = spoof::profile_by_id("samsung-galaxy-s23").unwrap();
        let check = gl_check("GLES:0, Adreno (TM) 740", Some(&profile));
        assert_eq!(check.verdict, "pass");
        assert!(check.detail.contains("Xclipse 920"));
    }

    #[test]
    fn sensors_verdicts() {
        assert_eq!(
            sensors_check("0x00000001) Accelerometer sensor = ...").verdict,
            "pass"
        );
        assert_eq!(sensors_check("").verdict, "fail");
        assert_eq!(sensors_check("Sensors: none of interest").verdict, "fail");
    }

    #[test]
    fn identity_verdicts() {
        assert_eq!(identity_check("", None).verdict, "fail");
        assert_eq!(
            identity_check("redroid/x86/x86:13/XXX/0:user/release-keys", None).verdict,
            "fail"
        );

        let profile = spoof::profile_by_id("redmi-k40-alioth").unwrap();
        let matching = identity_check(&profile.build_fingerprint, Some(&profile));
        assert_eq!(matching.verdict, "pass");
        assert!(matching.detail.contains(&profile.build_fingerprint));

        let mismatch = identity_check(
            "Xiaomi/other/other:13/B/I:user/release-keys",
            Some(&profile),
        );
        assert_eq!(mismatch.verdict, "pass");
        assert!(mismatch.detail.contains("不一致"));
    }

    #[test]
    fn patch_verdicts() {
        assert_eq!(patch_check("").verdict, "unknown");
        assert_eq!(patch_check("2023-11-01").verdict, "pass");
    }

    #[test]
    fn mac_verdicts() {
        assert_eq!(mac_check("aa:bb:cc:dd:ee:ff", "").verdict, "pass");

        let container = mac_check("", "02:15:5d:01:02:03");
        assert_eq!(container.verdict, "fail");
        assert!(container.detail.contains("eth0"));

        assert_eq!(mac_check("", "").verdict, "fail");
    }

    #[test]
    fn props_and_macs_parse_from_section_text() {
        let (fp, patch) =
            parse_props("fp=Xiaomi/alioth/alioth:13/B/V:user/release-keys\npatch=2023-11-01");
        assert!(fp.starts_with("Xiaomi/alioth"));
        assert_eq!(patch, "2023-11-01");

        let (wlan, eth) = parse_macs("02:15:5d:aa:bb:cc\n02:15:5d:11:22:33");
        assert_eq!(wlan, "02:15:5d:aa:bb:cc");
        assert_eq!(eth, "02:15:5d:11:22:33");
    }

    #[test]
    fn every_check_id_has_a_category() {
        for id in [
            "cgroup",
            "qemu",
            "cpuinfo",
            "version",
            "gl",
            "sensors",
            "fingerprint",
            "securityPatch",
            "mac",
            "hostname",
            "dns",
            "telephony",
        ] {
            assert_ne!(category_of(id), "other", "category missing for {id}");
        }
    }

    #[test]
    fn gl_fail_detail_names_gpu_passthrough_remedy() {
        let check = gl_check("GLES:0, Android Emulator (SwiftShader)", None);
        assert_eq!(check.verdict, "fail");
        assert!(
            check.detail.contains("GPU 透传"),
            "fail detail must name the remedy"
        );
        assert!(check.detail.contains("WSL2"));
    }

    #[test]
    fn hostname_verdicts() {
        // Docker short-id default (12 hex) is the loud fail.
        let check = hostname_check("hn=3f2b1a4c9d7e");
        assert_eq!(check.verdict, "fail");
        assert!(check.detail.contains("短 ID"));

        assert_eq!(hostname_check("hn=localhost").verdict, "fail");
        assert_eq!(hostname_check("hn=my-docker-bridge").verdict, "fail");

        // Parameterized brand-derived hostname passes.
        let check = hostname_check("hn=android-xiaomi-55");
        assert_eq!(check.verdict, "pass");
        assert!(check.detail.contains("android-xiaomi-55"));

        // Empty and unrecognized values are honest unknowns.
        assert_eq!(hostname_check("hn=").verdict, "unknown");
        assert_eq!(hostname_check("").verdict, "unknown");
        assert_eq!(hostname_check("hn=mypc").verdict, "unknown");
    }

    #[test]
    fn dns_verdicts() {
        assert_eq!(dns_check("dns1=1.1.1.1\ndns2=8.8.8.8").verdict, "pass");
        let single = dns_check("dns1=9.9.9.9");
        assert_eq!(single.verdict, "pass");
        assert!(single.detail.contains("net.dns1=9.9.9.9"));
        assert!(
            single.detail.contains("不"),
            "detail must note consistency is not judged"
        );

        let empty = dns_check("dns1=\ndns2=");
        assert_eq!(empty.verdict, "unknown");
        assert_eq!(dns_check("").verdict, "unknown");
    }

    #[test]
    fn telephony_verdicts_never_pass() {
        let check = telephony_check("mCallState=0\nmServiceState=1 1 46000 ...");
        assert_eq!(check.verdict, "unknown");
        assert!(check.detail.contains("mCallState=0"));
        assert!(check.detail.contains("TelephonyHooks"));
        assert!(check.detail.contains("已知缺口"));

        let missing = telephony_check("   ");
        assert_eq!(missing.verdict, "unknown");
        assert!(missing.detail.contains("未能读取"));
    }

    #[test]
    fn checks_are_grouped_by_category() {
        // Insertion order across categories, deliberately shuffled.
        let mut audit = AdversarialAudit::default();
        audit.checks = vec![
            AuditCheck {
                id: "mac".into(),
                category: "attestation".into(),
                verdict: "pass".into(),
                detail: String::new(),
            },
            AuditCheck {
                id: "cgroup".into(),
                category: "cgroup".into(),
                verdict: "pass".into(),
                detail: String::new(),
            },
            AuditCheck {
                id: "dns".into(),
                category: "network".into(),
                verdict: "pass".into(),
                detail: String::new(),
            },
            AuditCheck {
                id: "cpuinfo".into(),
                category: "cpu".into(),
                verdict: "pass".into(),
                detail: String::new(),
            },
            AuditCheck {
                id: "hostname".into(),
                category: "network".into(),
                verdict: "pass".into(),
                detail: String::new(),
            },
            AuditCheck {
                id: "telephony".into(),
                category: "telephony".into(),
                verdict: "unknown".into(),
                detail: String::new(),
            },
        ];
        audit.checks.sort_by_key(|c| category_rank(&c.category));
        let ids: Vec<&str> = audit.checks.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["cgroup", "cpuinfo", "mac", "dns", "hostname", "telephony"],
            "categories must come out grouped (stable: dns/hostname keep insertion order)"
        );
    }
}
