use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use crate::models::{AdbInfo, DeviceInfo, DockerInfo, SystemStatus};

struct Entry<T> {
    at: Instant,
    value: T,
}

static DEVICES: Lazy<Mutex<Option<Entry<Vec<DeviceInfo>>>>> = Lazy::new(|| Mutex::new(None));
static STATUS: Lazy<Mutex<Option<Entry<SystemStatus>>>> = Lazy::new(|| Mutex::new(None));
static DOCKER: Lazy<Mutex<Option<Entry<DockerInfo>>>> = Lazy::new(|| Mutex::new(None));
static ADB: Lazy<Mutex<Option<Entry<AdbInfo>>>> = Lazy::new(|| Mutex::new(None));
static ADB_VER: Lazy<Mutex<Option<Entry<String>>>> = Lazy::new(|| Mutex::new(None));
static DOCKER_OK: Lazy<Mutex<Option<Entry<bool>>>> = Lazy::new(|| Mutex::new(None));
static DOCKER_VER: Lazy<Mutex<Option<Entry<String>>>> = Lazy::new(|| Mutex::new(None));

fn get_cached<T: Clone>(slot: &Mutex<Option<Entry<T>>>, ttl: Duration) -> Option<T> {
    let guard = slot.lock();
    guard.as_ref().and_then(|e| {
        if e.at.elapsed() < ttl {
            Some(e.value.clone())
        } else {
            None
        }
    })
}

fn set_cached<T>(slot: &Mutex<Option<Entry<T>>>, value: T) {
    *slot.lock() = Some(Entry {
        at: Instant::now(),
        value,
    });
}

pub fn devices(ttl: Duration) -> Option<Vec<DeviceInfo>> {
    get_cached(&DEVICES, ttl)
}

pub fn set_devices(v: Vec<DeviceInfo>) {
    set_cached(&DEVICES, v);
}

pub fn invalidate_devices() {
    *DEVICES.lock() = None;
}

pub fn status(ttl: Duration) -> Option<SystemStatus> {
    get_cached(&STATUS, ttl)
}

pub fn set_status(v: SystemStatus) {
    set_cached(&STATUS, v);
}

pub fn docker(ttl: Duration) -> Option<DockerInfo> {
    get_cached(&DOCKER, ttl)
}

pub fn set_docker(v: DockerInfo) {
    set_cached(&DOCKER, v);
}

pub fn invalidate_docker() {
    *DOCKER.lock() = None;
    *DOCKER_OK.lock() = None;
    *DOCKER_VER.lock() = None;
}

pub fn adb(ttl: Duration) -> Option<AdbInfo> {
    get_cached(&ADB, ttl)
}

pub fn set_adb(v: AdbInfo) {
    set_cached(&ADB, v);
}

pub fn invalidate_adb() {
    *ADB.lock() = None;
    *ADB_VER.lock() = None;
    invalidate_devices();
    *STATUS.lock() = None;
}

pub fn adb_version(ttl: Duration) -> Option<String> {
    get_cached(&ADB_VER, ttl)
}

pub fn set_adb_version(v: String) {
    set_cached(&ADB_VER, v);
}

pub fn docker_running(ttl: Duration) -> Option<bool> {
    get_cached(&DOCKER_OK, ttl)
}

pub fn set_docker_running(v: bool) {
    set_cached(&DOCKER_OK, v);
}

pub fn docker_version(ttl: Duration) -> Option<String> {
    get_cached(&DOCKER_VER, ttl)
}

pub fn set_docker_version(v: String) {
    set_cached(&DOCKER_VER, v);
}
