//! L3 container trace cleansing ("容器痕迹清理").
//!
//! A redroid container built from a generic x86_64 image leaks its hosts'
//! kernel identity through several files that `resetprop` cannot touch:
//! `/proc/cpuinfo` (GenuineIntel + x86 flags), `/proc/version` (generic
//! Android/x86 build string) and `/proc/self/cgroup` (docker paths).
//!
//! This module generates per-profile *fake* `/proc/cpuinfo` and `/proc/version`
//! contents in the style of the spoofed device's SoC/platform. `docker.rs`
//! bind-mounts them read-only into the container at create time. cgroup paths
//! cannot be masked by a bind mount (the kernel regenerates them), so the
//! `--cgroup-parent system.slice` flag only makes them *look* like a systemd
//! service — full masking needs the native Zygisk module under
//! `vendor/zygisk-module/` (PLT-hooks `openat`).
//!
//! The generated text is deterministic (no timestamps/randomness) so tests can
//! assert on it and two containers of the same profile get identical bytes.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::DateTime;

use crate::models::SpoofProfile;
use crate::services::util;

/// One CPU cluster in the generated `/proc/cpuinfo` "big.LITTLE" layout:
/// `(core_count, cpu_part, variant, cluster_name)`.
///
/// `CPU part` values are the ARM MIDR part numbers real kernels report:
/// Cortex-X3 = 0xd4e, Cortex-A715 = 0xd4d, Cortex-A510 = 0xd46,
/// Cortex-X2 = 0xd48, Cortex-A710 = 0xd47.
struct Cluster {
    count: usize,
    part: &'static str,
    variant: &'static str,
}

/// SoC identity used to render both `/proc/cpuinfo` and `/proc/version`.
struct SocSpec {
    /// Kernel release string fragment, e.g. `5.15.94-android13-8-g...`.
    kernel_release: String,
    /// The `Hardware :` line (vendor-specific).
    hardware: String,
    /// CPU implementer (0x41 = ARM Ltd. for all Cortex designs).
    implementer: &'static str,
    /// 1 super-core + 4 big cores + 3 little cores = 8 processors.
    clusters: [Cluster; 3],
    /// `Features :` line — the arm64 feature set these cores expose.
    features: &'static str,
    /// Kernel build host/compiler line (vendor-flavoured clang).
    build_info: String,
}

/// arm64 features common to X3/A715/A510 (ARMv9 + crypto + SVE2).
const ARM64_FEATURES: &str = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 sve asimdfhm dit uscat ilrcpc flagm ssbs sb paca pacg dcpodp sve2 sveaes svepmull svebitperm svesha3 svesm4 flagm2 frint i8mm bf16 dgh rng bti";

/// Map a spoof profile's brand/manufacturer to a plausible 2023-era flagship
/// SoC. Unknown brands fall back to SM8550 (the most common arm64 Android
/// flagship part, and what most anti-cheat reference databases list first).
fn soc_for(p: &SpoofProfile) -> SocSpec {
    let b = p.brand.to_ascii_lowercase();
    let m = p.manufacturer.to_ascii_lowercase();
    // MediaTek designs (Mali GPU, MT-prefixed parts).
    if b.contains("mediatek") || m.contains("mediatek") {
        return SocSpec {
            kernel_release: format!("5.15.78-android{}-8-00005-g3f2b1a4c9d7e-ab10741320", p.android_version),
            hardware: "MT6985".into(),
            implementer: "0x41",
            clusters: [
                Cluster { count: 1, part: "0xd4e", variant: "0x1" }, // Cortex-X3
                Cluster { count: 4, part: "0xd4d", variant: "0x0" }, // Cortex-A715
                Cluster { count: 3, part: "0xd46", variant: "0x0" }, // Cortex-A510
            ],
            features: ARM64_FEATURES,
            build_info: format!(
                "Linux version 5.15.78-android{}-8-00005-g3f2b1a4c9d7e-ab10741320 (build-user@mtk-build) (Android (8508608, based on r450784e) clang version 14.0.7 (https://android.googlesource.com/toolchain/llvm-project 4c603efb0cca074e9238af8b4106c30add4418f6), LLD 14.0.7) #1 SMP PREEMPT Wed Nov 1 08:00:00 UTC 2023",
                p.android_version
            ),
        };
    }
    // Google Tensor (Pixel) — Exynos-derived, Google kernel build string.
    if b.contains("google") || m.contains("google") || b.contains("pixel") {
        return SocSpec {
            kernel_release: format!("5.15.110-android{}-4-g0000000ab1234567", p.android_version),
            hardware: "Google Tensor G3".into(),
            implementer: "0x41",
            clusters: [
                Cluster { count: 1, part: "0xd4e", variant: "0x1" }, // Cortex-X3
                Cluster { count: 4, part: "0xd4d", variant: "0x0" }, // Cortex-A715
                Cluster { count: 3, part: "0xd46", variant: "0x0" }, // Cortex-A510
            ],
            features: ARM64_FEATURES,
            build_info: format!(
                "Linux version 5.15.110-android{}-4-g0000000ab1234567 (android-build@abfarm-009) (Android (8888872, based on r487747) clang version 15.0.7 (https://android.googlesource.com/toolchain/llvm-project c56ef6e9f0a3f1d1b2a4c6e8f0a2b4c6d8e0f2a4), LLD 15.0.7) #1 SMP PREEMPT Mon Oct 30 09:00:00 UTC 2023",
                p.android_version
            ),
        };
    }
    // Samsung Exynos (S5E9925 = Exynos 2200).
    if b.contains("samsung") || m.contains("samsung") {
        return SocSpec {
            kernel_release: format!("5.10.101-android{}-5-27443413-abS9110ZCU1BWL1", p.android_version),
            hardware: "Samsung Exynos 2200".into(),
            implementer: "0x41",
            clusters: [
                Cluster { count: 1, part: "0xd48", variant: "0x2" }, // Cortex-X2
                Cluster { count: 4, part: "0xd47", variant: "0x0" }, // Cortex-A710
                Cluster { count: 3, part: "0xd46", variant: "0x0" }, // Cortex-A510
            ],
            features: ARM64_FEATURES,
            build_info: format!(
                "Linux version 5.10.101-android{}-5-27443413-abS9110ZCU1BWL1 (dpi@SWDG5320) (Android (8508608, based on r450784e) clang version 14.0.7 (https://android.googlesource.com/toolchain/llvm-project 4c603efb0cca074e9238af8b4106c30add4418f6), LLD 14.0.7) #1 SMP PREEMPT Tue Nov 7 05:30:00 KST 2023",
                p.android_version
            ),
        };
    }
    // Default: Qualcomm Snapdragon 8 Gen 2 (SM8550).
    SocSpec {
        kernel_release: format!("5.15.94-android{}-8-g0e2f5f7f9a1b-ab12345678", p.android_version),
        hardware: "Qualcomm Technologies, Inc SM8550".into(),
        implementer: "0x41",
        clusters: [
            Cluster { count: 1, part: "0xd4e", variant: "0x1" }, // Cortex-X3
            Cluster { count: 4, part: "0xd4d", variant: "0x0" }, // Cortex-A715
            Cluster { count: 3, part: "0xd46", variant: "0x0" }, // Cortex-A510
        ],
        features: ARM64_FEATURES,
        build_info: format!(
            "Linux version 5.15.94-android{}-8-g0e2f5f7f9a1b-ab12345678 (build-user@qcom-build) (Android (8508608, based on r450784e) clang version 14.0.7 (https://android.googlesource.com/toolchain/llvm-project 4c603efb0cca074e9238af8b4106c30add4418f6), LLD 14.0.7) #1 SMP PREEMPT Fri Aug 4 10:00:00 UTC 2023",
            p.android_version
        ),
    }
}

/// Render an ARM-style `/proc/cpuinfo` for the profile's SoC.
///
/// Layout: one `processor` block per core (8 total: 1 super + 4 big + 3
/// little), followed by the vendor `Hardware` line. Deliberately contains no
/// `GenuineIntel`/`x86` markers — that is the whole point of the file.
pub fn fake_cpuinfo_for(p: &SpoofProfile) -> String {
    let soc = soc_for(p);
    let mut out = String::new();
    let mut idx = 0usize;
    // Highest-index cores are the little cluster; the kernel numbers them
    // super-core first, matching real arm64 DSU layouts.
    for cluster in &soc.clusters {
        for _ in 0..cluster.count {
            out.push_str(&format!("processor\t: {idx}\n"));
            out.push_str("BogoMIPS\t: 38.40\n");
            out.push_str(&format!("Features\t: {}\n", soc.features));
            out.push_str(&format!("CPU implementer\t: {}\n", soc.implementer));
            out.push_str("CPU architecture: 8\n");
            out.push_str(&format!("CPU variant\t: {}\n", cluster.variant));
            out.push_str(&format!("CPU part\t: {}\n", cluster.part));
            out.push_str("CPU revision\t: 0\n\n");
            idx += 1;
        }
    }
    out.push_str(&format!("Hardware\t: {}\n", soc.hardware));
    out
}

/// Render a `/proc/version` line matching the profile's platform. The string
/// carries the spoofed Android version (`-android<version>-`) plus a clang
/// build marker, mirroring how vendor kernels are stamped.
pub fn fake_version_for(p: &SpoofProfile) -> String {
    format!("{}\n", soc_for(p).build_info)
}

/// The kernel release fragment (`5.15.94-android13-...`) for a profile — used
/// by tests and available for future `uname` spoofing.
pub fn fake_kernel_release_for(p: &SpoofProfile) -> String {
    soc_for(p).kernel_release
}

/// Per-instant directory holding the generated trace files, following the same
/// `dirs::config_dir()/RedroidDeviceCenter` convention as `services::settings`
/// and `services::spoof`.
pub fn traces_dir(name: &str) -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("RedroidDeviceCenter")
        .join("container-traces")
        .join(sanitize_trace_name(name))
}

/// Keep only characters that are safe in a path segment (defence in depth —
/// callers pass an already-sanitized container name).
fn sanitize_trace_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if cleaned.is_empty() {
        "instance".to_string()
    } else {
        cleaned
    }
}

/// Result of writing the fake trace files: the directory plus both paths, so
/// `docker.rs` can build the `-v` bind mounts without re-deriving them.
#[derive(Debug, Clone)]
pub struct TracePaths {
    pub dir: PathBuf,
    pub cpuinfo: PathBuf,
    pub version: PathBuf,
}

/// Write `cpuinfo` + `version` for a profile into the instance's trace dir.
/// Idempotent — re-creating an instance of the same name rewrites the files
/// with identical content (generation is deterministic).
pub fn write_fake_traces(container_name: &str, p: &SpoofProfile) -> Result<TracePaths, String> {
    let dir = traces_dir(container_name);
    util::ensure_dir(&dir.to_string_lossy());
    let cpuinfo = dir.join("cpuinfo");
    let version = dir.join("version");
    std::fs::write(&cpuinfo, fake_cpuinfo_for(p))
        .map_err(|e| format!("写入 {} 失败: {e}", cpuinfo.display()))?;
    std::fs::write(&version, fake_version_for(p))
        .map_err(|e| format!("写入 {} 失败: {e}", version.display()))?;
    Ok(TracePaths {
        dir,
        cpuinfo,
        version,
    })
}

/// Overwrite `path` **in place** (open + truncate + write, keeping the inode).
///
/// This matters for hot-swapping: `docker.rs` bind-mounts these files at
/// create time and a bind mount records the *inode*, not the path. A
/// temp-file-plus-rename rewrite would allocate a new inode and the container
/// would keep reading the old content forever; truncating the existing inode
/// takes effect immediately for every reader that already holds the mount.
/// The file is created when missing (a missing file means the create-time
/// mount never happened, so there is nothing to keep consistent).
fn overwrite_in_place(path: &Path, content: &str) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    file.sync_all()
        .map_err(|e| format!("刷新 {} 失败: {e}", path.display()))?;
    Ok(())
}

/// Re-generate the fake traces for an existing container after a spoof-profile
/// hot-swap (see `spoof::apply_spoof_profile`). Same deterministic content as
/// `write_fake_traces`, but written **in place** so the container's existing
/// bind mounts observe the new bytes without a restart.
pub fn regenerate_container_traces(
    container_name: &str,
    p: &SpoofProfile,
) -> Result<TracePaths, String> {
    let dir = traces_dir(container_name);
    util::ensure_dir(&dir.to_string_lossy());
    let cpuinfo = dir.join("cpuinfo");
    let version = dir.join("version");
    overwrite_in_place(&cpuinfo, &fake_cpuinfo_for(p))?;
    overwrite_in_place(&version, &fake_version_for(p))?;
    Ok(TracePaths {
        dir,
        cpuinfo,
        version,
    })
}

/// Standard external-storage directories a phone accumulates files in. Used by
/// the timestamp-baseline seeding (item: 文件时间戳基线).
const SDCARD_DIRS: &[&str] = &[
    "/sdcard/DCIM",
    "/sdcard/DCIM/Camera",
    "/sdcard/Pictures",
    "/sdcard/Download",
    "/sdcard/Documents",
    "/sdcard/Music",
    "/sdcard/Movies",
    "/sdcard/Alarms",
    "/sdcard/Notifications",
    "/sdcard/Ringtones",
    "/sdcard/Podcasts",
];

/// FNV-1a 64-bit (deterministic, no process-randomized hasher).
fn fnv1a64(data: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Minimum age of a seeded timestamp (2 days) and maximum (180 days). A phone
/// whose /sdcard files were all touched in the last hours is a "zero-history"
/// tell; these bounds give every seeded directory a plausible, distinct past.
const TOUCH_MIN_AGE_SECS: u64 = 2 * 24 * 3600;
const TOUCH_MAX_AGE_SECS: u64 = 180 * 24 * 3600;

/// Build the `touch -t` command string that back-dates the standard /sdcard
/// directories to deterministic pseudo-random past timestamps.
///
/// Per-directory determinism: the age is derived from `fnv1a64(seed|dir)`, so
/// two runs with the same (seed, now) produce identical commands (testable),
/// while different directories get different ages. `touch -t` takes
/// `[[CC]YY]MMDDhhmm[.ss]`, which is timezone-ambiguous — we deliberately set
/// `TZ=UTC` in front of the command so the timestamp is interpreted the same
/// way regardless of the container's clock.
pub fn touch_timestamp_commands(now_secs: u64, seed: &str) -> String {
    let mut out = String::from("TZ=UTC ");
    for dir in SDCARD_DIRS {
        let hash = fnv1a64(&format!("{seed}|{dir}"));
        let span = TOUCH_MAX_AGE_SECS - TOUCH_MIN_AGE_SECS;
        let age = TOUCH_MIN_AGE_SECS + hash % span;
        let ts = now_secs.saturating_sub(age);
        let stamp = DateTime::from_timestamp(ts as i64, 0)
            .map(|dt| dt.format("%Y%m%d%H%M").to_string())
            .unwrap_or_else(|| "202301010000".to_string());
        out.push_str(&format!(
            "mkdir -p {dir} 2>/dev/null; touch -t {stamp} {dir} 2>/dev/null; "
        ));
    }
    out.push_str("echo seeded-timestamps");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::spoof::profile_by_id;

    fn profile(brand: &str, manufacturer: &str, android: &str) -> SpoofProfile {
        SpoofProfile {
            id: "test".into(),
            brand: brand.into(),
            manufacturer: manufacturer.into(),
            model: "TEST".into(),
            market_name: "Test".into(),
            device: "test".into(),
            product: "test".into(),
            android_version: android.into(),
            build_fingerprint: format!(
                "{brand}/test/test:{android}/TQ3A.230805.001/1:user/release-keys"
            ),
            build_description: format!("test-user {android} TQ3A.230805.001 1 release-keys"),
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
    fn cpuinfo_never_mentions_x86_or_intel() {
        for id in ["redmi-k40-alioth", "samsung-galaxy-s23", "google-pixel-6"] {
            let p = profile_by_id(id).expect("bundled profile exists");
            let text = fake_cpuinfo_for(&p);
            let lower = text.to_ascii_lowercase();
            assert!(!lower.contains("x86"), "{id}: x86 leaked");
            assert!(!lower.contains("genuineintel"), "{id}: GenuineIntel leaked");
            assert!(!lower.contains("authenticamd"), "{id}: AuthenticAMD leaked");
            assert!(!lower.contains("htt"), "{id}: x86 HT flag leaked");
        }
    }

    #[test]
    fn cpuinfo_has_exactly_eight_processor_blocks() {
        let p = profile_by_id("redmi-k40-alioth").unwrap();
        let text = fake_cpuinfo_for(&p);
        let blocks = text.matches("processor\t:").count();
        assert_eq!(blocks, 8, "expected 1 super + 4 big + 3 little cores");
        for i in 0..8 {
            assert!(text.contains(&format!("processor\t: {i}\n")), "missing core {i}");
        }
    }

    #[test]
    fn cpuinfo_hardware_line_follows_brand() {
        let qualcomm = fake_cpuinfo_for(&profile_by_id("redmi-k40-alioth").unwrap());
        assert!(qualcomm.contains("Hardware\t: Qualcomm Technologies, Inc SM8550\n"));

        let samsung = fake_cpuinfo_for(&profile_by_id("samsung-galaxy-s23").unwrap());
        assert!(samsung.contains("Hardware\t: Samsung Exynos 2200\n"));

        let google = fake_cpuinfo_for(&profile_by_id("google-pixel-6").unwrap());
        assert!(google.contains("Hardware\t: Google Tensor G3\n"));

        let mediatek = fake_cpuinfo_for(&profile("Xiaomi", "MediaTek", "13"));
        assert!(mediatek.contains("Hardware\t: MT6985\n"));
    }

    #[test]
    fn cpuinfo_carries_arm_standard_fields() {
        let text = fake_cpuinfo_for(&profile_by_id("redmi-k40-alioth").unwrap());
        for field in [
            "BogoMIPS\t:",
            "Features\t:",
            "CPU implementer\t: 0x41",
            "CPU architecture: 8",
            "CPU variant\t:",
            "CPU part\t:",
            "CPU revision\t:",
        ] {
            assert!(text.contains(field), "missing {field}");
        }
        // ARMv9 super-core part number must be present at least once.
        assert!(text.contains("CPU part\t: 0xd4e"));
        assert!(text.contains("CPU part\t: 0xd4d"));
        assert!(text.contains("CPU part\t: 0xd46"));
    }

    #[test]
    fn version_line_contains_android_version_marker_and_clang() {
        let p13 = profile_by_id("redmi-k40-alioth").unwrap();
        let v13 = fake_version_for(&p13);
        assert!(v13.starts_with("Linux version "));
        assert!(v13.contains("-android13-"), "missing android marker: {v13}");
        assert!(v13.contains("clang version"));
        assert!(v13.contains("Android ("));
        assert_eq!(v13.lines().count(), 1, "version must be a single line");

        let p14 = profile_by_id("samsung-galaxy-s23").unwrap();
        assert_eq!(p14.android_version, "14");
        assert!(fake_version_for(&p14).contains("-android14-"));
    }

    #[test]
    fn generation_is_deterministic() {
        let p = profile_by_id("xiaomi-13").unwrap();
        assert_eq!(fake_cpuinfo_for(&p), fake_cpuinfo_for(&p));
        assert_eq!(fake_version_for(&p), fake_version_for(&p));
        assert_eq!(fake_kernel_release_for(&p), fake_kernel_release_for(&p));
    }

    #[test]
    fn trace_name_sanitization_blocks_traversal() {
        assert_eq!(sanitize_trace_name("redroid-1"), "redroid-1");
        assert_eq!(sanitize_trace_name("../../etc"), "....etc");
        assert!(!sanitize_trace_name("../../etc").contains('/'));
        assert_eq!(sanitize_trace_name("  "), "instance");
    }

    #[test]
    fn write_fake_traces_creates_both_files() {
        let p = profile_by_id("redmi-k40-alioth").unwrap();
        let name = format!("rdc-trace-test-{}", uuid::Uuid::new_v4());
        let paths = write_fake_traces(&name, &p).expect("write must succeed");
        let cpuinfo = std::fs::read_to_string(&paths.cpuinfo).unwrap();
        let version = std::fs::read_to_string(&paths.version).unwrap();
        assert!(cpuinfo.contains("Qualcomm Technologies, Inc SM8550"));
        assert!(version.contains("-android13-"));
        let _ = std::fs::remove_dir_all(&paths.dir);
    }

    #[test]
    fn regenerate_rewrites_content_in_place() {
        let alioth = profile_by_id("redmi-k40-alioth").unwrap();
        let pixel = profile_by_id("google-pixel-6").unwrap();
        let name = format!("rdc-trace-regen-{}", uuid::Uuid::new_v4());
        let initial = write_fake_traces(&name, &alioth).expect("initial write must succeed");
        assert!(std::fs::read_to_string(&initial.cpuinfo)
            .unwrap()
            .contains("SM8550"));

        let regenerated = regenerate_container_traces(&name, &pixel).expect("regen must succeed");
        // Same paths (same inode, bind mounts stay valid), new content.
        assert_eq!(regenerated.cpuinfo, initial.cpuinfo);
        assert_eq!(regenerated.version, initial.version);
        let cpuinfo = std::fs::read_to_string(&regenerated.cpuinfo).unwrap();
        assert!(cpuinfo.contains("Google Tensor G3"), "content must switch profile");
        assert!(!cpuinfo.contains("SM8550"));

        // Re-running with the same profile is byte-stable (deterministic generation).
        let again = regenerate_container_traces(&name, &pixel).unwrap();
        assert_eq!(
            std::fs::read_to_string(&again.cpuinfo).unwrap(),
            std::fs::read_to_string(&regenerated.cpuinfo).unwrap()
        );
        let _ = std::fs::remove_dir_all(&initial.dir);
    }

    #[test]
    fn touch_commands_are_deterministic_and_in_range() {
        let now: u64 = 1_760_000_000; // fixed "now" so the range asserts are exact
        let a = touch_timestamp_commands(now, "rdc-alpha");
        let b = touch_timestamp_commands(now, "rdc-alpha");
        assert_eq!(a, b, "same seed must be deterministic");
        assert!(a.contains("echo seeded-timestamps"));

        // Every touch -t stamp parses and lands in [now-180d, now-2d].
        let min = now - TOUCH_MAX_AGE_SECS;
        let max = now - TOUCH_MIN_AGE_SECS;
        let mut stamps = 0;
        for part in a.split(';') {
            let part = part.trim();
            let Some(stamp) = part.strip_prefix("touch -t ").and_then(|rest| {
                rest.split_whitespace().next()
            }) else {
                continue;
            };
            assert_eq!(stamp.len(), 12, "touch -t expects YYYYMMDDhhmm: {stamp}");
            let dt = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M")
                .unwrap_or_else(|e| panic!("stamp {stamp} unparsable: {e}"));
            let secs = dt.and_utc().timestamp() as u64;
            assert!(
                (min..=max).contains(&secs),
                "stamp {stamp} outside plausible window"
            );
            stamps += 1;
        }
        assert!(stamps >= 10, "expected a stamp per standard dir, got {stamps}");

        // Different seeds must not produce identical commands (per-instance spread).
        let c = touch_timestamp_commands(now, "rdc-beta");
        assert_ne!(a, c);
        // mkdir -p precedes every touch so fresh containers get the dirs.
        assert!(a.contains("mkdir -p /sdcard/DCIM 2>/dev/null; touch -t "));
        assert!(a.contains("/sdcard/Download") && a.contains("/sdcard/Alarms"));
    }
}
