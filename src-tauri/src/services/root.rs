use std::time::Duration;

use crate::models::{
    LsposedScopeModule, LsposedScopeReport, RootModuleInfo, RootStatus, ShellResult, SuPolicyEntry,
};
use crate::services::{adb, device, docker, log, util};


/// adbd drops back to the shell user on every container restart; magisk
/// client commands (--sqlite/--denylist) need root, so re-root adb first.
fn ensure_adb_root(serial: &str) {
    let id = adb::shell(serial, "id -u");
    if id.stdout.trim() == "0" {
        return;
    }
    let r = util::run_command_timeout(&adb::adb_bin(), &["-s", serial, "root"], Duration::from_secs(8));
    if r.success {
        std::thread::sleep(Duration::from_millis(1500));
        let _ = adb::connect(serial);
    }
}

/// Privileged command channel. Container-backed instances run via
/// `docker exec` (guaranteed root — the spoofed user build makes `adb root`
/// impossible and magisk --sqlite rejects the shell user), while physical /
/// LAN devices fall back to adb with `adb root`.
enum RootExec {
    Container { id: String },
    Adb { serial: String },
}

fn root_exec(serial: &str) -> RootExec {
    let container = device::list_devices()
        .into_iter()
        .find(|d| d.serial == serial || d.id == serial || d.container_id == serial)
        .map(|d| d.container_id)
        .filter(|c| !c.is_empty());
    match container {
        Some(id) => RootExec::Container { id },
        None => RootExec::Adb {
            serial: serial.to_string(),
        },
    }
}

impl RootExec {
    fn run(&self, command: &str, timeout: Duration) -> ShellResult {
        match self {
            RootExec::Container { id } => util::run_command_timeout(
                &docker::docker_bin(),
                &["exec", id, "sh", "-c", command],
                timeout,
            ),
            RootExec::Adb { serial } => {
                ensure_adb_root(serial);
                adb::shell_timeout(serial, command, timeout)
            }
        }
    }
}

/// Detect Magisk / Zygisk / module / spoof state on a device.
pub fn root_status(serial: &str) -> RootStatus {
    let mut st = RootStatus::default();
    let exec = root_exec(serial);

    // magisk binary reachability + version
    let ver = exec.run(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M -v 2>/dev/null; echo ---; $M -V 2>/dev/null",
        Duration::from_secs(15),
    );
    if ver.success {
        let mut it = ver.stdout.split("---");
        st.version = it.next().unwrap_or("").trim().to_string();
        let code = it.next().unwrap_or("").trim().to_string();
        st.magisk = !st.version.is_empty() || !code.is_empty();
        if st.version.is_empty() && !code.is_empty() {
            st.version = code;
        }
    }
    if !st.magisk {
        st.message = "未检测到 Magisk（该实例可能未勾选预装，或首启配置未完成）".into();
        return st;
    }

    // zygisk + denylist flags via magisk db
    let zygisk = exec.run(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"SELECT value FROM settings WHERE key='zygisk'\" 2>/dev/null | tail -n 1",
        Duration::from_secs(15),
    );
    st.zygisk_enabled = zygisk.success && zygisk.stdout.trim().ends_with('1');
    let deny = exec.run(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"SELECT value FROM settings WHERE key='denylist'\" 2>/dev/null | tail -n 1",
        Duration::from_secs(15),
    );
    st.denylist_enforced = deny.success && deny.stdout.trim().ends_with('1');

    // Live activation state — the DB flags above only promise what the NEXT
    // boot will do; these daemons prove what the running system is doing.
    let live = exec.run(
        "zygiskd_pid=$(pidof zygiskd zygiskd64 2>/dev/null | head -n 1); \
         lspd_pid=$(pidof lspd 2>/dev/null | head -n 1); \
         magisk_app=$(pm path com.topjohnwu.magisk 2>/dev/null | head -n 1); \
         lsposed_mgr=$(pm path org.lsposed.manager 2>/dev/null | head -n 1); \
         shamiko_wl=$([ -f /data/adb/shamiko/whitelist ] && echo 1 || echo 0); \
         shamiko_dir=$([ -d /data/adb/modules/zygisk_shamiko ] || [ -d /data/adb/modules/shamiko ] && echo 1 || echo 0); \
         echo \"zygisk_active=${zygiskd_pid:+1}\"; echo \"lsposed_active=${lspd_pid:+1}\"; \
         echo \"magisk_app=${magisk_app:+1}\"; echo \"lsposed_manager=${lsposed_mgr:+1}\"; \
         echo \"shamiko_wl=$shamiko_wl\"; echo \"shamiko_dir=$shamiko_dir\"",
        Duration::from_secs(15),
    );
    for line in live.stdout.lines() {
        let (k, v) = match line.trim().split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        match k {
            "zygisk_active" => st.zygisk_active = v == "1",
            "lsposed_active" => st.lsposed_active = v == "1",
            "magisk_app" => st.magisk_app = v == "1",
            "lsposed_manager" => st.lsposed_manager = v == "1",
            "shamiko_wl" => {
                if live.stdout.contains("shamiko_dir=1") {
                    st.shamiko_whitelist = Some(v == "1");
                }
            }
            _ => {}
        }
    }

    // modules
    let mods = exec.run(
        "for d in /data/adb/modules/*/; do [ -d \"$d\" ] || continue; id=$(basename \"$d\"); name=$(sed -n 's/^name=//p' \"$d/module.prop\" 2>/dev/null | head -n 1); ver=$(sed -n 's/^version=//p' \"$d/module.prop\" 2>/dev/null | head -n 1); state=enabled; [ -f \"$d/disable\" ] && state=disabled; echo \"$id|$name|$ver|$state\"; done",
        Duration::from_secs(15),
    );
    if mods.success {
        for line in mods.stdout.lines() {
            let p: Vec<&str> = line.trim().split('|').collect();
            if p.len() >= 4 && !p[0].is_empty() {
                st.modules.push(RootModuleInfo {
                    id: p[0].to_string(),
                    name: p[1].to_string(),
                    version: p[2].to_string(),
                    state: p[3].to_string(),
                });
            }
        }
    }

    // denylist packages
    let dl = exec.run(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --denylist ls 2>/dev/null",
        Duration::from_secs(15),
    );
    if dl.success {
        st.denylist = dl
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
    }

    // sampled effective props (spoof verification) — plain getprop needs no root
    for key in [
        "ro.product.model",
        "ro.product.manufacturer",
        "ro.product.device",
        "ro.build.fingerprint",
        "ro.build.tags",
        "ro.product.cpu.abi",
        "ro.kernel.qemu",
        "ro.boot.qemu",
    ] {
        let v = adb::get_prop(serial, key);
        st.props.insert(key.to_string(), v.trim().to_string());
    }

    // preset log tail (first-boot configuration log)
    let tail = exec.run("tail -n 40 /data/adb/rdc_preset.log 2>/dev/null", Duration::from_secs(10));
    if tail.success {
        st.preset_log_tail = tail.stdout;
    }
    st
}

/// Add a package to the Magisk denylist.
pub fn denylist_add(serial: &str, package: &str) -> crate::models::ShellResult {
    magisk_denylist(serial, "add", package)
}

/// Remove a package from the Magisk denylist.
pub fn denylist_remove(serial: &str, package: &str) -> crate::models::ShellResult {
    // Magisk v30's CLI action for removal is "rm" (not "remove").
    magisk_denylist(serial, "rm", package)
}

/// Re-run the baked-in spoof profile now (no reboot needed).
pub fn apply_spoof(serial: &str) -> crate::models::ShellResult {
    let r = root_exec(serial).run("sh /data/adb/service.d/rdc_apply_spoof.sh 2>&1", Duration::from_secs(30));
    if r.success {
        log::info("Root", &format!("[{serial}] spoof props re-applied"));
    }
    r
}

/// Toggle Shamiko between whitelist mode (hide root from everything not
/// whitelisted) and blacklist mode, via the marker file it reads at boot.
pub fn set_shamiko_mode(serial: &str, whitelist: bool) -> crate::models::ShellResult {
    let cmd = if whitelist {
        "mkdir -p /data/adb/shamiko && touch /data/adb/shamiko/whitelist && echo whitelist"
    } else {
        "mkdir -p /data/adb/shamiko && rm -f /data/adb/shamiko/whitelist && echo blacklist"
    };
    let r = root_exec(serial).run(cmd, Duration::from_secs(15));
    if r.success {
        log::info(
            "Root",
            &format!(
                "[{serial}] shamiko mode -> {} (生效需重启容器)",
                if whitelist { "白名单" } else { "黑名单" }
            ),
        );
    }
    r
}

fn magisk_denylist(serial: &str, op: &str, package: &str) -> crate::models::ShellResult {
    let pkg = package.trim();
    if pkg.is_empty()
        || !pkg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return crate::models::ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "包名无效".into(),
            exit_code: -1,
        };
    }
    let exec = root_exec(serial);
    // magiskd rejects packages that are not installed ("Invalid package /
    // process name") — check first so the error is actionable.
    if op == "add" {
        let check = exec.run(
            &format!("pm path {pkg} 2>/dev/null | head -n 1"),
            Duration::from_secs(10),
        );
        if !check.success || check.stdout.trim().is_empty() {
            return crate::models::ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!(
                    "设备上未安装 {pkg}：Magisk denylist 只接受已安装的包。请先安装目标 App，或检查包名拼写。"
                ),
                exit_code: -1,
            };
        }
    }
    let cmd = format!(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"REPLACE INTO settings (key,value) VALUES('denylist',1)\" >/dev/null 2>&1; $M --denylist enable >/dev/null 2>&1; $M --denylist {op} {pkg} 2>&1"
    );
    let r = exec.run(&cmd, Duration::from_secs(20));
    if r.success {
        log::info("Root", &format!("[{serial}] denylist {op} {pkg}"));
    } else {
        log::warn(
            "Root",
            &format!("[{serial}] denylist {op} {pkg} 失败: {}", r.stderr.trim()),
        );
    }
    r
}

/// Magisk module ids are directory names under /data/adb/modules — keep the
/// same charset the preset replay uses so path traversal can't sneak in.
fn valid_module_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn module_dir_arg(id: &str) -> String {
    format!("/data/adb/modules/{id}")
}

/// Enable or disable a Magisk module by toggling its `disable` marker.
/// Takes effect on the next container restart.
pub fn module_set_enabled(serial: &str, id: &str, enabled: bool) -> ShellResult {
    if !valid_module_id(id) {
        return ShellResult { success: false, stdout: String::new(), stderr: "模块 ID 无效".into(), exit_code: -1 };
    }
    let dir = module_dir_arg(id);
    let op = if enabled { "rm -f" } else { "touch" };
    let cmd = format!(
        "if [ -d {dir} ]; then {op} {dir}/disable && echo ok; else echo 'module missing'; exit 1; fi"
    );
    let r = root_exec(serial).run(&cmd, Duration::from_secs(15));
    if r.success {
        log::info(
            "Root",
            &format!("[{serial}] module {id} -> {}（重启实例后生效）", if enabled { "enabled" } else { "disabled" }),
        );
    }
    r
}

/// Mark a Magisk module for removal (`remove` marker, applied by Magisk on
/// the next boot). Takes effect on the next container restart.
pub fn module_remove(serial: &str, id: &str) -> ShellResult {
    if !valid_module_id(id) {
        return ShellResult { success: false, stdout: String::new(), stderr: "模块 ID 无效".into(), exit_code: -1 };
    }
    let dir = module_dir_arg(id);
    let cmd = format!(
        "if [ -d {dir} ]; then touch {dir}/remove && rm -f {dir}/disable && echo ok; else echo 'module missing'; exit 1; fi"
    );
    let r = root_exec(serial).run(&cmd, Duration::from_secs(15));
    if r.success {
        log::info("Root", &format!("[{serial}] module {id} marked for removal（重启实例后生效）"));
    }
    r
}

/// Re-install the Magisk / LSPosed manager apps from the on-device copies if
/// their packages are missing (e.g. uninstalled by hand or by Play Protect).
pub fn repair_managers(serial: &str) -> ShellResult {
    let exec = root_exec(serial);
    let cmd = "\
        repaired=''; \
        pm path com.topjohnwu.magisk >/dev/null 2>&1 || { \
            [ -f /data/adb/magisk.apk ] && pm install -r /data/adb/magisk.apk >/dev/null 2>&1 \
                && pm path com.topjohnwu.magisk >/dev/null 2>&1 && repaired=\"$repaired magisk\"; \
        }; \
        pm path org.lsposed.manager >/dev/null 2>&1 || { \
            for ap in /data/adb/modules/zygisk_lsposed/manager.apk /data/adb/modules_update/zygisk_lsposed/manager.apk; do \
                if [ -f \"$ap\" ] && pm install -r \"$ap\" >/dev/null 2>&1 && pm path org.lsposed.manager >/dev/null 2>&1; then \
                    repaired=\"$repaired lsposed\"; break; \
                fi; \
            done; \
        }; \
        echo \"repaired:${repaired:- none}\"";
    let r = exec.run(cmd, Duration::from_secs(60));
    if r.success {
        log::info("Root", &format!("[{serial}] manager repair: {}", r.stdout.trim()));
    }
    r
}

/// Read LSPosed's module/scope config. The on-image sqlite3 binary core
/// dumps (broken build), so pull the db + WAL to a temp dir and replay it
/// with bundled SQLite instead. Container instances only — physical devices
/// would need `adb root` plus a binary-safe pull of protected files.
pub fn lsposed_scope(serial: &str) -> LsposedScopeReport {
    let exec = root_exec(serial);
    let container = match &exec {
        RootExec::Container { id } => id.clone(),
        RootExec::Adb { .. } => {
            return LsposedScopeReport {
                modules: Vec::new(),
                message: "仅容器实例支持读取 LSPosed 作用域".into(),
            };
        }
    };

    let dir = std::env::temp_dir().join(format!("rdc-lspd-{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return LsposedScopeReport { modules: Vec::new(), message: format!("创建临时目录失败: {e}") };
    }
    let mut have_db = false;
    for name in ["modules_config.db", "modules_config.db-wal", "modules_config.db-shm"] {
        let bytes = util::run_command_bytes(
            &docker::docker_bin(),
            &["exec", &container, "cat", &format!("/data/adb/lspd/config/{name}")],
            Duration::from_secs(20),
        );
        match bytes {
            Ok(b) if !b.is_empty() => {
                if name == "modules_config.db" {
                    have_db = true;
                }
                let _ = std::fs::write(dir.join(name), &b);
            }
            // -wal/-shm may legitimately not exist (clean checkpoint)
            Ok(_) if name != "modules_config.db" => {}
            Ok(_) => {}
            Err(e) if name == "modules_config.db" => {
                let _ = std::fs::remove_dir_all(&dir);
                return LsposedScopeReport {
                    modules: Vec::new(),
                    message: format!("拉取 modules_config.db 失败: {e}"),
                };
            }
            Err(_) => {}
        }
    }
    if !have_db {
        let _ = std::fs::remove_dir_all(&dir);
        return LsposedScopeReport {
            modules: Vec::new(),
            message: "实例上没有 LSPosed 配置库（lspd 未运行或未装 LSPosed 模块）".into(),
        };
    }

    match read_scope_db(&dir.join("modules_config.db")) {
        Ok(modules) => {
            let _ = std::fs::remove_dir_all(&dir);
            LsposedScopeReport { modules, message: String::new() }
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            LsposedScopeReport { modules: Vec::new(), message: format!("解析 LSPosed 配置库失败: {e}") }
        }
    }
}

fn read_scope_db(path: &std::path::Path) -> Result<Vec<LsposedScopeModule>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE, // allow WAL recovery
    )
    .map_err(|e| e.to_string())?;
    // (mid, module) pairs — mid is needed to attach scope rows below
    let mut entries: Vec<(i64, LsposedScopeModule)> = Vec::new();
    let mut stmt = conn
        .prepare("SELECT mid, module_pkg_name, enabled FROM modules WHERE module_pkg_name != 'lspd'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (mid, pkg, enabled) = row.map_err(|e| e.to_string())?;
        entries.push((
            mid,
            LsposedScopeModule {
                pkg,
                enabled: enabled != 0,
                scope: Vec::new(),
            },
        ));
    }

    let mut stmt = conn
        .prepare("SELECT mid, app_pkg_name FROM scope ORDER BY mid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut scopes: Vec<(i64, String)> = Vec::new();
    for row in rows {
        let kv = row.map_err(|e| e.to_string())?;
        scopes.push(kv);
    }
    drop(stmt);
    for (mid, app) in scopes {
        if let Some((_, m)) = entries.iter_mut().find(|(id, _)| *id == mid) {
            m.scope.push(app);
        }
    }
    Ok(entries.into_iter().map(|(_, m)| m).collect())
}

/// Parse one row of `magisk --sqlite "SELECT uid,policy,until FROM policies"`.
/// The daemon prints rows as `uid=2000|policy=1|until=0` (each cell prefixed
/// with the column name). Policy values in this fork: 0=QUERY, 1=DENY, 2=ALLOW.
fn parse_su_policy_row(line: &str) -> Option<(i64, i64)> {
    let p: Vec<&str> = line.trim().split('|').collect();
    if p.len() < 2 {
        return None;
    }
    let cell = |c: &str| -> Option<i64> {
        c.trim()
            .rsplit_once('=')
            .map(|(_, v)| v)
            .unwrap_or(c)
            .trim()
            .parse::<i64>()
            .ok()
    };
    let uid = cell(p[0])?;
    let policy = cell(p[1])?;
    Some((uid, policy))
}

/// Parse one line of `cmd package list packages -U`: `package:com.a uid:10123`.
/// App policies are keyed by app id (uid % 100000).
fn parse_pkg_uid_line(line: &str) -> Option<(String, i64)> {
    let line = line.trim().strip_prefix("package:")?;
    let mut pkg = None;
    let mut uid = None;
    for part in line.split_whitespace() {
        if let Some(u) = part.strip_prefix("uid:") {
            uid = u.parse::<i64>().ok();
        } else if pkg.is_none() {
            pkg = Some(part.to_string());
        }
    }
    Some((pkg?, uid?))
}

fn app_id(uid: i64) -> i64 {
    uid % 100_000
}

/// List the su policy table with resolved package names. The daemon caches
/// policies in memory, so changes take effect after an instance restart.
pub fn su_policies(serial: &str) -> Vec<SuPolicyEntry> {
    let exec = root_exec(serial);
    let rows = exec.run(
        "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"SELECT uid,policy,until FROM policies\" 2>/dev/null",
        Duration::from_secs(15),
    );
    if !rows.success {
        return Vec::new();
    }
    let entries: Vec<(i64, i64)> = rows
        .stdout
        .lines()
        .filter_map(parse_su_policy_row)
        .filter(|(_, policy)| *policy == 1 || *policy == 2)
        .collect();
    if entries.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<SuPolicyEntry> = entries
        .iter()
        .map(|(uid, policy)| SuPolicyEntry {
            uid: *uid,
            package: String::new(),
            policy: if *policy == 2 { "allow" } else { "deny" }.into(),
        })
        .collect();
    let pkgs = adb::shell(serial, "cmd package list packages -U");
    if pkgs.success {
        let map: std::collections::HashMap<i64, String> = pkgs
            .stdout
            .lines()
            .filter_map(parse_pkg_uid_line)
            .map(|(pkg, uid)| (app_id(uid), pkg))
            .collect();
        for e in out.iter_mut() {
            if let Some(pkg) = map.get(&app_id(e.uid)) {
                e.package = pkg.clone();
            }
        }
    }
    out.sort_by(|a, b| a.package.cmp(&b.package).then(a.uid.cmp(&b.uid)));
    out
}

/// Allow or deny su for a uid (writes the policies table; effective after
/// an instance restart because magiskd caches the evaluated policy).
pub fn set_su_policy(serial: &str, uid: i64, allow: bool) -> ShellResult {
    if uid <= 0 || uid >= 1_000_000 {
        return ShellResult { success: false, stdout: String::new(), stderr: "uid 无效".into(), exit_code: -1 };
    }
    let policy = if allow { 2 } else { 1 };
    let exec = root_exec(serial);
    let r = exec.run(
        &format!(
            "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"REPLACE INTO policies (uid,policy,until,logging,notification) VALUES ({uid},{policy},0,1,1)\" 2>&1"
        ),
        Duration::from_secs(15),
    );
    if r.success {
        log::info("Root", &format!("[{serial}] su policy uid={uid} -> {policy}（重启实例后生效）"));
    }
    r
}

/// Remove a su policy row — the next su request goes back to the manager
/// prompt (or preset default for shell).
pub fn remove_su_policy(serial: &str, uid: i64) -> ShellResult {
    if uid <= 0 || uid >= 1_000_000 {
        return ShellResult { success: false, stdout: String::new(), stderr: "uid 无效".into(), exit_code: -1 };
    }
    let exec = root_exec(serial);
    let r = exec.run(
        &format!(
            "M=/sbin/magisk; [ -x $M ] || M=/system/etc/init/magisk/magisk; $M --sqlite \"DELETE FROM policies WHERE uid={uid}\" 2>&1"
        ),
        Duration::from_secs(15),
    );
    if r.success {
        log::info("Root", &format!("[{serial}] su policy uid={uid} removed"));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_id_validation_rejects_traversal() {
        assert!(valid_module_id("zygisk_lsposed"));
        assert!(valid_module_id("zygisk_shamiko"));
        assert!(valid_module_id("Riru-Core.v25"));
        assert!(!valid_module_id(""));
        assert!(!valid_module_id("../etc"));
        assert!(!valid_module_id("a b"));
        assert!(!valid_module_id("a;b"));
    }

    #[test]
    fn su_policy_row_parsing() {
        assert_eq!(parse_su_policy_row("uid=2000|policy=2|until=0"), Some((2000, 2)));
        assert_eq!(parse_su_policy_row("uid=10123|policy=1|until=0"), Some((10123, 1)));
        assert_eq!(parse_su_policy_row("2000|2|0"), Some((2000, 2)));
        assert_eq!(parse_su_policy_row("garbage"), None);
        assert_eq!(parse_su_policy_row("a|b|c"), None);
    }

    #[test]
    fn pkg_uid_line_parsing() {
        assert_eq!(
            parse_pkg_uid_line("package:com.android.settings uid:1000"),
            Some(("com.android.settings".into(), 1000))
        );
        assert_eq!(
            parse_pkg_uid_line("package:com.test.app uid:10123"),
            Some(("com.test.app".into(), 10123))
        );
        assert_eq!(parse_pkg_uid_line("uid:10123"), None);
        assert_eq!(parse_pkg_uid_line("package:nouid"), None);
        assert_eq!(app_id(10123), 10123);
        assert_eq!(app_id(110123), 10123);
    }

    #[test]
    fn scope_db_read_groups_by_module() {
        let dir = std::env::temp_dir().join(format!("rdc-lspd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("modules_config.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE modules (mid integer PRIMARY KEY AUTOINCREMENT, module_pkg_name text NOT NULL UNIQUE, apk_path text NOT NULL, enabled BOOLEAN DEFAULT 0);
             CREATE TABLE scope (mid integer, app_pkg_name text NOT NULL, user_id integer NOT NULL);
             INSERT INTO modules (module_pkg_name, apk_path, enabled) VALUES ('lspd', '/data/adb/x', 0);
             INSERT INTO modules (module_pkg_name, apk_path, enabled) VALUES ('com.test.hook', '/data/adb/m1', 1);
             INSERT INTO scope VALUES (2, 'com.target.a', 0), (2, 'com.target.b', 0);",
        )
        .unwrap();
        drop(conn);
        let modules = read_scope_db(&db).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        // 'lspd' (parasitic manager entry) is filtered out
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].pkg, "com.test.hook");
        assert!(modules[0].enabled);
        assert_eq!(modules[0].scope, vec!["com.target.a", "com.target.b"]);
    }
}
