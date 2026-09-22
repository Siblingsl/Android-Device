//! Unified device list: Docker track (device.rs) + QEMU track (qemu.rs)
//! merged into one stream for the device center.
//!
//! Zero-coupling rules respected:
//! - `qemu.rs` never imports `device.rs`; this module is the ONLY place the
//!   two tracks meet, and it only combines their public outputs.
//! - `device.rs` / `docker.rs` are untouched — they keep returning plain
//!   `DeviceInfo`; the QEMU tag rides on top via serde `flatten`.
//!
//! Why QEMU instances need no special casing anywhere else: both tracks reach
//! their devices over the SAME host adb channel, and every existing
//! DeviceService command (scrcpy / files / apps / shell / control…) is keyed
//! by serial. A QEMU instance's `id` IS its adb serial (`127.0.0.1:<port>`),
//! so `scrcpy_start`, `install_apk`, `device_tap`, … all work as-is. Commands
//! that drive the *Docker* container itself (restart_device / stop_device,
//! i.e. docker start/stop) and root-channel operations (Magisk / cloak, which
//! need the redroid image's rootfs layout) legitimately fail on QEMU nodes —
//! the error surfaced by the backend is shown verbatim by the UI.
//!
//! Honest status split:
//! - ✅ unit-tested pure functions: source classification, QEMU DeviceInfo
//!   assembly, dedupe merge (Docker track wins on equal serials).
//! - ⚠️ runtime: `list_devices_unified` spawns adb / docker / qemu-center
//!   probes — unverified in this environment (no Docker/adb/QEMU host here).

use std::collections::BTreeSet;

use serde::Serialize;

use crate::models::DeviceInfo;
use crate::services::{device, qemu};

pub const SOURCE_DOCKER: &str = "docker";
pub const SOURCE_ADB: &str = "adb";
pub const SOURCE_QEMU: &str = "qemu";
pub const SOURCE_EMULATOR: &str = "emulator";
pub const SOURCE_REDROID: &str = "redroid";

/// One row of the unified device list: exactly the `DeviceInfo` wire shape
/// (flattened, so the frontend keeps using its existing DeviceInfo type) plus
/// the origin marker and, for QEMU rows, the owning node/instance names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDevice {
    #[serde(flatten)]
    pub device: DeviceInfo,
    /// "docker" (Docker-track redroid container) | "qemu" (redroid instance
    /// inside a qemu-center VM node) | "emulator" (Android Emulator) |
    /// "redroid" (Redroid discovered over ADB) | "adb" (unclassified ADB
    /// device; never treated as proof of physical hardware).
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qemu_vm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qemu_instance: Option<String>,
}

impl UnifiedDevice {
    pub fn plain(device: DeviceInfo, source: &str) -> Self {
        Self {
            device,
            source: source.to_string(),
            qemu_vm: None,
            qemu_instance: None,
        }
    }
}

/// Pure: classify a row from the Docker/ADB probe without claiming that an
/// unclassified ADB row is physical hardware. The device list currently keeps
/// the ADB model in `name` when no Docker container matched it, and the serial
/// is authoritative for Android Emulator rows.
pub fn classify_docker_source(d: &DeviceInfo) -> String {
    if !d.container_id.is_empty() {
        SOURCE_DOCKER.to_string()
    } else if d.serial.to_ascii_lowercase().starts_with("emulator-") {
        SOURCE_EMULATOR.to_string()
    } else if d.name.to_ascii_lowercase().contains("redroid") {
        SOURCE_REDROID.to_string()
    } else {
        SOURCE_ADB.to_string()
    }
}

/// Pure: assemble a DeviceInfo for one QEMU adb mapping. `id == serial` — the
/// existing device detail route (`/devices/:id`) and every serial-keyed
/// command then work over the same adb channel without page changes.
pub fn qemu_device_info(entry: &qemu::QemuAdbDeviceStatus) -> DeviceInfo {
    DeviceInfo {
        id: entry.serial.clone(),
        name: if entry.instance.is_empty() {
            entry.serial.clone()
        } else {
            format!("{}·{}", entry.vm, entry.instance)
        },
        serial: entry.serial.clone(),
        android_version: String::new(),
        online: entry.online,
        cpu: String::new(),
        ram: String::new(),
        fps: 0.0,
        adb_status: if entry.online {
            "device".into()
        } else {
            "offline".into()
        },
        scrcpy_status: "stopped".into(),
        // No Docker container backs a QEMU instance on this host.
        docker_status: "n/a".into(),
        ip: "127.0.0.1".into(),
        mac: String::new(),
        resolution: String::new(),
        dpi: String::new(),
        container_id: String::new(),
        image: String::new(),
        started_at: String::new(),
        uptime: String::new(),
        adb_port: entry
            .serial
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(0),
        scrcpy_port: 0,
        data_volume: String::new(),
        spoofed_model: None,
    }
}

/// Pure merge: Docker container rows keep their order and win dedupe conflicts.
/// Plain ADB rows whose serial is also reported by QEMU are dropped so the
/// explicit QEMU origin cannot be replaced by the generic ADB fallback. QEMU
/// rows without a usable serial are dropped, and remaining QEMU rows append
/// after the Docker-track rows.
pub fn merge_device_lists(docker: Vec<DeviceInfo>, qemu: Vec<UnifiedDevice>) -> Vec<UnifiedDevice> {
    let qemu_serials: BTreeSet<String> = qemu
        .iter()
        .filter(|u| u.source == SOURCE_QEMU && !u.device.serial.is_empty())
        .map(|u| u.device.serial.clone())
        .collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<UnifiedDevice> = Vec::with_capacity(docker.len() + qemu.len());
    for d in docker {
        let source = classify_docker_source(&d);
        if source != SOURCE_DOCKER && qemu_serials.contains(&d.serial) {
            continue;
        }
        seen.insert(d.serial.clone());
        out.push(UnifiedDevice::plain(d, &source));
    }
    for q in qemu {
        if q.device.serial.is_empty() || seen.contains(&q.device.serial) {
            continue;
        }
        seen.insert(q.device.serial.clone());
        out.push(q);
    }
    out
}

/// Pure: wrap a plain DeviceInfo row (Docker track) as a UnifiedDevice.
pub fn from_device_info(d: DeviceInfo) -> UnifiedDevice {
    let source = classify_docker_source(&d);
    UnifiedDevice::plain(d, &source)
}

/// Pure: wrap a QEMU adb status as a UnifiedDevice (carries vm/instance tags).
pub fn from_qemu_status(entry: &qemu::QemuAdbDeviceStatus) -> UnifiedDevice {
    UnifiedDevice {
        device: qemu_device_info(entry),
        source: SOURCE_QEMU.to_string(),
        qemu_vm: Some(entry.vm.clone()),
        qemu_instance: Some(entry.instance.clone()),
    }
}

/// Runtime: Docker track list + QEMU track list, merged. A failing QEMU probe
/// (missing CLI binary, no registry yet) degrades to the Docker list only —
/// the QEMU track is an experimental addition, never a hard dependency.
pub fn list_devices_unified() -> Vec<UnifiedDevice> {
    let docker = device::list_devices();
    let qemu = qemu::list_qemu_adb_devices().unwrap_or_default();
    merge_device_lists(
        docker,
        qemu.into_iter().map(|e| from_qemu_status(&e)).collect(),
    )
}

/// Runtime: resolve one device for the detail page. Docker track first; when
/// it does not know the id (a QEMU serial), fall back to the QEMU track so
/// `/devices/:id` renders the same tab set. The result is enriched through the
/// shared adb channel either way (works for QEMU serials too).
pub fn get_device_unified(id: &str) -> Option<UnifiedDevice> {
    if let Some(d) = device::get_device(id) {
        return Some(from_device_info(d));
    }
    qemu::list_qemu_adb_devices()
        .unwrap_or_default()
        .iter()
        .find(|e| e.serial == id)
        .map(|e| {
            let mut u = from_qemu_status(e);
            u.device = device::enrich_device(u.device);
            u
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn docker_device(serial: &str, container: &str) -> DeviceInfo {
        DeviceInfo {
            id: container.to_string(),
            name: format!("inst-{container}"),
            serial: serial.to_string(),
            android_version: String::new(),
            online: true,
            cpu: String::new(),
            ram: String::new(),
            fps: 0.0,
            adb_status: "device".into(),
            scrcpy_status: "stopped".into(),
            docker_status: "Up 2 minutes".into(),
            ip: "127.0.0.1".into(),
            mac: String::new(),
            resolution: String::new(),
            dpi: String::new(),
            container_id: container.to_string(),
            image: "redroid/redroid:13.0.0-latest".into(),
            started_at: String::new(),
            uptime: String::new(),
            adb_port: 5555,
            scrcpy_port: 0,
            data_volume: String::new(),
            spoofed_model: None,
        }
    }

    fn qemu_status(
        serial: &str,
        vm: &str,
        instance: &str,
        online: bool,
    ) -> qemu::QemuAdbDeviceStatus {
        qemu::QemuAdbDeviceStatus {
            serial: serial.to_string(),
            vm: vm.to_string(),
            instance: instance.to_string(),
            online,
        }
    }

    #[test]
    fn docker_rows_classify_by_container_presence() {
        assert_eq!(
            classify_docker_source(&docker_device("127.0.0.1:5555", "rdc-a")),
            "docker"
        );
        let mut lan = docker_device("192.168.1.8:5555", "");
        lan.container_id = String::new();
        assert_eq!(classify_docker_source(&lan), "adb");
    }

    #[test]
    fn adb_rows_classify_known_virtual_devices_without_calling_them_physical() {
        let mut emulator = docker_device("emulator-5554", "");
        emulator.name = "2210132C".into();
        assert_eq!(classify_docker_source(&emulator), "emulator");

        let mut redroid = docker_device("127.0.0.1:24500", "");
        redroid.name = "redroid14_x86_64".into();
        assert_eq!(classify_docker_source(&redroid), "redroid");
    }

    #[test]
    fn qemu_device_info_uses_serial_as_id_and_parses_port() {
        let info = qemu_device_info(&qemu_status("127.0.0.1:24500", "node1", "r1", true));
        assert_eq!(info.id, "127.0.0.1:24500");
        assert_eq!(info.serial, "127.0.0.1:24500");
        assert_eq!(info.name, "node1·r1");
        assert_eq!(info.adb_port, 24500);
        assert!(info.online);
        assert_eq!(info.adb_status, "device");
        assert_eq!(info.docker_status, "n/a");
        assert!(info.container_id.is_empty());
        // Offline rows keep the same id (so the detail route still resolves).
        let off = qemu_device_info(&qemu_status("127.0.0.1:24501", "node1", "r2", false));
        assert!(!off.online);
        assert_eq!(off.adb_status, "offline");
    }

    #[test]
    fn merge_keeps_docker_rows_first_and_tags_sources() {
        let docker = vec![docker_device("127.0.0.1:5555", "rdc-a")];
        let qemu = vec![from_qemu_status(&qemu_status(
            "127.0.0.1:24500",
            "node1",
            "r1",
            true,
        ))];
        let merged = merge_device_lists(docker, qemu);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].source, "docker");
        assert_eq!(merged[0].device.container_id, "rdc-a");
        assert_eq!(merged[0].qemu_vm, None);
        assert_eq!(merged[1].source, "qemu");
        assert_eq!(merged[1].qemu_vm.as_deref(), Some("node1"));
        assert_eq!(merged[1].qemu_instance.as_deref(), Some("r1"));
    }

    #[test]
    fn merge_dedupes_equal_serials_preferring_the_docker_track() {
        let docker = vec![docker_device("127.0.0.1:24500", "rdc-same")];
        let qemu = vec![
            from_qemu_status(&qemu_status("127.0.0.1:24500", "node1", "r1", true)),
            from_qemu_status(&qemu_status("127.0.0.1:24501", "node1", "r2", false)),
        ];
        let merged = merge_device_lists(docker, qemu);
        assert_eq!(merged.len(), 2, "duplicate serial must be dropped");
        assert!(merged
            .iter()
            .all(|u| u.device.serial != "127.0.0.1:24500" || u.source == "docker"));
        assert_eq!(merged[1].device.serial, "127.0.0.1:24501");
    }

    #[test]
    fn merge_prefers_qemu_over_a_plain_adb_duplicate() {
        let mut adb = docker_device("127.0.0.1:24500", "");
        adb.name = "redroid14_x86_64".into();
        let qemu = vec![from_qemu_status(&qemu_status(
            "127.0.0.1:24500",
            "node1",
            "r1",
            true,
        ))];

        let merged = merge_device_lists(vec![adb], qemu);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "qemu");
        assert_eq!(merged[0].qemu_instance.as_deref(), Some("r1"));
    }

    #[test]
    fn merge_drops_qemu_rows_without_serial() {
        let mut broken = from_qemu_status(&qemu_status("", "node1", "r9", false));
        broken.device.serial = String::new();
        let merged = merge_device_lists(vec![], vec![broken]);
        assert!(merged.is_empty());
    }
}
