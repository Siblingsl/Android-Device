use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::PathBuf;
use std::time::Duration;

use crate::models::{
    AppInfo, DashboardData, DeviceInfo, FileEntry, ScreenshotResult, ShellResult, SystemStatus,
};
use crate::services::{adb, cache, docker, log, scrcpy, settings, util};

/// Fast device list — only adb devices -l + docker ps. No per-device shell probes.
pub fn list_devices() -> Vec<DeviceInfo> {
    list_devices_cached(false)
}

pub fn list_devices_cached(force: bool) -> Vec<DeviceInfo> {
    if !force {
        if let Some(v) = cache::devices(Duration::from_secs(2)) {
            return v;
        }
    }

    let adb_devices = adb::devices();
    let containers = if docker::is_running_fast() {
        docker::list_containers(true)
    } else {
        vec![]
    };

    let mut devices = Vec::new();

    for d in &adb_devices {
        if d.state != "device" && d.state != "offline" && d.state != "unauthorized" {
            continue;
        }
        let serial = d.serial.clone();
        let online = d.state == "device";
        let ip = extract_host_from_serial(&serial);
        let matched = containers.iter().find(|c| {
            c.ports.contains(&serial)
                || serial.contains(&c.name)
                || port_match(&serial, &c.ports)
        });

        let (docker_status, container_id, image, started_at) = if let Some(c) = matched {
            (
                c.status.clone(),
                c.id.clone(),
                c.image.clone(),
                c.created.clone(),
            )
        } else {
            ("n/a".into(), String::new(), String::new(), String::new())
        };

        // Prefer unique container name over identical redroid model strings
        let adb_port = if let Some(c) = matched {
            extract_host_port(&c.ports)
                .or_else(|| parse_port_from_serial(&serial))
                .unwrap_or(5555)
        } else {
            parse_port_from_serial(&serial).unwrap_or(5555)
        };

        let name = if let Some(c) = matched {
            display_instance_name(&c.name)
        } else if !d.model.is_empty() {
            d.model.clone()
        } else if !d.product.is_empty() {
            d.product.clone()
        } else {
            serial.clone()
        };

        devices.push(DeviceInfo {
            id: serial.clone(),
            name,
            serial: serial.clone(),
            android_version: String::new(),
            online,
            cpu: String::new(),
            ram: String::new(),
            fps: 0.0,
            adb_status: d.state.clone(),
            scrcpy_status: scrcpy::status(&serial),
            docker_status,
            ip,
            mac: String::new(),
            resolution: String::new(),
            dpi: String::new(),
            container_id,
            image,
            started_at,
            uptime: String::new(),
            adb_port,
            scrcpy_port: 0,
            data_volume: matched
                .map(|c| data_volume_of(&c.name))
                .unwrap_or_default(),
        });
    }

    for c in containers.iter().filter(|c| c.is_redroid) {
        let already = devices
            .iter()
            .any(|d| d.container_id == c.id || port_match(&d.serial, &c.ports));
        if already {
            continue;
        }
        // Docker Up ≠ ADB ready. Only mark online when adb state is device.
        // A container without an ADB host mapping (e.g. started manually
        // without -p) gets port 0 / empty serial — do not invent 5555.
        let mapped_port = extract_host_port(&c.ports);
        let port = mapped_port.unwrap_or(0);
        let serial = mapped_port.map(|p| format!("127.0.0.1:{p}")).unwrap_or_default();
        devices.push(DeviceInfo {
            id: c.id.clone(),
            name: display_instance_name(&c.name),
            serial: serial.clone(),
            android_version: String::new(),
            online: false,
            cpu: String::new(),
            ram: String::new(),
            fps: 0.0,
            adb_status: "disconnected".into(),
            scrcpy_status: "stopped".into(),
            docker_status: c.status.clone(),
            ip: "127.0.0.1".into(),
            mac: String::new(),
            resolution: String::new(),
            dpi: String::new(),
            container_id: c.id.clone(),
            image: c.image.clone(),
            started_at: c.created.clone(),
            uptime: String::new(),
            adb_port: port,
            scrcpy_port: 0,
            data_volume: data_volume_of(&c.name),
        });
    }

    cache::set_devices(devices.clone());
    devices
}

/// Enrich one device with shell props (only for detail page).
pub fn enrich_device(mut d: DeviceInfo) -> DeviceInfo {
    if !d.online || d.adb_status != "device" {
        return d;
    }
    let serial = d.serial.clone();
    // Single shell batch to cut process spawn cost
    let batch = adb::shell(
        &serial,
        "echo VER=$(getprop ro.build.version.release); echo MODEL=$(getprop ro.product.model); echo ABI=$(getprop ro.product.cpu.abi); echo SIZE=$(wm size 2>/dev/null | tail -1); echo DPI=$(wm density 2>/dev/null | tail -1); echo MEM=$(grep MemTotal /proc/meminfo 2>/dev/null); echo MAC=$(cat /sys/class/net/wlan0/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null); echo UP=$(cat /proc/uptime 2>/dev/null | awk '{print $1}')",
    );
    for line in batch.stdout.lines() {
        if let Some(v) = line.strip_prefix("VER=") {
            d.android_version = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("MODEL=") {
            // Keep container instance name as primary title; model goes to cpu if empty later
            let _model = v.trim();
            let _ = _model;
        } else if let Some(v) = line.strip_prefix("ABI=") {
            d.cpu = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("SIZE=") {
            d.resolution = v
                .split(':')
                .last()
                .unwrap_or(v)
                .trim()
                .to_string();
        } else if let Some(v) = line.strip_prefix("DPI=") {
            d.dpi = v
                .split(':')
                .last()
                .unwrap_or(v)
                .trim()
                .to_string();
        } else if let Some(v) = line.strip_prefix("MEM=") {
            d.ram = format_mem(v);
        } else if let Some(v) = line.strip_prefix("MAC=") {
            d.mac = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("UP=") {
            if let Ok(secs) = v.trim().parse::<f64>() {
                let m = (secs / 60.0) as u64;
                d.uptime = format!("{}m", m);
            } else {
                d.uptime = v.trim().to_string();
            }
        }
    }
    if d.ip.is_empty() {
        d.ip = extract_host_from_serial(&serial);
    }
    // MemTotal inside the container reflects the Docker VM, not the instance's
    // own cap — prefer the limit set on the container when there is one.
    let (mem_bytes, _) = docker::container_resource_limits(&d.container_id);
    if mem_bytes > 0 {
        d.ram = format!("{:.1} GB（实例限额）", mem_bytes as f64 / 1024.0 / 1024.0 / 1024.0);
    }
    d.scrcpy_status = scrcpy::status(&serial);
    d
}

fn display_instance_name(container_name: &str) -> String {
    let n = container_name.trim_start_matches('/');
    n.strip_prefix("rdc-").unwrap_or(n).to_string()
}

fn data_volume_of(container_name: &str) -> String {
    let n = container_name.trim_start_matches('/');
    if n.is_empty() {
        String::new()
    } else if n.ends_with("-data") {
        n.to_string()
    } else {
        format!("{n}-data")
    }
}

fn extract_host_from_serial(serial: &str) -> String {
    serial.split(':').next().unwrap_or("").to_string()
}

fn parse_port_from_serial(serial: &str) -> Option<u16> {
    serial.split(':').nth(1)?.parse().ok()
}

fn port_match(serial: &str, ports: &str) -> bool {
    if let Some(port) = parse_port_from_serial(serial) {
        // Match host port exactly (avoid :5555 matching :55550)
        ports.split(',').any(|part| {
            part.split("->")
                .next()
                .and_then(|left| left.split(':').last())
                .and_then(|s| s.trim().parse::<u16>().ok())
                == Some(port)
        })
    } else {
        false
    }
}

fn extract_host_port(ports: &str) -> Option<u16> {
    // e.g. 0.0.0.0:5555->5555/tcp
    for part in ports.split(',') {
        if let Some(left) = part.split("->").next() {
            if let Some(p) = left.split(':').last() {
                if let Ok(port) = p.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    None
}

fn format_mem(s: &str) -> String {
    // MemTotal:       2048000 kB
    for part in s.split_whitespace() {
        if let Ok(kb) = part.parse::<u64>() {
            return format!("{:.1} GB", kb as f64 / 1024.0 / 1024.0);
        }
    }
    s.lines().next().unwrap_or("").to_string()
}

pub fn get_device(id: &str) -> Option<DeviceInfo> {
    let base = list_devices()
        .into_iter()
        .find(|d| d.id == id || d.serial == id || d.container_id == id)?;
    Some(enrich_device(base))
}

pub fn connect_device(serial: &str) -> ShellResult {
    let r = if serial.contains(':') {
        adb::wait_ready(serial, Duration::from_secs(180))
    } else {
        let state = adb::device_state(serial);
        if state == "device" {
            ShellResult {
                success: true,
                stdout: "USB device already listed".into(),
                stderr: String::new(),
                exit_code: 0,
            }
        } else {
            ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("USB 设备状态为 {state}，需要 state=device"),
                exit_code: -1,
            }
        }
    };
    cache::invalidate_adb();
    r
}

pub fn disconnect_device(serial: &str) -> ShellResult {
    let _ = scrcpy::stop(serial);
    let r = adb::disconnect(serial);
    cache::invalidate_adb();
    r
}

fn find_device_light(id: &str) -> Option<DeviceInfo> {
    list_devices()
        .into_iter()
        .find(|d| d.id == id || d.serial == id || d.container_id == id)
}

pub fn restart_device(id: &str) -> ShellResult {
    if let Some(d) = find_device_light(id) {
        let r = if !d.container_id.is_empty() {
            docker::restart_container(&d.container_id)
        } else {
            adb::shell(&d.serial, "reboot")
        };
        cache::invalidate_devices();
        cache::invalidate_docker();
        return r;
    }
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: "Device not found".into(),
        exit_code: -1,
    }
}

pub fn stop_device(id: &str) -> ShellResult {
    if let Some(d) = find_device_light(id) {
        let _ = scrcpy::stop(&d.serial);
        let r = if !d.container_id.is_empty() {
            docker::stop_container(&d.container_id)
        } else {
            adb::shell(&d.serial, "reboot -p")
        };
        cache::invalidate_devices();
        cache::invalidate_docker();
        return r;
    }
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: "Device not found".into(),
        exit_code: -1,
    }
}

// ---- Control APIs (Device Service) ----

pub fn tap(serial: &str, x: i32, y: i32) -> ShellResult {
    adb::input_tap(serial, x, y)
}

pub fn swipe(serial: &str, x1: i32, y1: i32, x2: i32, y2: i32, duration: u32) -> ShellResult {
    adb::input_swipe(serial, x1, y1, x2, y2, duration)
}

pub fn long_press(serial: &str, x: i32, y: i32, duration: u32) -> ShellResult {
    adb::input_swipe(serial, x, y, x, y, duration)
}

pub fn text(serial: &str, content: &str) -> ShellResult {
    adb::input_text(serial, content)
}

pub fn keyevent(serial: &str, code: i32) -> ShellResult {
    adb::input_keyevent(serial, code)
}

pub fn home(serial: &str) -> ShellResult {
    keyevent(serial, 3)
}

pub fn back(serial: &str) -> ShellResult {
    keyevent(serial, 4)
}

pub fn recent(serial: &str) -> ShellResult {
    keyevent(serial, 187)
}

pub fn power(serial: &str) -> ShellResult {
    keyevent(serial, 26)
}

pub fn volume_up(serial: &str) -> ShellResult {
    keyevent(serial, 24)
}

pub fn volume_down(serial: &str) -> ShellResult {
    keyevent(serial, 25)
}

pub fn lock(serial: &str) -> ShellResult {
    adb::shell(serial, "input keyevent 26")
}

pub fn wake(serial: &str) -> ShellResult {
    adb::shell(serial, "input keyevent 224")
}

pub fn rotate(serial: &str, landscape: bool) -> ShellResult {
    let val = if landscape { "1" } else { "0" };
    adb::shell(
        serial,
        &format!(
            "settings put system accelerometer_rotation 0; settings put system user_rotation {}",
            val
        ),
    )
}

pub fn open_notifications(serial: &str) -> ShellResult {
    adb::shell(serial, "cmd statusbar expand-notifications")
}

pub fn open_settings(serial: &str) -> ShellResult {
    adb::shell(serial, "am start -a android.settings.SETTINGS")
}

pub fn send_clipboard(serial: &str, content: &str) -> ShellResult {
    let escaped = content.replace('\\', "\\\\").replace('"', "\\\"");
    let r = adb::shell(serial, &format!("cmd clipboard set --uri \"{escaped}\""));
    if r.success {
        return r;
    }
    let r2 = adb::shell(serial, &format!("cmd clipboard set \"{escaped}\""));
    if r2.success {
        return r2;
    }
    adb::input_text(serial, content)
}

// ---- APK / Apps ----

pub fn install_apk(serial: &str, path: &str, replace: bool) -> ShellResult {
    adb::install(serial, path, replace)
}

pub fn uninstall_app(serial: &str, package: &str) -> ShellResult {
    adb::uninstall(serial, package)
}

pub fn start_app(serial: &str, package: &str) -> ShellResult {
    let r = adb::shell(
        serial,
        &format!("monkey -p {} -c android.intent.category.LAUNCHER 1", package),
    );
    if !r.success && (r.stderr.contains("monkey") || r.stdout.contains("monkey")) {
        return ShellResult {
            stderr: format!(
                "{pkg} 没有可启动的界面（无 LAUNCHER activity），后台服务类应用无法从这里启动。",
                pkg = package
            ),
            ..r
        };
    }
    r
}

pub fn stop_app(serial: &str, package: &str) -> ShellResult {
    adb::shell(serial, &format!("am force-stop {}", package))
}

pub fn clear_cache(serial: &str, package: &str) -> ShellResult {
    adb::shell(serial, &format!("pm clear {}", package))
}

pub fn list_apps(serial: &str, include_system: bool) -> Vec<AppInfo> {
    let flag = if include_system { "" } else { "-3" };
    let r = adb::shell(serial, &format!("pm list packages -f {}", flag));
    if !r.success {
        return vec![];
    }
    r.stdout
        .lines()
        .filter_map(|line| {
            // package:/data/app/xxx/base.apk=com.example
            let line = line.strip_prefix("package:")?;
            let (apk_path, package) = line.rsplit_once('=')?;
            Some(AppInfo {
                package_name: package.to_string(),
                label: package.to_string(),
                version_name: String::new(),
                version_code: String::new(),
                system_app: !apk_path.contains("/data/app"),
                enabled: true,
                apk_path: apk_path.to_string(),
                first_install_time: String::new(),
                last_update_time: String::new(),
                size: String::new(),
            })
        })
        .collect()
}

pub fn app_detail(serial: &str, package: &str) -> AppInfo {
    let path = adb::shell(serial, &format!("pm path {}", package)).stdout;
    let version = adb::shell(
        serial,
        &format!("dumpsys package {} | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime' | head -10", package),
    )
    .stdout;
    let mut version_name = String::new();
    let mut version_code = String::new();
    let mut first = String::new();
    let mut last = String::new();
    for line in version.lines() {
        if let Some(v) = line.split("versionName=").nth(1) {
            version_name = v.trim().to_string();
        }
        if let Some(v) = line.split("versionCode=").nth(1) {
            version_code = v.split_whitespace().next().unwrap_or("").to_string();
        }
        if let Some(v) = line.split("firstInstallTime=").nth(1) {
            first = v.trim().to_string();
        }
        if let Some(v) = line.split("lastUpdateTime=").nth(1) {
            last = v.trim().to_string();
        }
    }
    AppInfo {
        package_name: package.to_string(),
        label: package.to_string(),
        version_name,
        version_code,
        system_app: !path.contains("/data/app"),
        enabled: true,
        apk_path: path
            .replace("package:", "")
            .lines()
            .next()
            .unwrap_or("")
            .to_string(),
        first_install_time: first,
        last_update_time: last,
        size: String::new(),
    }
}

pub fn app_permissions(serial: &str, package: &str) -> String {
    adb::shell(
        serial,
        &format!("dumpsys package {} | grep permission", package),
    )
    .stdout
}

pub fn app_activities(serial: &str, package: &str) -> String {
    adb::shell(
        serial,
        &format!(
            "dumpsys package {} | grep -A 2 'Activity' | head -50",
            package
        ),
    )
    .stdout
}

// ---- Files ----

pub fn list_files(serial: &str, path: &str) -> Vec<FileEntry> {
    let r = adb::shell(serial, &format!("ls -la {}", path));
    if !r.success && r.stdout.is_empty() {
        return vec![];
    }
    r.stdout
        .lines()
        .filter(|l| !l.starts_with("total") && !l.trim().is_empty())
        .filter_map(|line| parse_ls_line(path, line))
        .collect()
}

fn parse_ls_line(base: &str, line: &str) -> Option<FileEntry> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 8 {
        return None;
    }
    let perms = parts[0];
    let is_dir = perms.starts_with('d');
    let size = parts.get(4).unwrap_or(&"0").to_string();
    let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
    let name = parts[8..].join(" ");
    if name == "." || name == ".." {
        return None;
    }
    let full = if base.ends_with('/') {
        format!("{}{}", base, name)
    } else {
        format!("{}/{}", base, name)
    };
    Some(FileEntry {
        name,
        path: full,
        is_dir,
        size,
        permissions: perms.to_string(),
        modified,
    })
}

pub fn upload_file(serial: &str, local: &str, remote: &str) -> ShellResult {
    adb::push(serial, local, remote)
}

pub fn download_file(serial: &str, remote: &str, local: &str) -> ShellResult {
    // Plain `adb pull` into a non-existent path creates a directory of that
    // name and puts the entry inside it, but the Files page save dialog hands
    // us a file path. Pull into a temp dir beside it, then move the single
    // pulled entry to the exact chosen path.
    let p = PathBuf::from(local);
    if p.is_dir() {
        return adb::pull(serial, remote, local);
    }
    let parent = match p.parent() {
        Some(x) if !x.as_os_str().is_empty() => x.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if let Err(e) = std::fs::create_dir_all(&parent) {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("创建目标目录失败: {e}"),
            exit_code: -1,
        };
    }
    let tmp = parent.join(format!(".rdc_pull_{}", util::now_millis()));
    let r = adb::pull(serial, remote, &tmp.to_string_lossy());
    if r.success {
        let mut moved = false;
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            if let Some(Ok(e)) = entries.into_iter().next() {
                moved = std::fs::rename(e.path(), &p).is_ok();
                if !moved {
                    moved = std::fs::copy(e.path(), &p).map(|_| true).unwrap_or(false);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        if !moved {
            log::warn(
                "Device",
                &format!("下载完成但移动到 {} 失败，产物保留在 {}", local, tmp.display()),
            );
        }
    }
    r
}

pub fn delete_file(serial: &str, path: &str) -> ShellResult {
    adb::shell(serial, &format!("rm -rf '{}'", path.replace('\'', "")))
}

pub fn mkdir(serial: &str, path: &str) -> ShellResult {
    adb::shell(serial, &format!("mkdir -p '{}'", path.replace('\'', "")))
}

pub fn storage_info(serial: &str) -> String {
    adb::shell(serial, "df -h /data 2>/dev/null || df -h").stdout
}

// ---- Screenshot ----

pub fn screenshot(serial: &str) -> ScreenshotResult {
    let dir = settings::screenshot_path();
    util::ensure_dir(&dir);
    let filename = format!("shot_{}_{}.png", serial.replace(':', "_"), util::now_millis());
    let local = PathBuf::from(&dir).join(&filename);
    let remote = format!("/sdcard/{}", filename);

    let cap = adb::screencap(serial, &remote);
    if !cap.success {
        return ScreenshotResult {
            success: false,
            path: String::new(),
            base64: String::new(),
            error: (cap.stderr + " " + &cap.stdout).trim().to_string(),
        };
    }
    let pull = adb::pull(serial, &remote, &local.to_string_lossy());
    let _ = adb::shell(serial, &format!("rm -f {}", remote));
    if !pull.success {
        return ScreenshotResult {
            success: false,
            path: String::new(),
            base64: String::new(),
            error: (pull.stderr + " " + &pull.stdout).trim().to_string(),
        };
    }
    let b64 = std::fs::read(&local)
        .map(|bytes| B64.encode(bytes))
        .unwrap_or_default();
    log::info("Device", &format!("Screenshot saved: {}", local.display()));
    ScreenshotResult {
        success: true,
        path: local.to_string_lossy().into(),
        base64: b64,
        error: String::new(),
    }
}

// ---- Logs ----

pub fn device_logcat(serial: &str, lines: u32, clear: bool) -> String {
    adb::logcat(serial, clear, lines).stdout
}

// ---- Device settings ----

pub fn set_resolution(serial: &str, resolution: &str) -> ShellResult {
    if resolution == "reset" {
        return adb::shell(serial, "wm size reset");
    }
    adb::shell(serial, &format!("wm size {}", resolution))
}

pub fn set_dpi(serial: &str, dpi: &str) -> ShellResult {
    if dpi == "reset" {
        return adb::shell(serial, "wm density reset");
    }
    adb::shell(serial, &format!("wm density {}", dpi))
}

pub fn set_language(serial: &str, lang: &str) -> ShellResult {
    // Avoid `stop; start` (restarts Zygote / kills all apps). Locale via settings is safer.
    adb::shell(
        serial,
        &format!(
            "settings put system system_locales {}; setprop persist.sys.locale {}",
            lang, lang
        ),
    )
}

// ---- System / Dashboard ----

pub fn system_status() -> SystemStatus {
    if let Some(s) = cache::status(Duration::from_secs(3)) {
        return s;
    }

    // Fast path: avoid docker info/stats and adb start-server on every poll
    let docker_running = docker::is_running_fast();
    let devices = adb::devices();
    let online = devices.iter().filter(|d| d.state == "device").count() as u32;
    let adb_version = adb::version_cached();
    let adb_running = !devices.is_empty() || (adb_version != "unavailable" && !adb_version.is_empty());
    let host = host_resource_usage();

    let status = SystemStatus {
        docker_running,
        docker_version: if docker_running {
            docker::version_cached()
        } else {
            "unavailable".into()
        },
        adb_running,
        adb_version,
        online_devices: online,
        cpu_usage: host.0,
        memory_usage: host.1,
        memory_total_mb: host.2,
        memory_used_mb: host.3,
    };
    cache::set_status(status.clone());
    status
}

fn host_resource_usage() -> (f64, f64, u64, u64) {
    #[cfg(target_os = "windows")]
    {
        let cpu = util::run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
            ],
            Duration::from_secs(4),
        );
        let mem = util::run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "$o=Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $o.TotalVisibleMemorySize,$o.FreePhysicalMemory",
            ],
            Duration::from_secs(4),
        );
        let cpu_usage = cpu.stdout.trim().parse::<f64>().unwrap_or(0.0);
        let parts: Vec<&str> = mem.stdout.split_whitespace().collect();
        let total_kb = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let free_kb = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let used_kb = total_kb.saturating_sub(free_kb);
        let total_mb = total_kb / 1024;
        let used_mb = used_kb / 1024;
        let mem_pct = if total_kb > 0 {
            (used_kb as f64 / total_kb as f64) * 100.0
        } else {
            0.0
        };
        return (cpu_usage, mem_pct, total_mb, used_mb);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cpu = util::run_command_timeout(
            "sh",
            &["-c", "grep 'cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$4+$5; if(t>0) printf \"%.1f\", 100*u/t}'"],
            Duration::from_secs(2),
        );
        let mem = util::run_command_timeout(
            "sh",
            &["-c", "awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t, a}' /proc/meminfo"],
            Duration::from_secs(2),
        );
        let cpu_usage = cpu.stdout.trim().parse::<f64>().unwrap_or(0.0);
        let parts: Vec<&str> = mem.stdout.split_whitespace().collect();
        let total_kb = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let avail_kb = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let used_kb = total_kb.saturating_sub(avail_kb);
        let total_mb = total_kb / 1024;
        let used_mb = used_kb / 1024;
        let mem_pct = if total_kb > 0 {
            (used_kb as f64 / total_kb as f64) * 100.0
        } else {
            0.0
        };
        return (cpu_usage, mem_pct, total_mb, used_mb);
    }
}

pub fn dashboard() -> DashboardData {
    let status = system_status();
    let devices = list_devices();
    let recent_logs = log::list(None, None, None, 20);
    let recent_screenshots = list_dir_recent(&settings::screenshot_path(), 8);
    let recent_apks = list_dir_recent(&settings::apk_path(), 8);
    let mut notifications = Vec::new();
    if !status.docker_running {
        notifications.push("Docker 未运行".into());
    }
    if !status.adb_running {
        notifications.push("ADB Server 异常".into());
    }
    if status.online_devices == 0 {
        notifications.push("当前没有在线设备".into());
    }
    DashboardData {
        status,
        devices,
        recent_logs,
        recent_screenshots,
        recent_apks,
        notifications,
    }
}

fn list_dir_recent(path: &str, limit: usize) -> Vec<String> {
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .collect();
    entries.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        )
    });
    entries
        .into_iter()
        .take(limit)
        .map(|e| e.path().to_string_lossy().into())
        .collect()
}

pub fn shell_command(serial: &str, command: &str) -> ShellResult {
    adb::shell(serial, command)
}
