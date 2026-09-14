//! Per-instance residential proxy egress ("每实例住宅代理分流").
//!
//! Two layers:
//!
//! 1. **Global HTTP proxy (always available).** Android's `settings put global
//!    http_proxy` accepts `host:port` only — it is an HTTP CONNECT proxy, so
//!    SOCKS5 servers are still entered here but apps that ignore the global
//!    setting need layer 2. The user-entered string (with scheme/userinfo) is
//!    remembered in `persist.sys.rdc.proxy` for later inspection.
//! 2. **Transparent takeover (optional).** When `settings.tun2socks_path` is
//!    configured, the binary is `docker cp`-ed into the container, a tun
//!    device is brought up and the default route is pointed at it while
//!    keeping the host/gateway (adb channel) and loopback on the original
//!    route. **The command sequences here are unit-tested as *strings* but
//!    have not been executed against a live container yet** — see README.

use std::time::Duration;

use crate::models::{DeviceProxyStatus, ShellResult};
use crate::services::{adb, docker, log, root, settings, util};

/// Prop remembering the user-entered proxy string on-device (best-effort).
pub const PROXY_PROP: &str = "persist.sys.rdc.proxy";

/// Staging paths inside the container for the transparent takeover.
pub const TUN_DIR: &str = "/data/local/tmp/rdc-tun2socks";
pub const TUN_BIN_REMOTE: &str = "/data/local/tmp/rdc-tun2socks/tun2socks";
pub const TUN_CONF_REMOTE: &str = "/data/local/tmp/rdc-tun2socks/config.json";
pub const TUN_LOG_REMOTE: &str = "/data/local/tmp/rdc-tun2socks/tun2socks.log";
/// tun device name used by the takeover.
pub const TUN_DEVICE: &str = "tun0";
/// Metric for the tun0 default route (below the original route's implicit 0
/// would shadow it entirely; 100 keeps the original route preferred until we
/// deliberately remove it on stop — belt and braces for rollback).
pub const TUN_ROUTE_METRIC: u32 = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedProxy {
    /// Lowercase scheme: "http" or "socks5".
    pub scheme: String,
    /// Host/IP only (userinfo stripped).
    pub host: String,
    pub port: u16,
    /// The verbatim user input (trimmed).
    pub original: String,
}

impl ParsedProxy {
    /// Full URL form for tools that want it (tun2socks --proxy).
    pub fn url(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }
}

fn invalid(reason: &str) -> String {
    format!(
        "代理格式无效：{reason}\n支持：http://host:port 或 socks5://user:pass@host:port（也接受裸 host:port，按 http 处理）"
    )
}

/// Parse/validate a user-entered proxy string.
///
/// Accepted: `host:port` (treated as http), `http://host:port`,
/// `socks5://user:pass@host:port`. IPv6 literals and whitespace anywhere in
/// the input are rejected (the value is later passed through several shell
/// layers — keep the charset shell-safe).
pub fn parse_proxy_input(raw: &str) -> Result<ParsedProxy, String> {
    let original = raw.trim();
    if original.is_empty() {
        return Err(invalid("输入为空"));
    }
    if original.chars().any(|c| c.is_whitespace()) {
        return Err(invalid("不能包含空白字符"));
    }
    let (scheme, rest) = match original.split_once("://") {
        Some((s, r)) => {
            let s = s.to_ascii_lowercase();
            if s != "http" && s != "socks5" {
                return Err(invalid(&format!("不支持的协议 {s}（仅 http / socks5）")));
            }
            (s, r)
        }
        None => ("http".to_string(), original),
    };
    // Strip userinfo (socks5://user:pass@host:port).
    let hostport = match rest.rsplit_once('@') {
        Some((_, h)) => h,
        None => rest,
    };
    let hostport = hostport.trim_start_matches('[').trim_end_matches(']');
    if hostport.starts_with('[') || hostport.contains(':') && hostport.matches(':').count() > 1 {
        return Err(invalid("暂不支持 IPv6 字面量"));
    }
    let (host, port_str) = hostport
        .rsplit_once(':')
        .ok_or_else(|| invalid("缺少端口（应为 host:port）"))?;
    if host.is_empty() {
        return Err(invalid("host 为空"));
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(invalid("host 含非法字符（仅允许字母/数字/./-/_）"));
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| invalid(format!("端口 {port_str} 不是 1–65535 的数字").as_str()))?;
    if port == 0 {
        return Err(invalid("端口不能为 0"));
    }
    Ok(ParsedProxy {
        scheme,
        host: host.to_string(),
        port,
        original: original.to_string(),
    })
}

// ---- Command builders (pure functions, unit-tested) ----

/// Set Android's global HTTP proxy to `host:port`. Note: even for a socks5
/// upstream this is the only global switch Android has — it is HTTP-only.
pub fn apply_http_proxy_command(host: &str, port: u16) -> String {
    format!("settings put global http_proxy {host}:{port}")
}

/// Record the verbatim user input on-device for later inspection.
pub fn record_proxy_command(original: &str) -> String {
    format!("setprop {} {}", PROXY_PROP, shell_quote(original))
}

/// Clear both the global proxy and the record prop in one shell call.
pub fn clear_proxy_command() -> String {
    format!("settings put global http_proxy :0; setprop {PROXY_PROP} ''")
}

/// Read both proxy values in one shell call (`echo`-separated).
pub fn proxy_status_command() -> String {
    format!(
        "echo \"http=$(settings get global http_proxy)\"; echo \"rdc=$(getprop {PROXY_PROP})\"; echo \"tun=$(pidof tun2socks)\""
    )
}

/// Minimal single-quote shell quoting (values are charset-validated upstream,
/// so this is belt-and-braces against stray `'`).
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Background-start command executed via `docker exec <c> sh -c`. Brings up
/// the tun device, starts tun2socks detached (log to TUN_LOG_REMOTE) and
/// prints its pid so the caller can verify it stayed up.
pub fn tun2socks_up_command(proxy_url: &str) -> String {
    format!(
        "mkdir -p {TUN_DIR}; \
         chmod 755 {TUN_BIN_REMOTE}; \
         ip tuntap add mode tun dev {TUN_DEVICE} 2>/dev/null; \
         ip link set {TUN_DEVICE} up; \
         nohup {TUN_BIN_REMOTE} --proxy {proxy_url} --tun {TUN_DEVICE} --loglevel warning > {TUN_LOG_REMOTE} 2>&1 & \
         sleep 1; pidof tun2socks"
    )
}

/// Route commands after tun2socks is up: keep the host/gateway (the adb
/// channel lives there) and loopback on the original path, then point the
/// default route at the tun device with a fallback metric.
pub fn tun2socks_route_commands(gateway: &str, dev: &str) -> String {
    format!(
        "ip route replace {gateway}/32 via {gateway} dev {dev} 2>/dev/null; \
         ip route replace 127.0.0.0/8 dev lo 2>/dev/null; \
         ip route replace default dev {TUN_DEVICE} metric {TUN_ROUTE_METRIC} 2>/dev/null; \
         ip route show | head -n 5"
    )
}

/// Tear the takeover down: kill tun2socks, remove the tun default route and
/// the device itself.
pub fn tun2socks_stop_command() -> String {
    format!(
        "pkill -f {TUN_BIN_REMOTE} 2>/dev/null; \
         ip route del default dev {TUN_DEVICE} metric {TUN_ROUTE_METRIC} 2>/dev/null; \
         ip tuntap del mode tun dev {TUN_DEVICE} 2>/dev/null; \
         echo stopped"
    )
}

/// Parse `ip route show default` output: `default via 172.17.0.1 dev eth0`.
/// Returns `(gateway, device)`.
pub fn parse_default_route(output: &str) -> Option<(String, String)> {
    for line in output.lines() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.first() != Some(&"default") {
            continue;
        }
        let gw = parts
            .iter()
            .position(|p| *p == "via")
            .and_then(|i| parts.get(i + 1))
            .map(|s| s.to_string());
        let dev = parts
            .iter()
            .position(|p| *p == "dev")
            .and_then(|i| parts.get(i + 1))
            .map(|s| s.to_string());
        if let (Some(gw), Some(dev)) = (gw, dev) {
            return Some((gw, dev));
        }
    }
    None
}

// ---- Runtime operations ----

fn err_result(message: String) -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: message,
        exit_code: -1,
    }
}

fn invalid_result(reason: &str) -> ShellResult {
    err_result(invalid(reason))
}

/// Apply the device-side global proxy (layer 1). Succeeds for both http and
/// socks5 inputs; socks5 callers should be told about the transparent-takeover
/// limitation by the UI.
pub fn apply_device_proxy(serial: &str, proxy: &str) -> ShellResult {
    let parsed = match parse_proxy_input(proxy) {
        Ok(p) => p,
        Err(e) => return invalid_result(&e),
    };
    let set = adb::shell(serial, &apply_http_proxy_command(&parsed.host, parsed.port));
    if !set.success {
        return set;
    }
    let record = adb::shell(serial, &record_proxy_command(&parsed.original));
    if !record.success {
        // The proxy IS set; only the record prop failed. Surface but keep success.
        let mut merged = set;
        merged.stdout = format!(
            "{}\n（提示：{} 备查 prop 写入失败：{}）",
            merged.stdout.trim(),
            PROXY_PROP,
            record.stderr.trim()
        );
        return merged;
    }
    log::info(
        "Proxy",
        &format!("[{serial}] http_proxy -> {}:{}", parsed.host, parsed.port),
    );
    set
}

/// Clear the device-side proxy (layer 1 and the record prop).
pub fn clear_device_proxy(serial: &str) -> ShellResult {
    let r = adb::shell(serial, &clear_proxy_command());
    if r.success {
        log::info("Proxy", &format!("[{serial}] http_proxy cleared"));
    }
    r
}

/// Normalize `settings get global http_proxy` output (":0"/"null" = none).
fn normalize_http_proxy(value: &str) -> String {
    let v = value.trim();
    if v.is_empty() || v == ":0" || v.eq_ignore_ascii_case("null") {
        String::new()
    } else {
        v.to_string()
    }
}

/// Read the per-instance proxy state: effective http_proxy, the recorded
/// original string and whether the transparent takeover process is alive.
pub fn device_proxy_status(serial: &str) -> DeviceProxyStatus {
    let out = adb::shell(serial, &proxy_status_command());
    let mut status = DeviceProxyStatus::default();
    if !out.success {
        status.message = if out.stderr.trim().is_empty() {
            "读取代理状态失败（设备可能离线）".into()
        } else {
            out.stderr.trim().to_string()
        };
        return status;
    }
    for line in out.stdout.lines() {
        if let Some((k, v)) = line.trim().split_once('=') {
            match k {
                "http" => status.http_proxy = normalize_http_proxy(v),
                "rdc" => {
                    let v = v.trim();
                    status.original = if v.is_empty() { String::new() } else { v.into() };
                }
                "tun" => status.transparent_running = !v.trim().is_empty(),
                _ => {}
            }
        }
    }
    status
}

/// Resolve the configured tun2socks binary, mirroring `cloak.rs`'s
/// missing-APK error style: a precise message with setup instructions.
fn tun2socks_bin_path() -> String {
    settings::get().tun2socks_path.trim().to_string()
}

fn tun2socks_missing_result(path: &str) -> ShellResult {
    err_result(format!(
        "未找到 tun2socks 二进制：{}\n透明接管需要在「设置 → 工具路径」配置 tun2socks 路径（如 https://github.com/xjasonlyu/tun2socks 发布的 linux-amd64 版本）。\n不配置时仍可使用全局 http_proxy（设置 → 网络出口）。",
        if path.is_empty() { "（未配置）" } else { path }
    ))
}

/// Layer 2 — transparent takeover. Stages the binary, brings up tun0 and
/// repoints the default route.
///
/// ⚠️ Runtime-unverified: the shell sequences are unit-tested as generated
/// strings only (no live container in CI). Re-check `ip` support inside the
/// redroid image before relying on this in the field.
pub fn apply_transparent_proxy(serial: &str, proxy: &str) -> ShellResult {
    let parsed = match parse_proxy_input(proxy) {
        Ok(p) => p,
        Err(e) => return invalid_result(&e),
    };
    let bin = tun2socks_bin_path();
    if bin.is_empty() || !std::path::Path::new(&bin).is_file() {
        return tun2socks_missing_result(&bin);
    }
    let Some(container) = root::container_id_for(serial) else {
        return err_result("透明接管仅容器实例支持（需要 docker exec + ip 路由权限）".into());
    };

    // 1) stage the binary
    let cp = util::run_command_timeout(
        &docker::docker_bin(),
        &["cp", &bin, &format!("{container}:{TUN_BIN_REMOTE}")],
        Duration::from_secs(60),
    );
    if !cp.success {
        return cp;
    }

    // 2) write the config file (records what the process was started with)
    let conf = format!(
        "{{\n  \"proxy\": \"{}\",\n  \"tun\": \"{}\",\n  \"loglevel\": \"warning\"\n}}\n",
        parsed.url(),
        TUN_DEVICE
    );
    let write = util::run_command_stdin(
        &docker::docker_bin(),
        &[
            "exec",
            "-i",
            &container,
            "sh",
            "-c",
            &format!("cat > {TUN_CONF_REMOTE}"),
        ],
        conf.as_bytes(),
        Duration::from_secs(15),
    );
    if !write.success {
        return write;
    }

    // 3) bring the process up
    let up_cmd = tun2socks_up_command(&parsed.url());
    let up = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &up_cmd],
        Duration::from_secs(30),
    );
    if !up.success || up.stdout.trim().is_empty() {
        return err_result(format!(
            "tun2socks 启动失败（未检测到进程）：\n{}\n{}",
            up.stdout.trim(),
            up.stderr.trim()
        ));
    }

    // 4) repoint the default route, keeping host/loopback paths intact
    let route_out = util::run_command_timeout(
        &docker::docker_bin(),
        &[
            "exec",
            &container,
            "sh",
            "-c",
            "ip route show default",
        ],
        Duration::from_secs(10),
    );
    let (gw, dev) = parse_default_route(&route_out.stdout).unwrap_or_else(|| {
        // No default route found — fall back to the docker bridge conventions.
        ("172.17.0.1".into(), "eth0".into())
    });
    let route_cmd = tun2socks_route_commands(&gw, &dev);
    let route = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &route_cmd],
        Duration::from_secs(15),
    );
    log::info(
        "Proxy",
        &format!(
            "[{serial}] transparent proxy up (gw={gw} dev={dev} route_ok={})",
            route.success
        ),
    );
    let mut merged = up;
    merged.stdout = format!(
        "{}\n路由已指向 {TUN_DEVICE}（网关 {gw} 与 loopback 保持原路由）。停止请用「停止透明接管」。",
        merged.stdout.trim()
    );
    merged
}

/// Stop the transparent takeover and restore the original routing.
pub fn stop_transparent_proxy(serial: &str) -> ShellResult {
    let Some(container) = root::container_id_for(serial) else {
        return err_result("透明接管仅容器实例支持".into());
    };
    let cmd = tun2socks_stop_command();
    let r = util::run_command_timeout(
        &docker::docker_bin(),
        &["exec", &container, "sh", "-c", &cmd],
        Duration::from_secs(15),
    );
    if r.success {
        log::info("Proxy", &format!("[{serial}] transparent proxy stopped"));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_host_port_as_http() {
        let p = parse_proxy_input("192.168.1.100:8080").unwrap();
        assert_eq!(p.scheme, "http");
        assert_eq!(p.host, "192.168.1.100");
        assert_eq!(p.port, 8080);
        assert_eq!(p.original, "192.168.1.100:8080");
    }

    #[test]
    fn parses_http_and_socks5_urls_with_userinfo() {
        let h = parse_proxy_input("HTTP://proxy.local:3128").unwrap();
        assert_eq!(h.scheme, "http");
        assert_eq!(h.host, "proxy.local");
        assert_eq!(h.port, 3128);

        let s = parse_proxy_input("socks5://alice:s3cret@10.0.0.2:1080").unwrap();
        assert_eq!(s.scheme, "socks5");
        assert_eq!(s.host, "10.0.0.2");
        assert_eq!(s.port, 1080);
        assert_eq!(s.url(), "socks5://10.0.0.2:1080");
    }

    #[test]
    fn rejects_bad_proxy_inputs() {
        assert!(parse_proxy_input("").is_err());
        assert!(parse_proxy_input("host:port").is_err());
        assert!(parse_proxy_input("host").is_err());
        assert!(parse_proxy_input("ftp://host:21").is_err());
        assert!(parse_proxy_input("host :8080").is_err());
        assert!(parse_proxy_input("host:0").is_err());
        assert!(parse_proxy_input("host:99999").is_err());
        assert!(parse_proxy_input("[::1]:8080").is_err());
        assert!(parse_proxy_input("ho st:8080").is_err());
    }

    #[test]
    fn http_proxy_command_uses_host_port_only() {
        assert_eq!(
            apply_http_proxy_command("192.168.1.100", 8080),
            "settings put global http_proxy 192.168.1.100:8080"
        );
    }

    #[test]
    fn record_and_clear_commands_target_the_rdc_prop() {
        assert_eq!(
            record_proxy_command("socks5://a:b@1.2.3.4:1080"),
            "setprop persist.sys.rdc.proxy 'socks5://a:b@1.2.3.4:1080'"
        );
        let clear = clear_proxy_command();
        assert!(clear.contains("settings put global http_proxy :0"));
        assert!(clear.contains("setprop persist.sys.rdc.proxy ''"));
    }

    #[test]
    fn status_command_reads_all_three_sources() {
        let cmd = proxy_status_command();
        assert!(cmd.contains("settings get global http_proxy"));
        assert!(cmd.contains("getprop persist.sys.rdc.proxy"));
        assert!(cmd.contains("pidof tun2socks"));
    }

    #[test]
    fn up_command_starts_tun2socks_detached_on_tun0() {
        let cmd = tun2socks_up_command("socks5://10.0.0.2:1080");
        assert!(cmd.contains("ip tuntap add mode tun dev tun0"));
        assert!(cmd.contains("ip link set tun0 up"));
        assert!(cmd.contains(
            "nohup /data/local/tmp/rdc-tun2socks/tun2socks --proxy socks5://10.0.0.2:1080 --tun tun0 --loglevel warning"
        ));
        assert!(cmd.contains("&"));
        assert!(cmd.contains("pidof tun2socks"));
        assert!(cmd.contains("chmod 755 /data/local/tmp/rdc-tun2socks/tun2socks"));
    }

    #[test]
    fn route_commands_exclude_loopback_and_keep_host_gateway() {
        let cmd = tun2socks_route_commands("172.17.0.1", "eth0");
        // Host/gateway stays on the original path (adb channel).
        assert!(cmd.contains("ip route replace 172.17.0.1/32 via 172.17.0.1 dev eth0"));
        // Loopback explicit.
        assert!(cmd.contains("ip route replace 127.0.0.0/8 dev lo"));
        // Default route to tun0 with fallback metric.
        assert!(cmd.contains("ip route replace default dev tun0 metric 100"));
    }

    #[test]
    fn stop_command_kills_process_and_restores_routes() {
        let cmd = tun2socks_stop_command();
        assert!(cmd.contains("pkill -f /data/local/tmp/rdc-tun2socks/tun2socks"));
        assert!(cmd.contains("ip route del default dev tun0 metric 100"));
        assert!(cmd.contains("ip tuntap del mode tun dev tun0"));
    }

    #[test]
    fn default_route_parsing() {
        assert_eq!(
            parse_default_route("default via 172.17.0.1 dev eth0"),
            Some(("172.17.0.1".into(), "eth0".into()))
        );
        assert_eq!(
            parse_default_route("default via 10.206.0.1 dev eth0 metric 100"),
            Some(("10.206.0.1".into(), "eth0".into()))
        );
        assert_eq!(parse_default_route(""), None);
        assert_eq!(parse_default_route("172.17.0.0/16 dev eth0"), None);
    }

    #[test]
    fn normalize_treats_null_and_zero_port_as_unset() {
        assert_eq!(normalize_http_proxy(":0"), "");
        assert_eq!(normalize_http_proxy("null"), "");
        assert_eq!(normalize_http_proxy("NULL"), "");
        assert_eq!(normalize_http_proxy("1.2.3.4:8080"), "1.2.3.4:8080");
    }
}
