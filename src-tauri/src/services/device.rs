use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::AppHandle;

use crate::models::{
    AppInfo, DashboardData, DeviceInfo, FileEntry, ScreenshotResult, ShellResult, SystemStatus,
};
use crate::services::{adb, cache, docker, log, scrcpy, settings, transfer, util};

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
            cpu_usage: 0.0,
            memory_usage: 0.0,
            memory_total_mb: 0,
            memory_used_mb: 0,
            resource_source: String::new(),
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
            battery_level: None,
            battery_charging: None,
            battery_temperature_c: None,
            battery_voltage_v: None,
            battery_power_source: None,
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
            cpu_usage: 0.0,
            memory_usage: 0.0,
            memory_total_mb: 0,
            memory_used_mb: 0,
            resource_source: String::new(),
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
            battery_level: None,
            battery_charging: None,
            battery_temperature_c: None,
            battery_voltage_v: None,
            battery_power_source: None,
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
        "CPU1=$(awk '/^cpu / {idle=$5+$6; total=$2+$3+$4+$5+$6+$7+$8+$9+$10; print total, idle}' /proc/stat); sleep 0.2; CPU2=$(awk '/^cpu / {idle=$5+$6; total=$2+$3+$4+$5+$6+$7+$8+$9+$10; print total, idle}' /proc/stat); echo CPUUSE=$(awk -v first=\"$CPU1\" -v second=\"$CPU2\" 'BEGIN {split(first,a); split(second,b); total=b[1]-a[1]; idle=b[2]-a[2]; if(total>0) printf \"%.1f\", ((total-idle)*100/total); else print 0}'); echo MEMSTAT=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if(t>0) print t, t-a; else print 0, 0}' /proc/meminfo); echo VER=$(getprop ro.build.version.release); echo MODEL=$(getprop ro.product.model); echo ABI=$(getprop ro.product.cpu.abi); echo SIZE=$(wm size 2>/dev/null | tail -1); echo DPI=$(wm density 2>/dev/null | tail -1); echo MEM=$(grep MemTotal /proc/meminfo 2>/dev/null); echo MAC=$(cat /sys/class/net/wlan0/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null); echo UP=$(cat /proc/uptime 2>/dev/null | awk '{print $1}'); echo BATT=$(dumpsys battery 2>/dev/null | tr '\n' ';')",
    );
    let runtime = parse_android_runtime_metrics(&batch.stdout);
    let battery = batch
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("BATT="))
        .map(parse_battery_metrics)
        .unwrap_or_default();
    d.cpu_usage = runtime.cpu_usage;
    d.memory_usage = runtime.memory_usage;
    d.memory_total_mb = runtime.memory_total_mb;
    d.memory_used_mb = runtime.memory_used_mb;
    if runtime.memory_total_mb > 0 || runtime.cpu_usage > 0.0 {
        d.resource_source = "android".into();
    }
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
    if let Some(stats) = docker::container_stats(&d.container_id) {
        d.cpu_usage = stats.cpu_usage;
        d.memory_usage = stats.memory_usage;
        d.memory_total_mb = stats.memory_total_mb;
        d.memory_used_mb = stats.memory_used_mb;
        d.resource_source = "container".into();
    }
    d.scrcpy_status = scrcpy::status(&serial);
    d.battery_level = battery.level;
    d.battery_charging = battery.charging;
    d.battery_temperature_c = battery.temperature_c;
    d.battery_voltage_v = battery.voltage_v;
    d.battery_power_source = battery.power_source;
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

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct DeviceRuntimeMetrics {
    cpu_usage: f64,
    memory_usage: f64,
    memory_total_mb: u64,
    memory_used_mb: u64,
}

fn parse_android_runtime_metrics(output: &str) -> DeviceRuntimeMetrics {
    let mut metrics = DeviceRuntimeMetrics::default();
    let mut memory_total_kb = 0_u64;
    let mut memory_used_kb = 0_u64;

    for line in output.lines() {
        if let Some(value) = line.strip_prefix("CPUUSE=") {
            metrics.cpu_usage = value
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(0.0);
        } else if let Some(value) = line.strip_prefix("MEMSTAT=") {
            let parts: Vec<&str> = value.split_whitespace().collect();
            memory_total_kb = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
            memory_used_kb = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }

    if memory_total_kb > 0 {
        memory_used_kb = memory_used_kb.min(memory_total_kb);
        metrics.memory_total_mb = memory_total_kb / 1024;
        metrics.memory_used_mb = memory_used_kb / 1024;
        metrics.memory_usage = (memory_used_kb as f64 / memory_total_kb as f64 * 100.0)
            .clamp(0.0, 100.0);
    }

    metrics
}

#[derive(Debug, Clone, Default, PartialEq)]
struct DeviceBatteryMetrics {
    level: Option<u8>,
    charging: Option<bool>,
    temperature_c: Option<f64>,
    voltage_v: Option<f64>,
    power_source: Option<String>,
}

fn parse_battery_metrics(output: &str) -> DeviceBatteryMetrics {
    let mut values = std::collections::HashMap::<String, String>::new();
    for entry in output.split(';') {
        let Some((key, value)) = entry.split_once(':') else {
            continue;
        };
        values.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
    }

    let scale = values
        .get("scale")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(100.0);
    let level = values
        .get("level")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value >= 0.0)
        .map(|value| ((value / scale) * 100.0).round().clamp(0.0, 100.0) as u8);
    let charging = values.get("status").and_then(|value| match value.as_str() {
        "2" => Some(true),
        "1" | "3" | "4" | "5" => Some(false),
        _ => None,
    });
    let temperature_c = values
        .get("temperature")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .map(|value| if value.abs() > 100.0 { value / 10.0 } else { value });
    let voltage_v = values
        .get("voltage")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .map(|value| if value.abs() > 100.0 { value / 1000.0 } else { value });

    let mut sources = Vec::new();
    for (key, label) in [("ac powered", "AC"), ("usb powered", "USB"), ("wireless powered", "Wireless")] {
        if values.get(key).is_some_and(|value| value.eq_ignore_ascii_case("true")) {
            sources.push(label);
        }
    }

    DeviceBatteryMetrics {
        level,
        charging,
        temperature_c,
        voltage_v,
        power_source: (!sources.is_empty()).then(|| sources.join(" + ")),
    }
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
    let _ = scrcpy::stop_recording(serial);
    let _ = scrcpy::stop_camera(serial);
    let _ = scrcpy::stop_input(serial);
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
        let _ = scrcpy::stop(&d.serial);
        let _ = scrcpy::stop_recording(&d.serial);
        let _ = scrcpy::stop_camera(&d.serial);
        let _ = scrcpy::stop_input(&d.serial);
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
        let _ = scrcpy::stop_recording(&d.serial);
        let _ = scrcpy::stop_camera(&d.serial);
        let _ = scrcpy::stop_input(&d.serial);
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

pub fn volume_mute(serial: &str) -> ShellResult {
    keyevent(serial, 164)
}

pub fn lock(serial: &str) -> ShellResult {
    adb::shell(serial, "input keyevent 26")
}

pub fn wake(serial: &str) -> ShellResult {
    adb::shell(serial, "input keyevent 224")
}

pub fn rotate(serial: &str, landscape: bool) -> ShellResult {
    set_rotation_mode(serial, if landscape { "landscape" } else { "portrait" })
}

pub fn set_rotation_mode(serial: &str, mode: &str) -> ShellResult {
    match rotation_command(mode) {
        Some(command) => adb::shell(serial, command),
        None => ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "旋转模式无效".into(),
            exit_code: -1,
        },
    }
}

fn rotation_command(mode: &str) -> Option<&'static str> {
    match mode {
        "portrait" => Some("settings put system accelerometer_rotation 0; settings put system user_rotation 0"),
        "landscape" => Some("settings put system accelerometer_rotation 0; settings put system user_rotation 1"),
        "auto" => Some("settings put system accelerometer_rotation 1"),
        // Locking keeps the current user_rotation value and only disables auto-rotation.
        "lock" => Some("settings put system accelerometer_rotation 0"),
        _ => None,
    }
}

pub fn screen_off(serial: &str) -> ShellResult {
    lock(serial)
}

pub fn reboot(serial: &str) -> ShellResult {
    adb::shell(serial, "reboot")
}

pub fn shutdown(serial: &str) -> ShellResult {
    adb::shell(serial, "reboot -p")
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

fn sanitize_transfer_id(operation_id: &str) -> String {
    let sanitized: String = operation_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "operation".into()
    } else {
        sanitized
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', ""))
}

fn tracked_remote_path(remote: &str, operation_id: &str) -> String {
    format!(
        "{}.rdc_transfer_{}.part",
        remote.trim_end_matches('/'),
        sanitize_transfer_id(operation_id)
    )
}

fn tracked_download_temp_path(path: &std::path::Path, operation_id: &str) -> PathBuf {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    parent.join(format!(
        ".rdc_pull_{}",
        sanitize_transfer_id(operation_id)
    ))
}

fn tracked_status(result: &util::CancellableCommandResult) -> &'static str {
    match result {
        util::CancellableCommandResult::Completed(result) if result.success => "completed",
        util::CancellableCommandResult::Cancelled(_) => "cancelled",
        util::CancellableCommandResult::Completed(_) | util::CancellableCommandResult::TimedOut(_) => {
            "failed"
        }
    }
}

fn cancelled_transfer_result() -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: "command cancelled".into(),
        exit_code: -1,
    }
}

fn emit_transfer_progress(
    app: &AppHandle,
    operation_id: &str,
    direction: &str,
    status: &str,
    bytes_transferred: Option<u64>,
    total_bytes: Option<u64>,
    percent: Option<u8>,
    message: impl Into<String>,
) {
    let payload = transfer::FileTransferProgress {
        operation_id: operation_id.into(),
        direction: direction.into(),
        status: status.into(),
        bytes_transferred,
        total_bytes,
        percent,
        message: message.into(),
    };
    if let Err(error) = transfer::emit_progress(app, payload) {
        log::warn("Transfer", &format!("emit progress failed: {error}"));
    }
}

fn progress_callback(
    app: &AppHandle,
    operation_id: &str,
    direction: &str,
    total_bytes: Option<u64>,
) -> impl Fn(String) + Send + Sync + 'static {
    let app = app.clone();
    let operation_id = operation_id.to_string();
    let direction = direction.to_string();
    let output = Arc::new(parking_lot::Mutex::new(String::new()));
    let last_percent = Arc::new(parking_lot::Mutex::new(None::<u8>));
    move |chunk| {
        let parsed = {
            let mut output = output.lock();
            output.push_str(&chunk);
            if output.len() > 8192 {
                let keep_from = output.len() - 4096;
                output.drain(..keep_from);
            }
            transfer::parse_adb_progress(&output, total_bytes)
        };
        let Some(parsed) = parsed else { return };
        let should_emit = {
            let mut last = last_percent.lock();
            if last.is_some_and(|previous| parsed.percent < previous) {
                false
            } else {
                *last = Some(parsed.percent);
                true
            }
        };
        if should_emit {
            emit_transfer_progress(
                &app,
                &operation_id,
                &direction,
                "running",
                parsed.bytes_transferred,
                parsed.total_bytes,
                Some(parsed.percent),
                format!("{direction} {}%", parsed.percent),
            );
        }
    }
}

fn cleanup_remote_part(serial: &str, path: &str) {
    let _ = adb::shell(serial, &format!("rm -f {}", shell_quote(path)));
}

fn remote_file_size(serial: &str, remote: &str) -> Option<u64> {
    let result = adb::shell(
        serial,
        &format!("stat -c %s {} 2>/dev/null", shell_quote(remote)),
    );
    result.stdout.trim().parse().ok()
}

pub fn upload_file_tracked(
    app: &AppHandle,
    serial: &str,
    local: &str,
    remote: &str,
    operation_id: &str,
    cancel: &AtomicBool,
) -> ShellResult {
    let total_bytes = std::fs::metadata(local)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len());
    let staged_remote = tracked_remote_path(remote, operation_id);
    emit_transfer_progress(
        app,
        operation_id,
        "upload",
        "queued",
        None,
        total_bytes,
        None,
        "queued",
    );
    emit_transfer_progress(
        app,
        operation_id,
        "upload",
        "running",
        None,
        total_bytes,
        None,
        "upload running",
    );

    let command = adb::push_tracked(
        serial,
        local,
        &staged_remote,
        cancel,
        progress_callback(app, operation_id, "upload", total_bytes),
    );
    let status = tracked_status(&command);
    if status != "completed" {
        cleanup_remote_part(serial, &staged_remote);
        let message = if status == "cancelled" {
            "cancelled"
        } else {
            "upload failed"
        };
        emit_transfer_progress(
            app,
            operation_id,
            "upload",
            status,
            None,
            total_bytes,
            None,
            message,
        );
        return match command {
            util::CancellableCommandResult::Completed(result)
            | util::CancellableCommandResult::Cancelled(result)
            | util::CancellableCommandResult::TimedOut(result) => result,
        };
    }
    if cancel.load(Ordering::SeqCst) {
        cleanup_remote_part(serial, &staged_remote);
        emit_transfer_progress(
            app,
            operation_id,
            "upload",
            "cancelled",
            None,
            total_bytes,
            None,
            "cancelled",
        );
        return cancelled_transfer_result();
    }

    let moved = adb::shell(
        serial,
        &format!(
            "mv -f {} {}",
            shell_quote(&staged_remote),
            shell_quote(remote)
        ),
    );
    if !moved.success {
        cleanup_remote_part(serial, &staged_remote);
        emit_transfer_progress(
            app,
            operation_id,
            "upload",
            "failed",
            None,
            total_bytes,
            None,
            "upload finalization failed",
        );
        return moved;
    }

    emit_transfer_progress(
        app,
        operation_id,
        "upload",
        "completed",
        total_bytes,
        total_bytes,
        total_bytes.map(|_| 100),
        "completed",
    );
    match command {
        util::CancellableCommandResult::Completed(result) => result,
        util::CancellableCommandResult::Cancelled(result)
        | util::CancellableCommandResult::TimedOut(result) => result,
    }
}

pub fn download_file_tracked(
    app: &AppHandle,
    serial: &str,
    remote: &str,
    local: &str,
    operation_id: &str,
    cancel: &AtomicBool,
) -> ShellResult {
    let path = PathBuf::from(local);
    let total_bytes = remote_file_size(serial, remote);
    emit_transfer_progress(
        app,
        operation_id,
        "download",
        "queued",
        None,
        total_bytes,
        None,
        "queued",
    );
    emit_transfer_progress(
        app,
        operation_id,
        "download",
        "running",
        None,
        total_bytes,
        None,
        "download running",
    );

    if path.is_dir() {
        let command = adb::pull_tracked(
            serial,
            remote,
            local,
            cancel,
            progress_callback(app, operation_id, "download", total_bytes),
        );
        let status = tracked_status(&command);
        emit_transfer_progress(
            app,
            operation_id,
            "download",
            status,
            total_bytes.filter(|_| status == "completed"),
            total_bytes,
            total_bytes.filter(|_| status == "completed").map(|_| 100),
            status,
        );
        return match command {
            util::CancellableCommandResult::Completed(result)
            | util::CancellableCommandResult::Cancelled(result)
            | util::CancellableCommandResult::TimedOut(result) => result,
        };
    }

    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if let Err(error) = std::fs::create_dir_all(&parent) {
        let result = ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("创建目标目录失败: {error}"),
            exit_code: -1,
        };
        emit_transfer_progress(
            app,
            operation_id,
            "download",
            "failed",
            None,
            total_bytes,
            None,
            &result.stderr,
        );
        return result;
    }

    let temp = tracked_download_temp_path(&path, operation_id);
    let command = adb::pull_tracked(
        serial,
        remote,
        &temp.to_string_lossy(),
        cancel,
        progress_callback(app, operation_id, "download", total_bytes),
    );
    let status = tracked_status(&command);
    if status != "completed" {
        let _ = std::fs::remove_dir_all(&temp);
        emit_transfer_progress(
            app,
            operation_id,
            "download",
            status,
            None,
            total_bytes,
            None,
            status,
        );
        return match command {
            util::CancellableCommandResult::Completed(result)
            | util::CancellableCommandResult::Cancelled(result)
            | util::CancellableCommandResult::TimedOut(result) => result,
        };
    }
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&temp);
        emit_transfer_progress(
            app,
            operation_id,
            "download",
            "cancelled",
            None,
            total_bytes,
            None,
            "cancelled",
        );
        return cancelled_transfer_result();
    }

    let moved = std::fs::read_dir(&temp)
        .ok()
        .and_then(|mut entries| entries.next())
        .and_then(Result::ok)
        .map(|entry| {
            std::fs::rename(entry.path(), &path)
                .or_else(|_| std::fs::copy(entry.path(), &path).map(|_| ()))
        })
        .map(|result| result.is_ok())
        .unwrap_or(false);
    let _ = std::fs::remove_dir_all(&temp);
    if !moved {
        let result = ShellResult {
            success: false,
            stdout: String::new(),
            stderr: format!("下载完成但移动到 {} 失败", path.display()),
            exit_code: -1,
        };
        emit_transfer_progress(
            app,
            operation_id,
            "download",
            "failed",
            None,
            total_bytes,
            None,
            &result.stderr,
        );
        return result;
    }

    emit_transfer_progress(
        app,
        operation_id,
        "download",
        "completed",
        total_bytes,
        total_bytes,
        total_bytes.map(|_| 100),
        "completed",
    );
    match command {
        util::CancellableCommandResult::Completed(result) => result,
        util::CancellableCommandResult::Cancelled(result)
        | util::CancellableCommandResult::TimedOut(result) => result,
    }
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

#[cfg(test)]
mod metrics_tests {
    use super::*;
    use crate::services::util::CancellableCommandResult;

    #[test]
    fn parse_android_runtime_metrics_calculates_memory_usage() {
        let metrics = parse_android_runtime_metrics(
            "CPUUSE=37.5\nMEMSTAT=2048000 1024000\n",
        );

        assert!((metrics.cpu_usage - 37.5).abs() < f64::EPSILON);
        assert!((metrics.memory_usage - 50.0).abs() < f64::EPSILON);
        assert_eq!(metrics.memory_total_mb, 2000);
        assert_eq!(metrics.memory_used_mb, 1000);
    }

    #[test]
    fn parse_android_runtime_metrics_ignores_invalid_values() {
        let metrics = parse_android_runtime_metrics("CPUUSE=bad\nMEMSTAT=0 0\n");

        assert_eq!(metrics.cpu_usage, 0.0);
        assert_eq!(metrics.memory_usage, 0.0);
        assert_eq!(metrics.memory_total_mb, 0);
        assert_eq!(metrics.memory_used_mb, 0);
    }

    #[test]
    fn parse_battery_metrics_reports_charge_state_and_power_source() {
        let metrics = parse_battery_metrics(
            "status: 2; level: 78; scale: 100; voltage: 4210; temperature: 315; AC powered: false; USB powered: true; Wireless powered: false;",
        );

        assert_eq!(metrics.level, Some(78));
        assert_eq!(metrics.charging, Some(true));
        assert_eq!(metrics.temperature_c, Some(31.5));
        assert_eq!(metrics.voltage_v, Some(4.21));
        assert_eq!(metrics.power_source.as_deref(), Some("USB"));
    }

    #[test]
    fn parse_battery_metrics_keeps_unavailable_values_empty() {
        let metrics = parse_battery_metrics("present: false; status: 1; level: -1; voltage: 0; temperature: 0;");

        assert_eq!(metrics.level, None);
        assert_eq!(metrics.charging, Some(false));
        assert_eq!(metrics.temperature_c, None);
        assert_eq!(metrics.voltage_v, None);
        assert_eq!(metrics.power_source, None);
    }

    #[test]
    fn tracked_remote_path_keeps_target_separate_from_partial_upload() {
        let staged = tracked_remote_path("/sdcard/report.apk", "op-1");
        assert_eq!(staged, "/sdcard/report.apk.rdc_transfer_op-1.part");
        assert_ne!(staged, "/sdcard/report.apk");
    }

    #[test]
    fn tracked_download_temp_path_is_inside_selected_parent() {
        let temp = tracked_download_temp_path(std::path::Path::new("exports/report.apk"), "op-1");
        assert_eq!(temp, std::path::PathBuf::from("exports/.rdc_pull_op-1"));
    }

    #[test]
    fn tracked_command_results_map_to_terminal_statuses() {
        let success = ShellResult {
            success: true,
            ..ShellResult::default()
        };
        let failure = ShellResult::default();
        assert_eq!(tracked_status(&CancellableCommandResult::Completed(success)), "completed");
        assert_eq!(tracked_status(&CancellableCommandResult::Completed(failure)), "failed");
        assert_eq!(
            tracked_status(&CancellableCommandResult::Cancelled(ShellResult::default())),
            "cancelled"
        );
        assert_eq!(
            tracked_status(&CancellableCommandResult::TimedOut(ShellResult::default())),
            "failed"
        );
    }

    #[test]
    fn rotation_modes_map_to_safe_android_settings_commands() {
        assert_eq!(rotation_command("portrait"), Some("settings put system accelerometer_rotation 0; settings put system user_rotation 0"));
        assert_eq!(rotation_command("landscape"), Some("settings put system accelerometer_rotation 0; settings put system user_rotation 1"));
        assert_eq!(rotation_command("auto"), Some("settings put system accelerometer_rotation 1"));
        assert_eq!(rotation_command("lock"), Some("settings put system accelerometer_rotation 0"));
        assert_eq!(rotation_command("settings put system"), None);
    }
}
