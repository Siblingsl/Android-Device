//! Usage-stats baseline seeding ("使用基线伪造").
//!
//! A freshly created container has *zero* `UsageStats` history — every app
//! reports "installed 5 minutes ago, never used", which is one of the loudest
//! "this is a farm instance" tells. Writing real files under
//! `/data/system/usagestats` is not viable: the directory is owned and
//! rebuilt by the system server (ART/UsageStatsService), and anything we drop
//! there is discarded (or corrupts the store) on the next boot.
//!
//! The pragmatic split:
//!
//! 1. **Desktop (this module)** seeds the *inputs*: a package list of common
//!    apps (brand-distributed) at `/data/local/tmp/rdc-cloak/usage-pkg-list`,
//!    a README for operators, and back-dated `/sdcard` directory timestamps
//!    (via `traces::touch_timestamp_commands`).
//! 2. **DeviceCloak** (`vendor/lsposed-module` → `UsagestatsHooks`) consumes
//!    that list inside the target app's process: `UsageStatsManager#queryUsageStats
//!    /queryEvents` are hooked to synthesize baseline records whose
//!    install/last-use times fall within `usage.seededDays` from
//!    `/data/local/tmp/rdc-cloak.json` (default 90), pseudo-random but
//!    *stable per package*.
//!
//! The desktop never writes `/data/system/usagestats` itself — see README in
//! the seeded bundle.

use std::time::Duration;

use crate::models::{ShellResult, SpoofProfile};
use crate::services::{docker, log, root, traces, util};

/// On-device staging dir shared with the Zygisk/LSPosed modules (created 0777
/// by the NativeCloak `customize.sh`; re-chmodded defensively here).
pub const USAGE_DIR_REMOTE: &str = "/data/local/tmp/rdc-cloak";
/// One package name per line; consumed by DeviceCloak's UsagestatsHooks.
pub const USAGE_PKG_LIST_REMOTE: &str = "/data/local/tmp/rdc-cloak/usage-pkg-list";
/// Operator-facing explanation bundled next to the list.
pub const USAGE_README_REMOTE: &str = "/data/local/tmp/rdc-cloak/usage-README.txt";

/// Default window (days) the module spreads seeded activity across. Mirrors
/// the `usage.seededDays` default in `cloak::render_cloak_config`.
pub const DEFAULT_SEED_DAYS: u32 = 90;

/// Cross-brand baseline: system apps + widely-distributed third-party apps.
/// Kept deliberately static (no RNG) so the generated list is deterministic
/// and diffable.
const BASE_PACKAGES: &[&str] = &[
    "com.android.chrome",
    "com.android.vending",
    "com.android.settings",
    "com.android.deskclock",
    "com.android.calendar",
    "com.android.contacts",
    "com.android.dialer",
    "com.android.mms",
    "com.android.email",
    "com.android.gallery3d",
    "com.android.music",
    "com.google.android.gm",
    "com.google.android.youtube",
    "com.google.android.apps.photos",
    "com.google.android.apps.maps",
    "com.google.android.calendar",
    "com.google.android.deskclock",
    "com.google.android.apps.translate",
    "com.google.android.apps.docs",
    "com.google.android.videos",
    "com.google.android.googlequicksearchbox",
    "com.tencent.mm",
    "com.tencent.mobileqq",
    "com.eg.android.AlipayGphone",
    "com.taobao.taobao",
    "com.sina.weibo",
    "com.ss.android.ugc.aweme",
    "com.ss.android.article.news",
    "com.netease.cloudmusic",
    "com.jingdong.app.mall",
    "com.autonavi.minimap",
    "tv.danmaku.bili",
];

/// Brand-specific additions. The first matching entry wins, so put the more
/// specific matchers first (e.g. OPPO before generic OnePlus).
const BRAND_PACKAGES: &[(&[&str], &[&str])] = &[
    (
        &["xiaomi", "redmi", "poco"],
        &[
            "com.miui.home",
            "com.miui.securitycenter",
            "com.miui.gallery",
            "com.miui.notes",
            "com.miui.weather2",
            "com.miui.calculator",
            "com.miui.compass",
            "com.miui.screenrecorder",
            "com.xiaomi.market",
            "com.xiaomi.scanner",
            "com.mipay.wallet",
            "com.xiaomi.pass",
        ],
    ),
    (
        &["samsung"],
        &[
            "com.sec.android.app.launcher",
            "com.samsung.android.messaging",
            "com.samsung.android.camera",
            "com.sec.android.app.sbrowser",
            "com.samsung.android.calendar",
            "com.samsung.android.smartswitchassistant",
            "com.samsung.android.spay",
            "com.samsung.android.app.notes",
            "com.samsung.android.game.gamelauncher",
            "com.samsung.android.membership",
        ],
    ),
    (
        &["honor", "huawei"],
        &[
            "com.hihonor.android.launcher",
            "com.hihonor.health",
            "com.hihonor.market",
            "com.hihonor.cloudservice",
            "com.hihonor.phoneclone",
            "com.hihonor.notepad",
            "com.huawei.health",
            "com.huawei.appmarket",
        ],
    ),
    (
        &["oppo", "oneplus", "realme"],
        &[
            "com.coloros.filemanager",
            "com.coloros.weather",
            "com.coloros.notes",
            "com.coloros.gallery3d",
            "com.oneplus.bbs",
            "com.oneplus.account",
            "com.heytap.market",
            "com.nearme.statistics.rom",
        ],
    ),
    (
        &["vivo", "iqoo"],
        &[
            "com.vivo.launcher",
            "com.vivo.weather",
            "com.vivo.notes",
            "com.vivo.gallery",
            "com.vivo.upnp",
            "com.bbk.appstore",
            "com.vivo.wallet",
        ],
    ),
    (
        &["google", "pixel"],
        &[
            "com.google.android.apps.wallpaper",
            "com.google.android.apps.wellbeing",
            "com.google.android.apps.bard",
            "com.google.android.apps.recorder",
            "com.google.android.apps.tips",
            "com.google.android.pixel.setupwizard",
        ],
    ),
];

/// Deterministic, brand-distributed package list (30–60 entries). Brand
/// packages are appended after the base list so the list stays stable when
/// only the brand changes the tail. Unknown brands get the base list only.
pub fn usage_package_list(brand: &str) -> Vec<String> {
    let mut out: Vec<String> = BASE_PACKAGES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let b = brand.to_ascii_lowercase();
    if let Some((_, pkgs)) = BRAND_PACKAGES
        .iter()
        .find(|(matchers, _)| matchers.iter().any(|m| b.contains(m)))
    {
        out.extend(pkgs.iter().map(|s| (*s).to_string()));
    }
    out
}

/// The `mkdir + cat` command the package list is streamed into (pure, tested).
pub fn pkg_list_write_command() -> String {
    format!(
        "mkdir -p {USAGE_DIR_REMOTE} && cat > {USAGE_PKG_LIST_REMOTE}"
    )
}

/// Permissions fixup so app processes (DeviceCloak's host process reads the
/// list) can traverse /data/local/tmp/rdc-cloak and read the files.
pub fn usage_chmod_command() -> String {
    format!(
        "chmod 777 {USAGE_DIR_REMOTE}; chmod 644 {USAGE_PKG_LIST_REMOTE} {USAGE_README_REMOTE}; echo chmod-ok"
    )
}

/// Operator-facing README bundled with the list. Honest about what this does
/// and does not cover.
pub fn usage_readme_text(profile: &SpoofProfile) -> String {
    format!(
        "RDC 使用基线播种（{profile_id} / {brand})\n\
         =============================================\n\
         \n\
         usage-pkg-list：常见 App 包名清单（每行一个，按档案品牌分布）。\n\
         DeviceCloak（LSPosed 模块）的 UsagestatsHooks 在目标 App 进程内 hook\n\
         UsageStatsManager#queryUsageStats / queryEvents，按本清单合成基线记录：\n\
         安装时间 / 最后使用时间落在 rdc-cloak.json 的 usage.seededDays（默认 {days} 天）内，\n\
         per-package 稳定（同一包名每次查询返回相同时间）。\n\
         \n\
         已知边界：\n\
         - 本目录不写 /data/system/usagestats —— 该目录由 system server 重建，直接写入无效；\n\
         - 只覆盖 Java 层 UsageStatsManager 读取；目标 App 若读自身 getPackageInfo\n\
           (firstInstallTime)，由 DeviceCloak 的 IdHooks 族按同一 seededDays 逻辑覆盖；\n\
         - dumpsys usagestats（shell 层）看不到合成记录，审计为 shell 层证据不受影响。\n",
        profile_id = profile.id,
        brand = profile.brand,
        days = DEFAULT_SEED_DAYS,
    )
}

/// Pure builder for the README `cat >` command (streamed via stdin, tested).
pub fn readme_write_command() -> String {
    format!(
        "mkdir -p {USAGE_DIR_REMOTE} && cat > {USAGE_README_REMOTE}"
    )
}

/// Seed the usage baseline for one container instance:
/// 1. write the brand-distributed package list,
/// 2. write the operator README,
/// 3. chmod the staging dir for app-process reads,
/// 4. back-date the standard /sdcard directories (file-timestamp baseline).
///
/// Steps 1 and 4 determine overall success; 2 and 3 are best-effort (their
/// failures are appended to stderr as warnings). Container instances only.
pub fn seed_usage_baseline(serial: &str, profile: &SpoofProfile) -> ShellResult {
    let Some(container) = root::container_id_for(serial) else {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "仅容器实例支持使用基线播种（物理设备请手动维护 /sdcard 与使用记录）".into(),
            exit_code: -1,
        };
    };

    let mut stdout_parts: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 1) package list (hard requirement)
    let mut list = usage_package_list(&profile.brand).join("\n");
    list.push('\n');
    let write_list = util::run_command_stdin(
        &docker::docker_bin(),
        &[
            "exec",
            "-i",
            &container,
            "sh",
            "-c",
            &pkg_list_write_command(),
        ],
        list.as_bytes(),
        Duration::from_secs(15),
    );
    if !write_list.success {
        return write_list;
    }
    stdout_parts.push(format!(
        "包名清单已写入 {USAGE_PKG_LIST_REMOTE}（{} 个包）",
        usage_package_list(&profile.brand).len()
    ));

    // 2) README (best effort)
    let readme = usage_readme_text(profile);
    let write_readme = util::run_command_stdin(
        &docker::docker_bin(),
        &[
            "exec",
            "-i",
            &container,
            "sh",
            "-c",
            &readme_write_command(),
        ],
        readme.as_bytes(),
        Duration::from_secs(15),
    );
    if write_readme.success {
        stdout_parts.push(format!("说明已写入 {USAGE_README_REMOTE}"));
    } else {
        warnings.push(format!("README 写入失败（不影响功能）: {}", write_readme.stderr.trim()));
    }

    // 3) permissions (best effort)
    let chmod = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &usage_chmod_command()],
        Duration::from_secs(10),
    );
    if !chmod.success {
        warnings.push(format!(
            "权限设置失败（App 进程可能读不到清单）: {}",
            chmod.stderr.trim()
        ));
    }

    // 4) /sdcard timestamp baseline (determines success together with step 1)
    let seed = format!("{}|{}", serial, profile.id);
    let touch_cmd = traces::touch_timestamp_commands(battery_now_secs(), &seed);
    let touch = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &touch_cmd],
        Duration::from_secs(20),
    );
    if touch.success {
        stdout_parts.push("/sdcard 标准目录时间戳已回拨（2–180 天内，per-dir 稳定）".into());
    } else {
        warnings.push(format!("时间戳播种失败: {}", touch.stderr.trim()));
    }

    log::info(
        "Usage",
        &format!(
            "[{serial}] usage baseline seeded (profile={}, pkgs={})",
            profile.id,
            usage_package_list(&profile.brand).len()
        ),
    );

    let mut stderr = String::new();
    if !warnings.is_empty() {
        stderr = format!("警告:\n- {}", warnings.join("\n- "));
    }
    ShellResult {
        success: write_list.success && touch.success,
        stdout: stdout_parts.join("\n"),
        stderr,
        exit_code: if write_list.success && touch.success { 0 } else { 1 },
    }
}

/// Seconds since the Unix epoch. Routed through a helper (instead of calling
/// `battery::now_secs` inline) so tests can stay pure — the runtime path is
/// the only caller.
fn battery_now_secs() -> u64 {
    crate::services::battery::now_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::spoof::profile_by_id;

    #[test]
    fn package_list_is_deterministic_and_in_band() {
        let alioth = profile_by_id("redmi-k40-alioth").unwrap();
        let a = usage_package_list(&alioth.brand);
        let b = usage_package_list(&alioth.brand);
        assert_eq!(a, b, "same brand must render the same list");
        assert!(
            (30..=60).contains(&a.len()),
            "list must hold 30-60 packages, got {}",
            a.len()
        );
        for pkg in &a {
            assert!(
                pkg.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'),
                "package names must be dot-notation ascii: {pkg}"
            );
            assert!(pkg.contains('.'), "package {pkg} should be dot-notation");
        }
    }

    #[test]
    fn package_list_is_brand_distributed_and_unique() {
        let xiaomi = usage_package_list("Xiaomi");
        assert!(xiaomi.iter().any(|p| p.starts_with("com.miui.")));
        assert!(xiaomi.iter().any(|p| p.starts_with("com.xiaomi.")));

        let samsung = usage_package_list("samsung");
        assert!(samsung.iter().any(|p| p.starts_with("com.samsung.")));
        assert!(!samsung.iter().any(|p| p.starts_with("com.miui.")));

        let pixel = usage_package_list("Google");
        assert!(pixel.iter().any(|p| p.contains("wallpaper")));

        let unknown = usage_package_list("Nothing");
        assert!(unknown.iter().all(|p| BASE_PACKAGES.contains(&p.as_str())));

        // No duplicates anywhere.
        for list in [&xiaomi, &samsung, &pixel, &unknown] {
            let mut sorted = list.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), list.len(), "duplicate package in list");
        }
    }

    #[test]
    fn readme_mentions_boundaries_and_profile() {
        let p = profile_by_id("redmi-k40-alioth").unwrap();
        let text = usage_readme_text(&p);
        assert!(text.contains("redmi-k40-alioth"));
        assert!(text.contains("90"));
        assert!(text.contains("/data/system/usagestats"));
        assert!(text.contains("UsagestatsHooks"));
    }

    #[test]
    fn command_builders_target_the_staging_dir() {
        assert!(pkg_list_write_command().contains("> /data/local/tmp/rdc-cloak/usage-pkg-list"));
        assert!(pkg_list_write_command().starts_with("mkdir -p /data/local/tmp/rdc-cloak"));
        assert!(readme_write_command().contains("usage-README.txt"));
        let chmod = usage_chmod_command();
        assert!(chmod.contains("chmod 777 /data/local/tmp/rdc-cloak"));
        assert!(chmod.contains("chmod 644"));
    }
}
