use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::AtomicBool;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use crate::models::{AdbDevice, AdbInfo, AdbMdnsService, LanDevice, LanScanResult, ShellResult};
use crate::services::{cache, log, settings, util};

pub fn adb_bin() -> String {
    settings::adb_path()
}

pub fn version() -> String {
    let r = util::run_command(&adb_bin(), &["version"]);
    if r.success {
        r.stdout.lines().next().unwrap_or("unknown").to_string()
    } else {
        "unavailable".into()
    }
}

pub fn version_cached() -> String {
    if let Some(v) = cache::adb_version(Duration::from_secs(30)) {
        return v;
    }
    let v = version();
    cache::set_adb_version(v.clone());
    v
}

pub fn server_status() -> bool {
    // Do NOT call start-server here — it blocks and freezes UI polls
    let r = util::run_command_timeout(&adb_bin(), &["devices"], Duration::from_secs(3));
    r.success || !r.stdout.is_empty()
}

pub fn start_server() -> ShellResult {
    log::info("ADB", "Starting ADB server");
    let r = util::run_command(&adb_bin(), &["start-server"]);
    cache::invalidate_adb();
    if r.success {
        log::info("ADB", "ADB server started");
    } else {
        log::error("ADB", &format!("Failed to start ADB server: {}", r.stderr));
    }
    r
}

pub fn kill_server() -> ShellResult {
    log::info("ADB", "Killing ADB server");
    let r = util::run_command(&adb_bin(), &["kill-server"]);
    cache::invalidate_adb();
    r
}

pub fn restart_server() -> ShellResult {
    let _ = kill_server();
    start_server()
}

pub fn devices() -> Vec<AdbDevice> {
    let r = util::run_command_timeout(&adb_bin(), &["devices", "-l"], Duration::from_secs(4));
    if !r.success && r.stdout.is_empty() {
        return vec![];
    }
    parse_devices(&r.stdout)
}

fn parse_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                return None;
            }
            let serial = parts[0].to_string();
            let state = parts[1].to_string();
            let mut product = String::new();
            let mut model = String::new();
            let mut device = String::new();
            let mut transport_id = String::new();
            for p in parts.iter().skip(2) {
                if let Some(v) = p.strip_prefix("product:") {
                    product = v.to_string();
                } else if let Some(v) = p.strip_prefix("model:") {
                    model = v.to_string();
                } else if let Some(v) = p.strip_prefix("device:") {
                    device = v.to_string();
                } else if let Some(v) = p.strip_prefix("transport_id:") {
                    transport_id = v.to_string();
                }
            }
            Some(AdbDevice {
                serial,
                state,
                product,
                model,
                device,
                transport_id,
            })
        })
        .collect()
}

fn connect_output_failed(stdout: &str, stderr: &str) -> bool {
    let text = format!("{stdout} {stderr}").to_lowercase();
    text.contains("failed")
        || text.contains("unable")
        || text.contains("offline")
        || text.contains("refused")
        || text.contains("cannot connect")
        || text.contains("no route")
        || text.contains("timed out")
        || text.contains("timeout")
}

fn invalid_adb_result(message: &str) -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: message.to_string(),
        exit_code: -1,
    }
}

fn pair_output_failed(stdout: &str, stderr: &str) -> bool {
    let text = format!("{stdout} {stderr}").to_lowercase();
    text.contains("failed")
        || text.contains("unable")
        || text.contains("refused")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("invalid")
}

pub fn connect(address: &str) -> ShellResult {
    log::info("ADB", &format!("Connecting to {}", address));
    let mut r = util::run_command_timeout(&adb_bin(), &["connect", address], Duration::from_secs(8));
    cache::invalidate_adb();
    if connect_output_failed(&r.stdout, &r.stderr) {
        r.success = false;
        log::error("ADB", &format!("Connect failed: {} {}", r.stdout, r.stderr));
    } else if r.success || r.stdout.to_lowercase().contains("connected") {
        log::info("ADB", &format!("Connected to {}", address));
    } else {
        log::error("ADB", &format!("Connect failed: {} {}", r.stdout, r.stderr));
    }
    r
}

/// Pair an Android 11+ wireless-debugging pairing server using a code or QR secret.
pub fn pair(address: &str, pairing_code: &str) -> ShellResult {
    let address = address.trim();
    let pairing_code = pairing_code.trim();
    if address.is_empty() || pairing_code.is_empty() {
        return invalid_adb_result("配对地址和配对码不能为空");
    }
    log::info("ADB", &format!("Pairing with {}", address));
    let mut r = util::run_command_timeout(
        &adb_bin(),
        &["pair", address, pairing_code],
        Duration::from_secs(20),
    );
    if pair_output_failed(&r.stdout, &r.stderr) {
        r.success = false;
    }
    cache::invalidate_adb();
    r
}

/// Switch a USB-connected device into legacy ADB-over-TCP mode.
pub fn tcpip(serial: &str, port: u16) -> ShellResult {
    let serial = serial.trim();
    if serial.is_empty() || port == 0 {
        return invalid_adb_result("设备和 TCP 端口不能为空");
    }
    let port_text = port.to_string();
    let mut r = util::run_command_timeout(
        &adb_bin(),
        &["-s", serial, "tcpip", &port_text],
        Duration::from_secs(15),
    );
    if connect_output_failed(&r.stdout, &r.stderr) {
        r.success = false;
    }
    cache::invalidate_adb();
    r
}

pub fn device_state(serial: &str) -> String {
    devices()
        .into_iter()
        .find(|d| d.serial == serial)
        .map(|d| d.state)
        .unwrap_or_else(|| "not found".into())
}

/// Wait until ADB state=device and sys.boot_completed=1.
pub fn wait_ready(serial: &str, timeout: Duration) -> ShellResult {
    wait_ready_with(serial, timeout, |_, _, _| {})
}

/// TCP probe for 127.0.0.1:{port} — distinguishes "adbd not listening (yet)"
/// from a working port so hopeless waits can fail fast.
fn tcp_port_open(serial: &str, timeout_ms: u64) -> bool {
    let Some((host, port)) = serial.rsplit_once(':') else {
        return true;
    };
    if host != "127.0.0.1" && host != "localhost" {
        return true;
    }
    let Ok(port) = port.parse::<u16>() else {
        return true;
    };
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).is_ok()
}

fn localhost_port_never_opens(serial: &str) -> bool {
    // adbd starts listening within a few seconds of container start; if the
    // port stays closed for ~8s the wait can never succeed (container without
    // a -p mapping, or not started) — retrying for the full timeout only
    // burns 90 failed connects and misleads the user.
    for _ in 0..6 {
        if tcp_port_open(serial, 400) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1200));
    }
    true
}

/// Serials with a wait_ready loop already running — duplicate clicks must
/// not stack a second 180s retry loop behind the first one.
static WAITING: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

struct WaitGuard(String);

impl Drop for WaitGuard {
    fn drop(&mut self) {
        WAITING.lock().remove(self.0.as_str());
    }
}

pub fn wait_ready_with(
    serial: &str,
    timeout: Duration,
    mut on_tick: impl FnMut(u64, &str, &str),
) -> ShellResult {
    if !WAITING.lock().insert(serial.to_string()) {
        let msg = format!("该设备已有 ADB 等待任务进行中，请勿重复点击: {serial}");
        log::warn("ADB", &msg);
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: msg,
            exit_code: -1,
        };
    }
    let _guard = WaitGuard(serial.to_string());
    log::info("ADB", &format!("Waiting for device ready: {serial}"));
    let started = std::time::Instant::now();
    let mut last_state = String::from("unknown");
    let mut last_boot = String::new();
    let mut attempt: u32 = 0;
    let mut last_connect = String::new();

    if serial.contains(':') && localhost_port_never_opens(serial) {
        let msg = format!(
            "无法连接 {serial}：端口没有程序监听。可能原因：容器未映射 ADB 端口（docker run 缺少 -p <端口>:5555），或容器未启动。"
        );
        log::error("ADB", &msg);
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: msg,
            exit_code: -1,
        };
    }

    while started.elapsed() < timeout {
        attempt += 1;
        if serial.contains(':') && (attempt == 1 || last_state != "device") {
            if last_state == "offline" || last_state == "unauthorized" {
                let _ = disconnect(serial);
                std::thread::sleep(Duration::from_millis(400));
            }
            let conn = connect(serial);
            last_connect = format!("{} {}", conn.stdout, conn.stderr);
        }

        last_state = device_state(serial);
        if last_state == "device" {
            last_boot = get_prop(serial, "sys.boot_completed");
        } else {
            last_boot.clear();
        }
        on_tick(started.elapsed().as_secs(), &last_state, last_boot.trim());
        if last_state == "device" {
            if last_boot.trim() == "1" {
                cache::invalidate_adb();
                let msg = format!(
                    "设备已就绪: {serial}（等待 {}s，尝试 {attempt} 次）",
                    started.elapsed().as_secs()
                );
                log::info("ADB", &msg);
                return ShellResult {
                    success: true,
                    stdout: msg,
                    stderr: String::new(),
                    exit_code: 0,
                };
            }
        }

        std::thread::sleep(Duration::from_secs(2));
    }

    cache::invalidate_adb();
    let hint = if last_state == "offline" || last_state == "not found" {
        " 容器 Up 不代表 adbd 可用。Windows 上请先在 Docker 页切换自定义 binder 内核并重启 Docker Desktop。"
    } else if last_state == "device" {
        " ADB 已连接但 Android 尚未 boot_completed，可稍后再点「ADB 连接」。"
    } else {
        ""
    };
    let err = format!(
        "等待设备就绪超时（{}s）: {serial}，state={last_state}，boot_completed={}。{hint}\n{}",
        timeout.as_secs(),
        last_boot.trim(),
        last_connect.trim()
    );
    log::error("ADB", &err);
    ShellResult {
        success: false,
        stdout: last_connect,
        stderr: err,
        exit_code: -1,
    }
}

pub fn disconnect(address: &str) -> ShellResult {
    log::info("ADB", &format!("Disconnecting {}", address));
    let r = if address.is_empty() {
        util::run_command(&adb_bin(), &["disconnect"])
    } else {
        util::run_command(&adb_bin(), &["disconnect", address])
    };
    cache::invalidate_adb();
    r
}

pub fn reconnect(serial: &str) -> ShellResult {
    log::info("ADB", &format!("Reconnecting {}", serial));
    let r = util::run_command(&adb_bin(), &["-s", serial, "reconnect"]);
    cache::invalidate_adb();
    r
}

pub fn shell(serial: &str, command: &str) -> ShellResult {
    log::debug("ADB", &format!("[{}] shell: {}", serial, command));
    util::run_command(&adb_bin(), &["-s", serial, "shell", command])
}

pub fn shell_timeout(serial: &str, command: &str, timeout: Duration) -> ShellResult {
    log::debug("ADB", &format!("[{}] shell: {}", serial, command));
    util::run_command_timeout(&adb_bin(), &["-s", serial, "shell", command], timeout)
}

pub fn shell_args(serial: &str, args: &[&str]) -> ShellResult {
    let mut full = vec!["-s", serial, "shell"];
    full.extend_from_slice(args);
    util::run_command(&adb_bin(), &full)
}

pub fn get_prop(serial: &str, prop: &str) -> String {
    let r = util::run_command_timeout(
        &adb_bin(),
        &["-s", serial, "shell", "getprop", prop],
        Duration::from_secs(4),
    );
    if r.success {
        r.stdout
    } else {
        String::new()
    }
}

pub fn install(serial: &str, apk_path: &str, replace: bool) -> ShellResult {
    log::info("ADB", &format!("Installing {} on {}", apk_path, serial));
    // Streamed `adb install` wedges indefinitely on redroid-over-TCP (the
    // session never completes), so TCP targets install via push + on-device
    // `pm install`; physical USB devices keep the streamed path.
    if serial.contains(':') {
        let remote = "/data/local/tmp/rdc_install.apk";
        let push = util::run_command_timeout(
            &adb_bin(),
            &["-s", serial, "push", apk_path, remote],
            Duration::from_secs(120),
        );
        if !push.success {
            log::error("ADB", &format!("Install push failed: {} {}", push.stdout, push.stderr));
            return push;
        }
        let flag = if replace { " -r" } else { "" };
        let r = util::run_command_timeout(
            &adb_bin(),
            &["-s", serial, "shell", &format!("pm install{flag} {remote}")],
            Duration::from_secs(180),
        );
        let _ = util::run_command_timeout(
            &adb_bin(),
            &["-s", serial, "shell", &format!("rm -f {remote}")],
            Duration::from_secs(15),
        );
        if r.success || r.stdout.contains("Success") {
            log::info("ADB", "APK installed successfully");
        } else {
            log::error("ADB", &format!("Install failed: {} {}", r.stdout, r.stderr));
        }
        return r;
    }
    let mut args = vec!["-s", serial, "install"];
    if replace {
        args.push("-r");
    }
    args.push(apk_path);
    let r = util::run_command_timeout(&adb_bin(), &args, Duration::from_secs(180));
    if r.success || r.stdout.contains("Success") {
        log::info("ADB", "APK installed successfully");
    } else {
        log::error("ADB", &format!("Install failed: {} {}", r.stdout, r.stderr));
    }
    r
}

pub fn uninstall(serial: &str, package: &str) -> ShellResult {
    log::info("ADB", &format!("Uninstalling {} from {}", package, serial));
    util::run_command(&adb_bin(), &["-s", serial, "uninstall", package])
}

pub fn push(serial: &str, local: &str, remote: &str) -> ShellResult {
    log::info("ADB", &format!("Push {} -> {}", local, remote));
    util::run_command_timeout(
        &adb_bin(),
        &["-s", serial, "push", local, remote],
        Duration::from_secs(120),
    )
}

pub fn pull(serial: &str, remote: &str, local: &str) -> ShellResult {
    log::info("ADB", &format!("Pull {} -> {}", remote, local));
    util::run_command_timeout(
        &adb_bin(),
        &["-s", serial, "pull", remote, local],
        Duration::from_secs(120),
    )
}

pub fn push_tracked(
    serial: &str,
    local: &str,
    remote: &str,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> util::CancellableCommandResult {
    log::info("ADB", &format!("Tracked push {} -> {}", local, remote));
    util::run_command_cancellable(
        &adb_bin(),
        &["-s", serial, "push", local, remote],
        Duration::from_secs(120),
        cancel,
        on_output,
    )
}

pub fn pull_tracked(
    serial: &str,
    remote: &str,
    local: &str,
    cancel: &AtomicBool,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> util::CancellableCommandResult {
    log::info("ADB", &format!("Tracked pull {} -> {}", remote, local));
    util::run_command_cancellable(
        &adb_bin(),
        &["-s", serial, "pull", remote, local],
        Duration::from_secs(120),
        cancel,
        on_output,
    )
}

pub fn screencap(serial: &str, remote_path: &str) -> ShellResult {
    shell(serial, &format!("screencap -p {}", remote_path))
}

pub fn input_tap(serial: &str, x: i32, y: i32) -> ShellResult {
    shell(serial, &format!("input tap {} {}", x, y))
}

pub fn input_swipe(serial: &str, x1: i32, y1: i32, x2: i32, y2: i32, duration: u32) -> ShellResult {
    shell(
        serial,
        &format!("input swipe {} {} {} {} {}", x1, y1, x2, y2, duration),
    )
}

pub fn input_text(serial: &str, text: &str) -> ShellResult {
    let escaped = text.replace(' ', "%s").replace('\'', "\\'");
    shell(serial, &format!("input text '{}'", escaped))
}

pub fn input_keyevent(serial: &str, keycode: i32) -> ShellResult {
    shell(serial, &format!("input keyevent {}", keycode))
}

pub fn logcat(serial: &str, clear: bool, lines: u32) -> ShellResult {
    if clear {
        let _ = util::run_command(&adb_bin(), &["-s", serial, "logcat", "-c"]);
    }
    util::run_command_timeout(
        &adb_bin(),
        &["-s", serial, "logcat", "-d", "-t", &lines.to_string()],
        Duration::from_secs(15),
    )
}

pub fn info() -> AdbInfo {
    if let Some(v) = cache::adb(Duration::from_secs(2)) {
        return v;
    }
    let devices = devices();
    let info = AdbInfo {
        version: version_cached(),
        server_running: !devices.is_empty() || server_status(),
        devices,
    };
    cache::set_adb(info.clone());
    info
}

pub fn auto_fix() -> ShellResult {
    log::info("ADB", "Auto-fixing ADB");
    let kill = kill_server();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let start = start_server();
    cache::invalidate_adb();
    ShellResult {
        success: start.success,
        stdout: format!("kill: {}\nstart: {}", kill.stdout, start.stdout),
        stderr: format!("{}\n{}", kill.stderr, start.stderr),
        exit_code: start.exit_code,
    }
}


// ---- LAN scan (ADB over TCP discovery) ----

fn parse_mdns_services(output: &str) -> Vec<AdbMdnsService> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 || parts[0].eq_ignore_ascii_case("list") {
                return None;
            }
            let address = parts.last()?.to_string();
            if !address.contains(':') {
                return None;
            }
            Some(AdbMdnsService {
                instance_name: parts[0].to_string(),
                service_type: parts[1].to_string(),
                address,
            })
        })
        .collect()
}

pub fn mdns_services() -> Vec<AdbMdnsService> {
    let result = util::run_command_timeout(&adb_bin(), &["mdns", "services"], Duration::from_secs(8));
    if !result.success && result.stdout.trim().is_empty() {
        return Vec::new();
    }
    parse_mdns_services(&result.stdout)
}

/// Best-effort detection of the host's primary LAN /24, via the default-route
/// interface (UDP connect trick — no packets are sent).
pub fn local_subnet() -> Result<String, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    match sock.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            Ok(format!("{}.{}.{}.0/24", o[0], o[1], o[2]))
        }
        _ => Err("本机没有 IPv4 局域网地址".into()),
    }
}

/// Expand "192.168.1.0/24" (or "192.168.1", or any ip in the /24) into the
/// 254 host addresses of the /24 with the given port. Only /24 is supported —
/// larger ranges would take minutes with a TCP-connect probe.
pub fn parse_lan_hosts(subnet: &str, port: u16) -> Result<Vec<String>, String> {
    let base = subnet.trim().trim_end_matches("/24").trim_end_matches('/');
    let octets: Vec<&str> = base.split('.').filter(|p| !p.is_empty()).collect();
    if !(3..=4).contains(&octets.len()) {
        return Err(format!("网段格式无效: {subnet}（示例 192.168.1.0/24）"));
    }
    let mut prefix = Vec::new();
    for o in &octets[..3] {
        let n: u8 = o
            .parse()
            .map_err(|_| format!("网段格式无效: {subnet}（示例 192.168.1.0/24）"))?;
        prefix.push(n);
    }
    Ok((1..255)
        .map(|i| format!("{}.{}.{}.{}:{}", prefix[0], prefix[1], prefix[2], i, port))
        .collect())
}

/// Probe a /24 for open TCP port 5555 (ADB over TCP), optionally auto-connect
/// the candidates and read their model. Threads are capped so a /24 with a
/// 300 ms connect timeout finishes in a couple of seconds.
pub fn lan_scan(subnet: &str, port: u16, auto_connect: bool) -> LanScanResult {
    let started = Instant::now();
    let mut result = LanScanResult {
        subnet: subnet.trim().to_string(),
        port,
        ..Default::default()
    };
    let addrs = match parse_lan_hosts(subnet, port) {
        Ok(a) => a,
        Err(e) => {
            result.message = e;
            return result;
        }
    };
    result.scanned = addrs.len() as u32;
    log::info(
        "ADB",
        &format!("LAN scan {} ({} hosts, port {})", result.subnet, addrs.len(), port),
    );

    let open: Vec<String> = std::thread::scope(|scope| {
        // Split hosts into per-worker chunks: each worker owns its slice, no
        // shared counter needed.
        let workers = 64.min(addrs.len().max(1));
        let chunk = addrs.len().div_ceil(workers);
        let handles: Vec<_> = addrs
            .chunks(chunk)
            .map(|chunk_addrs| {
                let owned: Vec<String> = chunk_addrs.to_vec();
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for addr in owned {
                        if let Ok(sa) = addr.parse::<SocketAddr>() {
                            if TcpStream::connect_timeout(&sa, Duration::from_millis(300)).is_ok() {
                                out.push(addr);
                            }
                        }
                    }
                    out
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    // numeric sort by ip octets
    let mut open: Vec<(u32, String)> = open
        .into_iter()
        .map(|a| {
            let ip = a.split(':').next().unwrap_or("");
            let key = ip
                .split('.')
                .filter_map(|p| p.parse::<u32>().ok())
                .fold(0u32, |acc, o| (acc << 8) | (o & 0xff));
            (key, a)
        })
        .collect();
    open.sort_by_key(|(k, _)| *k);

    for (_, addr) in open {
        let mut dev = LanDevice {
            address: addr.clone(),
            ..Default::default()
        };
        if auto_connect {
            let r = connect(&addr);
            let combined = format!("{} {}", r.stdout, r.stderr).to_lowercase();
            if r.success && combined.contains("connected to") {
                dev.connected = true;
                dev.message = r.stdout.trim().to_string();
                let model = get_prop(&addr, "ro.product.model");
                if !model.trim().is_empty() {
                    dev.model = model.trim().to_string();
                }
            } else {
                dev.message = if r.stdout.trim().is_empty() {
                    r.stderr.trim().to_string()
                } else {
                    r.stdout.trim().to_string()
                };
            }
        } else {
            dev.message = "5555 端口开放".into();
        }
        if dev.connected {
            result.connected_count += 1;
        }
        result.found.push(dev);
    }

    result.duration_ms = started.elapsed().as_millis() as u64;
    log::info(
        "ADB",
        &format!(
            "LAN scan done: {} open / {} connected in {} ms",
            result.found.len(),
            result.connected_count,
            result.duration_ms
        ),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lan_hosts_supports_prefixes() {
        let hosts = parse_lan_hosts("192.168.1.0/24", 5555).unwrap();
        assert_eq!(hosts.len(), 254);
        assert_eq!(hosts[0], "192.168.1.1:5555");
        assert_eq!(hosts[253], "192.168.1.254:5555");

        let short = parse_lan_hosts("10.0.0", 5555).unwrap();
        assert_eq!(short.len(), 254);
        assert_eq!(short[1], "10.0.0.2:5555");

        let any_ip = parse_lan_hosts("172.16.3.77/24", 5037).unwrap();
        assert_eq!(any_ip[0], "172.16.3.1:5037");
    }

    #[test]
    fn lan_scan_loopback_end_to_end() {
        // Side-effect-free full path: probe loopback /24 without auto-connect.
        let r = lan_scan("127.0.0.0/24", 5555, false);
        assert_eq!(r.scanned, 254);
        assert_eq!(r.subnet, "127.0.0.0/24");
        assert!(r.duration_ms < 60_000);
        // Whatever listens on loopback must not be marked connected in probe mode.
        assert!(r.found.iter().all(|d| !d.connected));
    }

    #[test]
    fn parse_lan_hosts_rejects_bad_input() {
        assert!(parse_lan_hosts("hello", 5555).is_err());
        assert!(parse_lan_hosts("1.2.3.4.5/24", 5555).is_err());
        assert!(parse_lan_hosts("999.1.1.0/24", 5555).is_err());
    }

    #[test]
    fn parses_adb_mdns_services_and_ignores_headers() {
        let output = "List of discovered mdns services
adb-serial         _adb._tcp                192.168.1.20:5555
studio-device      _adb-tls-pairing._tcp    192.168.1.20:37145
adb-serial-suffix  _adb-tls-connect._tcp    192.168.1.20:41123";
        let services = parse_mdns_services(output);
        assert_eq!(services.len(), 3);
        assert_eq!(services[1].instance_name, "studio-device");
        assert_eq!(services[1].service_type, "_adb-tls-pairing._tcp");
        assert_eq!(services[1].address, "192.168.1.20:37145");
    }

    #[test]
    fn rejects_empty_pair_and_tcpip_inputs_before_spawning_adb() {
        assert!(!pair("", "123456").success);
        assert!(!pair("192.168.1.20:37145", "").success);
        assert!(!tcpip("", 5555).success);
        assert!(!tcpip("serial", 0).success);
    }
}
