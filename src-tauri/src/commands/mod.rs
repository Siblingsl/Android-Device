use crate::models::*;
use crate::services::{
    adb, art, audit, authorization, authorization_client, battery, cloak, config, device, docker,
    geo, gnirehtet, log, proxy, recording, resource_monitor, root, runtime_scheduler, scrcpy,
    settings, spoof, terminal, terminal_session, transfer, usage, wireless, wsl_kernel,
};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

static RUNTIME_SCHEDULER: Lazy<parking_lot::Mutex<runtime_scheduler::SchedulerState>> =
    Lazy::new(|| parking_lot::Mutex::new(runtime_scheduler::SchedulerState::default()));
static RUNTIME_START_CONDVAR: Lazy<parking_lot::Condvar> = Lazy::new(parking_lot::Condvar::new);
static QEMU_VM_START_LOCK: Lazy<parking_lot::Mutex<()>> = Lazy::new(|| parking_lot::Mutex::new(()));

const RUNTIME_START_QUEUE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const QEMU_VM_START_HEADROOM_MIB: u64 = 1024;
const BYTES_PER_MIB: u64 = 1024 * 1024;

async fn blocking<T: Send + 'static + Default>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_default()
}

async fn blocking_opt<T: Send + 'static>(
    f: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or(None)
}

async fn blocking_res<T: Send + 'static, E: Send + 'static + Default>(
    f: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(v) => v,
        Err(_) => Err(E::default()),
    }
}

// ---- System / Dashboard ----

#[tauri::command]
pub async fn get_dashboard() -> DashboardData {
    blocking(device::dashboard).await
}

#[tauri::command]
pub async fn get_system_status() -> SystemStatus {
    blocking(device::system_status).await
}

/// First-use readiness checklist for the Dashboard: reuses the existing probe
/// functions (docker / adb / scrcpy / WHPX / qemu-center / cloud image).
#[tauri::command]
pub async fn readiness_checklist() -> Vec<crate::services::readiness::ReadinessItem> {
    blocking(crate::services::readiness::checklist).await
}

#[tauri::command]
pub async fn optimize_app_art(
    serial: String,
    package: String,
    mode: art::ArtMode,
) -> Result<art::ArtOptimizationResult, String> {
    blocking_res(move || art::optimize_app(&serial, &package, mode)).await
}

#[tauri::command]
pub fn authorization_status() -> authorization_client::AuthorizationRuntimeStatus {
    authorization_client::runtime_authorization_status()
}

#[tauri::command]
pub async fn authorization_register(
) -> Result<authorization_client::CompleteRegistrationResponse, String> {
    authorization_client::runtime_register()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn authorization_acquire_session(
    capability: authorization::ProtectedCapability,
) -> Result<authorization_client::AuthorizationRuntimeStatus, String> {
    authorization_client::runtime_acquire(capability)
        .await
        .map_err(|error| error.to_string())?;
    Ok(authorization_client::runtime_authorization_status())
}

#[tauri::command]
pub async fn authorization_heartbeat(
) -> Result<authorization_client::AuthorizationRuntimeStatus, String> {
    authorization_client::runtime_heartbeat()
        .await
        .map_err(|error| error.to_string())?;
    Ok(authorization_client::runtime_authorization_status())
}

#[tauri::command]
pub fn authorization_revoke_local() -> authorization_client::AuthorizationRuntimeStatus {
    authorization_client::runtime_revoke_local();
    authorization_client::runtime_authorization_status()
}

/// Read-only host/QEMU resource snapshot. Guest/container fields are filled by
/// the QEMU-specific stats command when the caller requests that track.
#[tauri::command]
pub async fn read_runtime_resource_snapshot(
    vm: Option<String>,
    instance: Option<String>,
) -> Result<resource_monitor::RuntimeResourceSnapshot, String> {
    blocking_res(move || {
        resource_monitor::read_runtime_resource_snapshot(vm.as_deref(), instance.as_deref())
    })
    .await
}

fn runtime_policy() -> runtime_scheduler::LifecyclePolicy {
    let settings = settings::get();
    runtime_scheduler::LifecyclePolicy {
        idle_timeout_minutes: settings.runtime_idle_timeout_minutes,
        keep_vm_warm: settings.runtime_keep_vm_warm,
        max_parallel_starts: settings.runtime_max_parallel_starts.max(1),
        protected_instance_ids: settings.runtime_protected_instance_ids,
        auto_release_idle_on_critical: settings.runtime_auto_release_idle_on_critical,
    }
}

fn should_block_runtime_start(
    pressure: resource_monitor::MemoryPressure,
    other_start_in_flight: bool,
) -> bool {
    matches!(pressure, resource_monitor::MemoryPressure::Critical)
        || (matches!(pressure, resource_monitor::MemoryPressure::Unknown) && other_start_in_flight)
}

fn should_attempt_critical_guest_reclaim(
    pressure: resource_monitor::MemoryPressure,
    other_start_in_flight: bool,
    auto_release_idle_on_critical: bool,
) -> bool {
    auto_release_idle_on_critical
        && matches!(pressure, resource_monitor::MemoryPressure::Critical)
        && !other_start_in_flight
}

/// A VM's `-m` allocation is committed before any guest/container can report
/// its own usage. Account for it plus one GiB of host headroom before asking
/// QEMU to spawn a new process. Unknown probes preserve the explicit single
/// start compatibility path; they are never converted into a safe zero.
fn should_block_qemu_vm_start(
    host_available_bytes: Option<u64>,
    vm_memory_mib: Option<u32>,
) -> bool {
    let (Some(host_available_bytes), Some(vm_memory_mib)) = (host_available_bytes, vm_memory_mib)
    else {
        return false;
    };
    if vm_memory_mib == 0 {
        return true;
    }
    let required_bytes = u64::from(vm_memory_mib)
        .saturating_add(QEMU_VM_START_HEADROOM_MIB)
        .saturating_mul(BYTES_PER_MIB);
    host_available_bytes < required_bytes
}

fn qemu_vm_start_memory_error(name: &str, host_available_bytes: u64, vm_memory_mib: u32) -> String {
    let required_mib = u64::from(vm_memory_mib).saturating_add(QEMU_VM_START_HEADROOM_MIB);
    let available_mib = host_available_bytes / BYTES_PER_MIB;
    format!(
        "主机可用内存不足，已阻止启动 QEMU 节点 {name}：节点配置 {vm_memory_mib} MiB，启动至少需要 {required_mib} MiB 余量，当前约 {available_mib} MiB。请先释放闲置实例或选择 lean/standard。"
    )
}

fn select_idle_reclaim_candidate(
    rows: &[crate::services::qemu::QemuRedroidInstance],
    reclaimable: &[String],
    target_instance: &str,
) -> Option<String> {
    reclaimable.iter().find_map(|candidate| {
        if candidate == target_instance {
            return None;
        }
        let row = rows.iter().find(|row| row.instance == *candidate)?;
        crate::services::qemu::is_running_status(&row.status).then(|| row.instance.clone())
    })
}

/// A memory-first idle release may stop the QEMU node only after a fresh
/// listing proves that no other instance is running. Unknown or unavailable
/// status data fails closed and keeps the node warm.
fn should_stop_vm_after_idle_release(
    keep_vm_warm: bool,
    rows: Option<&[crate::services::qemu::QemuRedroidInstance]>,
    released_instance: &str,
) -> bool {
    if keep_vm_warm {
        return false;
    }
    let Some(rows) = rows else {
        return false;
    };
    rows.iter()
        .filter(|row| row.instance != released_instance)
        .all(|row| {
            let status = row.status.trim();
            !status.is_empty()
                && !status.eq_ignore_ascii_case("unknown")
                && !crate::services::qemu::is_running_status(status)
        })
}

/// A warm-node preference is honored until the host reaches the critical
/// threshold. An unavailable probe remains conservative and keeps an explicit
/// warm preference; callers that already chose memory-first still return false.
fn keep_vm_warm_for_pressure(
    keep_vm_warm: bool,
    pressure: resource_monitor::MemoryPressure,
) -> bool {
    keep_vm_warm && pressure != resource_monitor::MemoryPressure::Critical
}

/// Stop at most one safe idle container before a critical-pressure start.
/// The node is intentionally kept running because the caller is about to
/// start another container on that same node. All decisions are made from a
/// scheduler snapshot plus a fresh read-only Docker status listing.
fn try_auto_release_idle_instance(vm: &str, target_instance: &str, now: SystemTime) -> bool {
    let candidates = {
        let mut scheduler = RUNTIME_SCHEDULER.lock();
        scheduler.update_policy(runtime_policy());
        if !scheduler.policy().auto_release_idle_on_critical || !scheduler.begin_reclaim() {
            return false;
        }
        scheduler.reclaimable_instances(now)
    };

    let released = (|| {
        let rows = crate::services::qemu::redroid_list_basic(vm).ok()?;
        let candidate = select_idle_reclaim_candidate(&rows, &candidates, target_instance)?;
        let output = crate::services::qemu::redroid_stop(vm, &candidate).ok()?;
        output.success.then_some(candidate)
    })();

    let mut scheduler = RUNTIME_SCHEDULER.lock();
    scheduler.finish_reclaim();
    if let Some(instance) = released {
        scheduler.clear_instance(&instance);
        true
    } else {
        false
    }
}

/// Ask qemu-center for one conservative guest balloon reclaim after an
/// explicitly memory-saving lifecycle action. The CLI owns liveness, metrics,
/// target calculation, and QMP verification; a failure simply preserves the
/// successful lifecycle action.
fn try_auto_reclaim_guest_memory(vm: &str) -> bool {
    crate::services::qemu::vm_memory_reclaim(vm)
        .map(|output| output.success)
        .unwrap_or(false)
}

fn run_guest_reclaim_after_app_hibernate<F>(app_stopped: bool, reclaim: F) -> bool
where
    F: FnOnce() -> bool,
{
    app_stopped && reclaim()
}

#[tauri::command]
pub async fn runtime_mark_activity(instance: String, kind: String) -> Result<(), String> {
    blocking_res(move || {
        let kind = runtime_scheduler::parse_activity_kind(&kind)?;
        let mut scheduler = RUNTIME_SCHEDULER.lock();
        scheduler.update_policy(runtime_policy());
        scheduler.mark_activity(&instance, kind, SystemTime::now());
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn runtime_request_start(
    vm: String,
    instance: String,
) -> Result<runtime_scheduler::StartDecision, String> {
    blocking_res(move || {
        let snapshot = resource_monitor::read_runtime_resource_snapshot(Some(&vm), Some(&instance))
            .unwrap_or_default();
        let mut pressure =
            resource_monitor::classify_memory_pressure(snapshot.host_available_bytes);
        let mut scheduler = RUNTIME_SCHEDULER.lock();
        scheduler.update_policy(runtime_policy());
        // Unknown pressure is still an actionable single-instance path, but
        // it must not become an unbounded concurrent-start escape hatch.
        let other_start_in_flight = scheduler.has_other_start(&vm, &instance);
        let auto_release = scheduler.policy().auto_release_idle_on_critical;
        if should_block_runtime_start(pressure, other_start_in_flight) {
            drop(scheduler);
            if should_attempt_critical_guest_reclaim(pressure, other_start_in_flight, auto_release)
                && try_auto_reclaim_guest_memory(&vm)
            {
                let refreshed =
                    resource_monitor::read_runtime_resource_snapshot(Some(&vm), Some(&instance))
                        .unwrap_or_default();
                pressure =
                    resource_monitor::classify_memory_pressure(refreshed.host_available_bytes);
            }
            if pressure == resource_monitor::MemoryPressure::Critical
                && !other_start_in_flight
                && auto_release
                && try_auto_release_idle_instance(&vm, &instance, SystemTime::now())
            {
                let refreshed =
                    resource_monitor::read_runtime_resource_snapshot(Some(&vm), Some(&instance))
                        .unwrap_or_default();
                pressure =
                    resource_monitor::classify_memory_pressure(refreshed.host_available_bytes);
            }
            scheduler = RUNTIME_SCHEDULER.lock();
            if should_block_runtime_start(pressure, scheduler.has_other_start(&vm, &instance)) {
                return Ok(runtime_scheduler::StartDecision::Blocked(pressure));
            }
        }
        match scheduler.request_start(&vm, &instance) {
            runtime_scheduler::StartDecision::Starting => {}
            runtime_scheduler::StartDecision::Queued => {
                let deadline = Instant::now() + RUNTIME_START_QUEUE_TIMEOUT;
                loop {
                    if scheduler.is_starting(&vm, &instance) {
                        break;
                    }
                    if !scheduler.is_queued(&vm, &instance) {
                        return Ok(runtime_scheduler::StartDecision::Failed(
                            "start queue entry was cancelled".into(),
                        ));
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        scheduler.cancel_queued_start(&vm, &instance);
                        RUNTIME_START_CONDVAR.notify_all();
                        return Ok(runtime_scheduler::StartDecision::Failed(
                            "start queue timed out".into(),
                        ));
                    }
                    RUNTIME_START_CONDVAR
                        .wait_for(&mut scheduler, remaining.min(Duration::from_secs(1)));
                }
            }
            decision => return Ok(decision),
        }
        drop(scheduler);

        // A queued request can become unsafe while it waits. Re-check the
        // host immediately before invoking QEMU and release the turn without
        // starting anything if pressure has become critical.
        let snapshot = resource_monitor::read_runtime_resource_snapshot(Some(&vm), Some(&instance))
            .unwrap_or_default();
        let pressure = resource_monitor::classify_memory_pressure(snapshot.host_available_bytes);
        if pressure == resource_monitor::MemoryPressure::Critical {
            let mut scheduler = RUNTIME_SCHEDULER.lock();
            let _ = scheduler.finish_start(&vm, &instance, false);
            scheduler.promote_next_start();
            RUNTIME_START_CONDVAR.notify_all();
            return Ok(runtime_scheduler::StartDecision::Blocked(pressure));
        }

        let result = crate::services::qemu::redroid_start(&vm, &instance);
        let mut scheduler = RUNTIME_SCHEDULER.lock();
        match result {
            Ok(output) if output.success => {
                scheduler.mark_activity(
                    &instance,
                    runtime_scheduler::ActivityKind::UserWindow,
                    SystemTime::now(),
                );
                let decision = scheduler.finish_start(&vm, &instance, true);
                scheduler.promote_next_start();
                RUNTIME_START_CONDVAR.notify_all();
                Ok(decision)
            }
            Ok(output) => {
                let error = output.stderr.trim().to_string();
                let _ = scheduler.finish_start(&vm, &instance, false);
                scheduler.promote_next_start();
                RUNTIME_START_CONDVAR.notify_all();
                Ok(runtime_scheduler::StartDecision::Failed(error))
            }
            Err(error) => {
                let _ = scheduler.finish_start(&vm, &instance, false);
                scheduler.promote_next_start();
                RUNTIME_START_CONDVAR.notify_all();
                Ok(runtime_scheduler::StartDecision::Failed(error))
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn runtime_release_idle(
    vm: String,
    instance: String,
) -> Result<runtime_scheduler::IdleReleaseResult, String> {
    blocking_res(move || {
        let now = SystemTime::now();
        let mut scheduler = RUNTIME_SCHEDULER.lock();
        scheduler.update_policy(runtime_policy());
        if !scheduler.is_reclaimable(&instance, now) {
            let protected = scheduler
                .policy()
                .protected_instance_ids
                .iter()
                .any(|id| id == &instance);
            let reason = if protected {
                "protected"
            } else {
                "active_or_unknown"
            };
            return Ok(runtime_scheduler::IdleReleaseResult {
                instance,
                released: false,
                reason: reason.into(),
            });
        }
        let keep_vm_warm_preference = scheduler.policy().keep_vm_warm;
        drop(scheduler);
        let keep_vm_warm = if keep_vm_warm_preference {
            let snapshot =
                resource_monitor::read_runtime_resource_snapshot(None, None).unwrap_or_default();
            keep_vm_warm_for_pressure(
                true,
                resource_monitor::classify_memory_pressure(snapshot.host_available_bytes),
            )
        } else {
            false
        };
        let result = crate::services::qemu::redroid_stop(&vm, &instance);
        match result {
            Ok(output) if output.success => {
                let should_stop_vm = if keep_vm_warm {
                    false
                } else {
                    let remaining = crate::services::qemu::redroid_list_basic(&vm).ok();
                    should_stop_vm_after_idle_release(false, remaining.as_deref(), &instance)
                };
                if should_stop_vm {
                    let vm_result = crate::services::qemu::vm_stop(&vm);
                    if let Ok(vm_output) = &vm_result {
                        if !vm_output.success {
                            return Ok(runtime_scheduler::IdleReleaseResult {
                                instance,
                                released: false,
                                reason: format!("node_stop_failed: {}", vm_output.stderr.trim()),
                            });
                        }
                    } else if let Err(error) = vm_result {
                        return Ok(runtime_scheduler::IdleReleaseResult {
                            instance,
                            released: false,
                            reason: format!("node_stop_failed: {error}"),
                        });
                    }
                }
                RUNTIME_SCHEDULER.lock().clear_instance(&instance);
                Ok(runtime_scheduler::IdleReleaseResult {
                    instance,
                    released: true,
                    reason: "idle".into(),
                })
            }
            Ok(output) => Ok(runtime_scheduler::IdleReleaseResult {
                instance,
                released: false,
                reason: format!("stop_failed: {}", output.stderr.trim()),
            }),
            Err(error) => Ok(runtime_scheduler::IdleReleaseResult {
                instance,
                released: false,
                reason: format!("stop_failed: {error}"),
            }),
        }
    })
    .await
}

/// Manually hibernate one validated application while keeping its redroid
/// container and QEMU VM warm. The mapping and idle checks happen before any
/// ADB command; failures are returned as a structured non-release result.
#[tauri::command]
pub async fn runtime_hibernate_app(
    vm: String,
    instance: String,
    serial: String,
    package: String,
) -> Result<runtime_scheduler::AppHibernateResult, String> {
    blocking_res(move || {
        let package = package.trim().to_string();
        let result = |released: bool, reason: String| runtime_scheduler::AppHibernateResult {
            scope: "app".into(),
            instance: instance.clone(),
            serial: serial.clone(),
            package: package.clone(),
            released,
            reason,
        };

        if !runtime_scheduler::is_valid_android_package(&package) {
            return Ok(result(false, "invalid_package".into()));
        }

        {
            let now = SystemTime::now();
            let mut scheduler = RUNTIME_SCHEDULER.lock();
            scheduler.update_policy(runtime_policy());
            if !scheduler.is_reclaimable(&instance, now) {
                let protected = scheduler
                    .policy()
                    .protected_instance_ids
                    .iter()
                    .any(|id| id == &instance);
                return Ok(result(
                    false,
                    if protected {
                        "protected".into()
                    } else {
                        "active_or_unknown".into()
                    },
                ));
            }
        }

        let mappings = match crate::services::qemu::adb_list() {
            Ok(rows) => rows,
            Err(error) => return Ok(result(false, format!("mapping_unavailable: {error}"))),
        };
        if !crate::services::qemu::qemu_mapping_matches(&mappings, &vm, &instance, &serial) {
            return Ok(result(false, "qemu_mapping_mismatch".into()));
        }

        let stopped = device::stop_app(&serial, &package);
        if stopped.success {
            let reclaimed =
                run_guest_reclaim_after_app_hibernate(true, || try_auto_reclaim_guest_memory(&vm));
            Ok(result(
                true,
                if reclaimed {
                    "idle_app_reclaimed"
                } else {
                    "idle_app"
                }
                .into(),
            ))
        } else {
            Ok(result(
                false,
                format!(
                    "stop_failed: {}",
                    stopped
                        .stderr
                        .trim()
                        .is_empty()
                        .then_some(stopped.stdout.trim())
                        .unwrap_or(stopped.stderr.trim())
                ),
            ))
        }
    })
    .await
}

// ---- Devices ----

#[tauri::command]
pub async fn list_devices() -> Vec<DeviceInfo> {
    blocking(device::list_devices).await
}

/// Unified device list: Docker track (containers + physical/LAN adb) plus the
/// QEMU track's redroid instances (`source: "qemu"`, tagged with vm/instance).
/// QEMU rows carry `id == adb serial`, so every existing serial-keyed command
/// (scrcpy / files / apps / control / shell) works on them unchanged — the adb
/// channel is the same.
#[tauri::command]
pub async fn list_devices_unified() -> Vec<crate::services::unified::UnifiedDevice> {
    blocking(crate::services::unified::list_devices_unified).await
}

#[tauri::command]
pub async fn get_device(id: String) -> Option<crate::services::unified::UnifiedDevice> {
    blocking_opt(move || crate::services::unified::get_device_unified(&id)).await
}

#[tauri::command]
pub async fn get_device_telemetry(serial: String) -> DeviceTelemetry {
    blocking(move || device::telemetry(&serial)).await
}

#[tauri::command]
pub async fn connect_device(serial: String) -> ShellResult {
    blocking(move || device::connect_device(&serial)).await
}

#[tauri::command]
pub async fn disconnect_device(serial: String) -> ShellResult {
    blocking(move || device::disconnect_device(&serial)).await
}

#[tauri::command]
pub async fn restart_device(id: String) -> ShellResult {
    blocking(move || device::restart_device(&id)).await
}

#[tauri::command]
pub async fn stop_device(id: String) -> ShellResult {
    blocking(move || device::stop_device(&id)).await
}

// ---- Control ----

#[tauri::command]
pub async fn device_tap(serial: String, x: i32, y: i32) -> ShellResult {
    blocking(move || device::tap(&serial, x, y)).await
}

#[tauri::command]
pub async fn device_swipe(
    serial: String,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration: u32,
) -> ShellResult {
    blocking(move || device::swipe(&serial, x1, y1, x2, y2, duration)).await
}

#[tauri::command]
pub async fn device_long_press(serial: String, x: i32, y: i32, duration: u32) -> ShellResult {
    blocking(move || device::long_press(&serial, x, y, duration)).await
}

#[tauri::command]
pub async fn device_text(serial: String, text: String) -> ShellResult {
    blocking(move || device::text(&serial, &text)).await
}

#[tauri::command]
pub async fn device_keyevent(serial: String, code: i32) -> ShellResult {
    blocking(move || device::keyevent(&serial, code)).await
}

#[tauri::command]
pub async fn device_home(serial: String) -> ShellResult {
    blocking(move || device::home(&serial)).await
}

#[tauri::command]
pub async fn device_back(serial: String) -> ShellResult {
    blocking(move || device::back(&serial)).await
}

#[tauri::command]
pub async fn device_recent(serial: String) -> ShellResult {
    blocking(move || device::recent(&serial)).await
}

#[tauri::command]
pub async fn device_power(serial: String) -> ShellResult {
    blocking(move || device::power(&serial)).await
}

#[tauri::command]
pub async fn device_volume_up(serial: String) -> ShellResult {
    blocking(move || device::volume_up(&serial)).await
}

#[tauri::command]
pub async fn device_volume_down(serial: String) -> ShellResult {
    blocking(move || device::volume_down(&serial)).await
}

#[tauri::command]
pub async fn device_lock(serial: String) -> ShellResult {
    blocking(move || device::lock(&serial)).await
}

#[tauri::command]
pub async fn device_wake(serial: String) -> ShellResult {
    blocking(move || device::wake(&serial)).await
}

#[tauri::command]
pub async fn device_rotate(serial: String, landscape: bool) -> ShellResult {
    blocking(move || device::rotate(&serial, landscape)).await
}

#[tauri::command]
pub async fn device_set_rotation_mode(serial: String, mode: String) -> ShellResult {
    blocking(move || device::set_rotation_mode(&serial, &mode)).await
}

#[tauri::command]
pub async fn device_volume_mute(serial: String) -> ShellResult {
    blocking(move || device::volume_mute(&serial)).await
}

#[tauri::command]
pub async fn device_screen_off(serial: String) -> ShellResult {
    blocking(move || device::screen_off(&serial)).await
}

#[tauri::command]
pub async fn device_reboot(serial: String) -> ShellResult {
    blocking(move || device::reboot(&serial)).await
}

#[tauri::command]
pub async fn device_shutdown(serial: String) -> ShellResult {
    blocking(move || device::shutdown(&serial)).await
}

#[tauri::command]
pub async fn device_open_notifications(serial: String) -> ShellResult {
    blocking(move || device::open_notifications(&serial)).await
}

#[tauri::command]
pub async fn device_open_settings(serial: String) -> ShellResult {
    blocking(move || device::open_settings(&serial)).await
}

#[tauri::command]
pub async fn device_send_clipboard(serial: String, content: String) -> ShellResult {
    blocking(move || device::send_clipboard(&serial, &content)).await
}

#[tauri::command]
pub async fn device_read_clipboard(serial: String) -> ShellResult {
    blocking(move || device::read_clipboard(&serial)).await
}

#[tauri::command]
pub async fn device_shell(serial: String, command: String) -> ShellResult {
    blocking(move || device::shell_command(&serial, &command)).await
}

#[tauri::command]
pub async fn terminal_start(kind: String, serial: String) -> TerminalSession {
    blocking(move || terminal::start(&kind, &serial)).await
}

#[tauri::command]
pub async fn terminal_write(id: String, input: String) -> ShellResult {
    blocking(move || terminal::write(&id, &input)).await
}

#[tauri::command]
pub async fn terminal_read(id: String) -> TerminalSession {
    blocking(move || terminal::read(&id)).await
}

#[tauri::command]
pub async fn terminal_resize(id: String, cols: u16, rows: u16) -> ShellResult {
    blocking(move || terminal::resize(&id, cols, rows)).await
}

#[tauri::command]
pub async fn terminal_stop(id: String) -> ShellResult {
    blocking(move || terminal::stop(&id)).await
}

// ---- Persistent terminal sessions ----

#[tauri::command]
pub async fn terminal_session_start(
    app: AppHandle,
    state: tauri::State<'_, terminal_session::TerminalRegistry>,
    request: terminal_session::TerminalStartRequest,
) -> Result<terminal_session::TerminalSessionInfo, String> {
    let registry = state.inner().clone();
    blocking_res(move || terminal_session::start(app, registry, request)).await
}

#[tauri::command]
pub async fn terminal_session_write(
    state: tauri::State<'_, terminal_session::TerminalRegistry>,
    id: String,
    data: String,
) -> Result<terminal_session::TerminalCommandResult, String> {
    Ok(terminal_session::write(state.inner(), &id, &data))
}

#[tauri::command]
pub async fn terminal_session_stop(
    state: tauri::State<'_, terminal_session::TerminalRegistry>,
    id: String,
) -> Result<terminal_session::TerminalCommandResult, String> {
    Ok(terminal_session::stop(state.inner(), &id))
}

#[tauri::command]
pub async fn terminal_session_list(
    state: tauri::State<'_, terminal_session::TerminalRegistry>,
) -> Result<Vec<terminal_session::TerminalSessionInfo>, String> {
    Ok(terminal_session::list(state.inner()))
}

// ---- APK / Apps ----

#[tauri::command]
pub async fn install_apk(serial: String, path: String, replace: bool) -> ShellResult {
    blocking(move || device::install_apk(&serial, &path, replace)).await
}

#[tauri::command]
pub async fn uninstall_app(serial: String, package: String) -> ShellResult {
    blocking(move || device::uninstall_app(&serial, &package)).await
}

#[tauri::command]
pub async fn start_app(serial: String, package: String) -> ShellResult {
    blocking(move || device::start_app(&serial, &package)).await
}

#[tauri::command]
pub async fn start_app_on_display(serial: String, package: String, display_id: i32) -> ShellResult {
    blocking(move || device::start_app_on_display(&serial, &package, display_id)).await
}

#[tauri::command]
pub async fn start_app_activity(serial: String, package: String, activity: String) -> ShellResult {
    blocking(move || device::start_app_activity(&serial, &package, &activity)).await
}

#[tauri::command]
pub async fn stop_app(serial: String, package: String) -> ShellResult {
    blocking(move || device::stop_app(&serial, &package)).await
}

#[tauri::command]
pub async fn create_app_shortcut(serial: String, package: String) -> Result<String, String> {
    blocking_res(move || crate::services::launch::create_app_shortcut(&serial, &package)).await
}

#[tauri::command]
pub async fn clear_app_data(serial: String, package: String) -> ShellResult {
    blocking(move || device::clear_cache(&serial, &package)).await
}

#[tauri::command]
pub async fn list_apps(serial: String, include_system: bool) -> Vec<AppInfo> {
    blocking(move || device::list_apps(&serial, include_system)).await
}

#[tauri::command]
pub async fn list_apps_result(
    serial: String,
    include_system: bool,
) -> Result<Vec<AppInfo>, String> {
    blocking_res(move || device::list_apps_result(&serial, include_system)).await
}

#[tauri::command]
pub async fn get_app_icon(serial: String, package: String) -> Result<String, String> {
    blocking_res(move || device::app_icon_result(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_detail(serial: String, package: String) -> AppInfo {
    blocking(move || device::app_detail(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_permissions(serial: String, package: String) -> String {
    blocking(move || device::app_permissions(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_activities(serial: String, package: String) -> String {
    blocking(move || device::app_activities(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_detail_result(serial: String, package: String) -> Result<AppInfo, String> {
    blocking_res(move || device::app_detail_result(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_permissions_result(serial: String, package: String) -> Result<String, String> {
    blocking_res(move || device::app_permissions_result(&serial, &package)).await
}

#[tauri::command]
pub async fn get_app_activities_result(serial: String, package: String) -> Result<String, String> {
    blocking_res(move || device::app_activities_result(&serial, &package)).await
}

// ---- Files ----

#[tauri::command]
pub async fn list_files(serial: String, path: String) -> Vec<FileEntry> {
    blocking(move || device::list_files(&serial, &path)).await
}

#[tauri::command]
pub async fn list_files_result(serial: String, path: String) -> Result<Vec<FileEntry>, String> {
    blocking_res(move || device::list_files_result(&serial, &path)).await
}

#[tauri::command]
pub async fn upload_file(serial: String, local: String, remote: String) -> ShellResult {
    blocking(move || device::upload_file(&serial, &local, &remote)).await
}

#[tauri::command]
pub async fn upload_file_tracked(
    app: AppHandle,
    serial: String,
    local: String,
    remote: String,
    operation_id: String,
) -> ShellResult {
    blocking(move || {
        transfer::upload_tracked(&serial, &local, &remote, &operation_id, move |progress| {
            let _ = app.emit("file-transfer-progress", progress);
        })
    })
    .await
}

#[tauri::command]
pub async fn download_file(serial: String, remote: String, local: String) -> ShellResult {
    blocking(move || device::download_file(&serial, &remote, &local)).await
}

#[tauri::command]
pub async fn download_file_tracked(
    app: AppHandle,
    serial: String,
    remote: String,
    local: String,
    operation_id: String,
) -> ShellResult {
    blocking(move || {
        transfer::download_tracked(&serial, &remote, &local, &operation_id, move |progress| {
            let _ = app.emit("file-transfer-progress", progress);
        })
    })
    .await
}

#[tauri::command]
pub async fn cancel_file_transfer(operation_id: String) -> bool {
    blocking(move || transfer::cancel_transfer(&operation_id)).await
}

#[tauri::command]
pub async fn delete_file(serial: String, path: String) -> ShellResult {
    blocking(move || device::delete_file(&serial, &path)).await
}

#[tauri::command]
pub async fn mkdir_remote(serial: String, path: String) -> ShellResult {
    blocking(move || device::mkdir(&serial, &path)).await
}

#[tauri::command]
pub async fn move_remote_file(serial: String, source: String, target: String) -> ShellResult {
    blocking(move || transfer::move_path(&serial, &source, &target)).await
}

#[tauri::command]
pub async fn copy_remote_file(serial: String, source: String, target: String) -> ShellResult {
    blocking(move || transfer::copy_path(&serial, &source, &target)).await
}

#[tauri::command]
pub async fn delete_remote_path(serial: String, path: String) -> ShellResult {
    blocking(move || transfer::delete_path(&serial, &path)).await
}

#[tauri::command]
pub async fn read_remote_file(serial: String, path: String) -> ShellResult {
    blocking(move || transfer::read_path(&serial, &path)).await
}

#[tauri::command]
pub async fn write_remote_file(serial: String, path: String, content: String) -> ShellResult {
    blocking(move || transfer::write_path(&serial, &path, &content)).await
}

#[tauri::command]
pub async fn storage_info(serial: String) -> String {
    blocking(move || device::storage_info(&serial)).await
}

// ---- Screenshot ----

#[tauri::command]
pub async fn take_screenshot(serial: String) -> ScreenshotResult {
    blocking(move || device::screenshot(&serial)).await
}

// ---- Logcat ----

#[tauri::command]
pub async fn get_logcat(serial: String, lines: u32, clear: bool) -> String {
    blocking(move || device::device_logcat(&serial, lines, clear)).await
}

// ---- Device settings ----

#[tauri::command]
pub async fn set_device_resolution(serial: String, resolution: String) -> ShellResult {
    blocking(move || device::set_resolution(&serial, &resolution)).await
}

#[tauri::command]
pub async fn set_device_dpi(serial: String, dpi: String) -> ShellResult {
    blocking(move || device::set_dpi(&serial, &dpi)).await
}

#[tauri::command]
pub async fn set_device_language(serial: String, lang: String) -> ShellResult {
    blocking(move || device::set_language(&serial, &lang)).await
}

// ---- Docker ----

#[tauri::command]
pub async fn get_docker_info() -> DockerInfo {
    blocking(docker::info).await
}

#[tauri::command]
pub async fn refresh_docker_info() -> DockerInfo {
    blocking(docker::info_fresh).await
}

#[tauri::command]
pub async fn create_redroid_instance(req: CreateInstanceRequest) -> ShellResult {
    blocking(move || docker::create_redroid(&req)).await
}

#[tauri::command]
pub async fn cancel_create_instance(name: String) -> ShellResult {
    blocking(move || docker::cancel_create(&name)).await
}

#[tauri::command]
pub async fn get_create_stage() -> String {
    blocking(docker::create_stage).await
}

#[tauri::command]
pub async fn next_free_adb_port() -> u16 {
    blocking(docker::next_free_adb_port).await
}

#[tauri::command]
pub async fn check_instance_name(name: String) -> bool {
    blocking(move || docker::container_name_taken(&name)).await
}

#[tauri::command]
pub async fn check_adb_port(port: u16) -> bool {
    blocking(move || docker::adb_port_taken(port)).await
}

#[tauri::command]
pub async fn start_docker_desktop() -> bool {
    blocking(docker::start_docker_desktop).await
}

#[tauri::command]
pub async fn get_local_gapps_path() -> String {
    blocking(docker::local_gapps_path).await
}

// ---- Root / Magisk preset (red team preset) ----

#[tauri::command]
pub async fn get_magisk_assets() -> MagiskAssets {
    blocking(docker::magisk_assets).await
}

#[tauri::command]
pub async fn get_root_status(serial: String) -> RootStatus {
    blocking(move || root::root_status(&serial)).await
}

#[tauri::command]
pub async fn magisk_denylist_add(serial: String, package: String) -> ShellResult {
    blocking(move || root::denylist_add(&serial, &package)).await
}

#[tauri::command]
pub async fn magisk_denylist_remove(serial: String, package: String) -> ShellResult {
    blocking(move || root::denylist_remove(&serial, &package)).await
}

#[tauri::command]
pub async fn magisk_apply_spoof(serial: String) -> ShellResult {
    blocking(move || root::apply_spoof(&serial)).await
}

#[tauri::command]
pub async fn list_spoof_profiles() -> Vec<crate::models::SpoofProfileSummary> {
    blocking(spoof::list_summaries).await
}

#[tauri::command]
pub async fn get_spoof_identity(serial: String) -> crate::models::SpoofIdentity {
    blocking(move || spoof::get_spoof_identity(&serial)).await
}

#[tauri::command]
pub async fn apply_spoof_profile(serial: String, profile_id: String) -> ShellResult {
    blocking(move || spoof::apply_spoof_profile(&serial, &profile_id)).await
}

#[tauri::command]
pub async fn capture_spoof_profile(
    serial: String,
    id_hint: String,
) -> Result<crate::models::SpoofProfileSummary, String> {
    blocking_res(move || spoof::capture_spoof_profile(&serial, &id_hint)).await
}

#[tauri::command]
pub async fn delete_custom_profile(id: String) -> Result<(), String> {
    blocking_res(move || spoof::delete_custom_profile(&id)).await
}

#[tauri::command]
pub async fn install_cloak_module(serial: String) -> ShellResult {
    blocking(move || cloak::install_cloak_module(&serial)).await
}

#[tauri::command]
pub async fn push_cloak_config(serial: String, profile_id: String) -> ShellResult {
    blocking(move || {
        let id = profile_id.trim();
        match spoof::profile_by_id(id) {
            Some(profile) => cloak::push_cloak_config(&serial, &profile),
            None => ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("伪装档案 id 无效: {id}"),
                exit_code: -1,
            },
        }
    })
    .await
}

#[tauri::command]
pub async fn get_cloak_status(serial: String) -> crate::models::CloakStatus {
    blocking(move || cloak::get_cloak_status(&serial)).await
}

#[tauri::command]
pub async fn install_native_cloak(serial: String, zip_path: Option<String>) -> ShellResult {
    blocking(move || cloak::install_native_cloak(&serial, zip_path)).await
}

// ---- Usage baseline seeding ----

#[tauri::command]
pub async fn seed_usage_baseline(serial: String, profile_id: String) -> ShellResult {
    blocking(move || {
        let id = profile_id.trim();
        match spoof::profile_by_id(id) {
            Some(profile) => usage::seed_usage_baseline(&serial, &profile),
            None => ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("伪装档案 id 无效: {id}"),
                exit_code: -1,
            },
        }
    })
    .await
}

// ---- Geographic consistency ----

#[tauri::command]
pub async fn geo_consistency_check(serial: String, profile_id: String) -> crate::models::GeoCheck {
    blocking(move || geo::geo_consistency_check(&serial, &profile_id)).await
}

// ---- Battery spoofing curve ----

#[tauri::command]
pub async fn get_battery_state(serial: String) -> crate::models::BatteryState {
    blocking(move || battery::battery_state_for(&serial, battery::now_secs())).await
}

#[tauri::command]
pub async fn apply_battery_policy(serial: String) -> ShellResult {
    blocking(move || battery::apply_battery_policy(&serial)).await
}

// ---- Adversarial self-audit ----

#[tauri::command]
pub async fn adversarial_audit(
    serial: String,
    profile_id: Option<String>,
) -> crate::models::AdversarialAudit {
    blocking(move || audit::adversarial_audit(&serial, profile_id)).await
}

// ---- Per-instance proxy egress ----

#[tauri::command]
pub async fn apply_device_proxy(serial: String, proxy: String) -> ShellResult {
    blocking(move || proxy::apply_device_proxy(&serial, &proxy)).await
}

#[tauri::command]
pub async fn clear_device_proxy(serial: String) -> ShellResult {
    blocking(move || proxy::clear_device_proxy(&serial)).await
}

#[tauri::command]
pub async fn get_device_proxy_status(serial: String) -> crate::models::DeviceProxyStatus {
    blocking(move || proxy::device_proxy_status(&serial)).await
}

#[tauri::command]
pub async fn apply_transparent_proxy(serial: String, proxy: String) -> ShellResult {
    blocking(move || proxy::apply_transparent_proxy(&serial, &proxy)).await
}

#[tauri::command]
pub async fn stop_transparent_proxy(serial: String) -> ShellResult {
    blocking(move || proxy::stop_transparent_proxy(&serial)).await
}

// ---- Spoof-profile diversity ----

#[tauri::command]
pub async fn spoof_profile_usage() -> Vec<crate::models::SpoofProfileUsage> {
    blocking(spoof::spoof_profile_usage).await
}

#[tauri::command]
pub async fn magisk_set_shamiko_mode(serial: String, whitelist: bool) -> ShellResult {
    blocking(move || root::set_shamiko_mode(&serial, whitelist)).await
}

#[tauri::command]
pub async fn magisk_module_set_enabled(serial: String, id: String, enabled: bool) -> ShellResult {
    blocking(move || root::module_set_enabled(&serial, &id, enabled)).await
}

#[tauri::command]
pub async fn magisk_module_remove(serial: String, id: String) -> ShellResult {
    blocking(move || root::module_remove(&serial, &id)).await
}

#[tauri::command]
pub async fn magisk_repair_managers(serial: String) -> ShellResult {
    blocking(move || root::repair_managers(&serial)).await
}

#[tauri::command]
pub async fn get_lsposed_scope(serial: String) -> LsposedScopeReport {
    blocking(move || root::lsposed_scope(&serial)).await
}

#[tauri::command]
pub async fn get_su_policies(serial: String) -> Vec<SuPolicyEntry> {
    blocking(move || root::su_policies(&serial)).await
}

#[tauri::command]
pub async fn magisk_set_su_policy(serial: String, uid: i64, allow: bool) -> ShellResult {
    blocking(move || root::set_su_policy(&serial, uid, allow)).await
}

#[tauri::command]
pub async fn magisk_remove_su_policy(serial: String, uid: i64) -> ShellResult {
    blocking(move || root::remove_su_policy(&serial, uid)).await
}

#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    blocking(move || {
        let p = path.trim();
        !p.is_empty() && std::path::Path::new(p).exists()
    })
    .await
}

#[tauri::command]
pub async fn start_container(id: String) -> ShellResult {
    blocking(move || docker::start_container(&id)).await
}

#[tauri::command]
pub async fn stop_container(id: String) -> ShellResult {
    blocking(move || docker::stop_container(&id)).await
}

#[tauri::command]
pub async fn restart_container(id: String) -> ShellResult {
    blocking(move || docker::restart_container(&id)).await
}

#[tauri::command]
pub async fn remove_container(id: String, force: bool) -> ShellResult {
    blocking(move || docker::remove_container(&id, force)).await
}

#[tauri::command]
pub async fn rename_container(id: String, new_name: String) -> ShellResult {
    blocking(move || docker::rename_container(&id, &new_name)).await
}

#[tauri::command]
pub async fn clone_container(id: String, new_name: String) -> ShellResult {
    blocking(move || docker::clone_container(&id, &new_name)).await
}

#[tauri::command]
pub async fn inspect_container(id: String) -> ShellResult {
    blocking(move || docker::inspect(&id)).await
}

#[tauri::command]
pub async fn get_container_logs(id: String, tail: u32) -> ShellResult {
    blocking(move || docker::container_logs(&id, tail)).await
}

#[tauri::command]
pub async fn export_container_config(id: String, path: String) -> Result<String, String> {
    blocking_res(move || docker::export_config(&id, &path)).await
}

#[tauri::command]
pub async fn list_volumes() -> Vec<DockerVolume> {
    blocking(docker::list_volumes).await
}

#[tauri::command]
pub async fn remove_volume(name: String, force: bool) -> ShellResult {
    blocking(move || docker::remove_volume(&name, force)).await
}

#[tauri::command]
pub async fn remove_image(id: String, force: bool) -> ShellResult {
    blocking(move || docker::remove_image(&id, force)).await
}

#[tauri::command]
pub async fn prune_dangling_images() -> ShellResult {
    blocking(docker::prune_dangling_images).await
}

// ---- ADB ----

#[tauri::command]
pub async fn get_adb_info() -> AdbInfo {
    blocking(adb::info).await
}

#[tauri::command]
pub async fn adb_start_server() -> ShellResult {
    blocking(adb::start_server).await
}

#[tauri::command]
pub async fn adb_kill_server() -> ShellResult {
    blocking(adb::kill_server).await
}

#[tauri::command]
pub async fn adb_restart_server() -> ShellResult {
    blocking(adb::restart_server).await
}

#[tauri::command]
pub async fn adb_connect(address: String) -> ShellResult {
    blocking(move || adb::connect(&address)).await
}

#[tauri::command]
pub async fn adb_disconnect(address: String) -> ShellResult {
    blocking(move || adb::disconnect(&address)).await
}

#[tauri::command]
pub async fn adb_reconnect(serial: String) -> ShellResult {
    blocking(move || adb::reconnect(&serial)).await
}

#[tauri::command]
pub async fn adb_auto_fix() -> ShellResult {
    blocking(adb::auto_fix).await
}

// ---- LAN scan (ADB over TCP discovery) ----

#[tauri::command]
pub async fn adb_local_subnet() -> String {
    blocking(move || adb::local_subnet().unwrap_or_default()).await
}

#[tauri::command]
pub async fn adb_lan_scan(subnet: String, port: u16, auto_connect: bool) -> LanScanResult {
    blocking(move || adb::lan_scan(&subnet, port, auto_connect)).await
}

#[tauri::command]
pub async fn adb_pair(address: String, code: String) -> ShellResult {
    blocking(move || wireless::pair(&address, &code)).await
}

#[tauri::command]
pub async fn adb_discover() -> WirelessDiscovery {
    blocking(wireless::discover).await
}

#[tauri::command]
pub async fn adb_tcpip(serial: String, port: u16) -> ShellResult {
    blocking(move || wireless::tcpip(&serial, port)).await
}

// ---- Scrcpy ----

#[tauri::command]
pub async fn scrcpy_start(
    serial: String,
    max_size: u32,
    bit_rate: u32,
    extra: Option<String>,
) -> ShellResult {
    blocking(move || scrcpy::start(&serial, max_size, bit_rate, extra.as_deref().unwrap_or("")))
        .await
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScrcpyWindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn scrcpy_start_layout(
    serial: String,
    max_size: u32,
    bit_rate: u32,
    extra: Option<String>,
    placement: ScrcpyWindowPlacement,
) -> ShellResult {
    blocking(move || {
        if placement.width == 0 || placement.height == 0 {
            return ShellResult {
                success: false,
                stderr: "窗口宽高必须大于 0".into(),
                exit_code: -1,
                ..ShellResult::default()
            };
        }
        let mut args = extra.unwrap_or_default();
        args.push_str(&format!(
            " --window-x {} --window-y {} --window-width {} --window-height {}",
            placement.x,
            placement.y,
            placement.width.min(3840),
            placement.height.min(2160),
        ));
        scrcpy::start(&serial, max_size, bit_rate, &args)
    })
    .await
}

#[tauri::command]
pub async fn scrcpy_stop(serial: String) -> ShellResult {
    blocking(move || scrcpy::stop(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_restart(serial: String) -> ShellResult {
    blocking(move || scrcpy::restart(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_status(serial: String) -> String {
    blocking(move || scrcpy::status(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_stream_start(
    serial: String,
    max_size: u32,
    bit_rate: u32,
    extra: Option<String>,
) -> StreamSession {
    blocking(move || {
        crate::services::stream::start(&serial, max_size, bit_rate, extra.as_deref().unwrap_or(""))
    })
    .await
}

#[tauri::command]
pub async fn scrcpy_stream_stop(serial: String) -> ShellResult {
    blocking(move || crate::services::stream::stop(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_stream_status(serial: String) -> StreamSession {
    blocking(move || crate::services::stream::status(&serial)).await
}

// ---- Recording / camera / OTG ----

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ScrcpyRecordingOptions {
    output_path: String,
    format: String,
    audio: bool,
    audio_only: bool,
    audio_source: String,
    video_source: String,
    time_limit_secs: u32,
    camera_id: String,
    camera_size: String,
    camera_ar: String,
    camera_fps: u32,
    camera_facing: String,
    camera_torch: bool,
    camera_zoom: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ScrcpyCameraOptions {
    camera_id: String,
    camera_size: String,
    camera_ar: String,
    camera_fps: u32,
    camera_facing: String,
    camera_torch: bool,
    camera_zoom: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ScrcpyInputOptions {
    keyboard: bool,
    mouse: bool,
    gamepad: bool,
}

fn recording_shell_result(session: RecordingSession) -> ShellResult {
    if session.status == "running" {
        ShellResult {
            success: true,
            stdout: if session.output_path.is_empty() {
                session.message
            } else {
                session.output_path
            },
            ..ShellResult::default()
        }
    } else {
        ShellResult {
            success: false,
            stderr: session.message,
            exit_code: -1,
            ..ShellResult::default()
        }
    }
}

#[tauri::command]
pub async fn scrcpy_start_recording(serial: String, options: serde_json::Value) -> ShellResult {
    blocking(move || {
        let Ok(options) = serde_json::from_value::<ScrcpyRecordingOptions>(options) else {
            return ShellResult {
                success: false,
                stderr: "录制参数格式无效".into(),
                exit_code: -1,
                ..ShellResult::default()
            };
        };
        let mode = if options.audio_only {
            "audio"
        } else if options.video_source == "camera" {
            if options.audio {
                "camera-record-av"
            } else {
                "camera-record"
            }
        } else if options.audio {
            "av"
        } else {
            "video"
        };
        let _ = options.audio_source;
        recording_shell_result(recording::start(
            &serial,
            mode,
            &options.output_path,
            &options.camera_facing,
            &options.camera_id,
            &options.camera_ar,
            false,
            &options.camera_size,
            options.camera_fps,
            options.time_limit_secs,
            &options.format,
            "",
            options.camera_torch,
            options.camera_zoom,
            "",
        ))
    })
    .await
}

#[tauri::command]
pub async fn scrcpy_stop_recording(serial: String) -> ShellResult {
    blocking(move || recording::stop(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_recording_status(serial: String) -> String {
    blocking(move || recording::status(&serial).status).await
}

#[tauri::command]
pub async fn scrcpy_start_camera(serial: String, options: serde_json::Value) -> ShellResult {
    blocking(move || {
        let Ok(options) = serde_json::from_value::<ScrcpyCameraOptions>(options) else {
            return ShellResult {
                success: false,
                stderr: "摄像头参数格式无效".into(),
                exit_code: -1,
                ..ShellResult::default()
            };
        };
        recording_shell_result(recording::start(
            &serial,
            "camera",
            "",
            &options.camera_facing,
            &options.camera_id,
            &options.camera_ar,
            false,
            &options.camera_size,
            options.camera_fps,
            0,
            "",
            "",
            options.camera_torch,
            options.camera_zoom,
            "",
        ))
    })
    .await
}

#[tauri::command]
pub async fn scrcpy_stop_camera(serial: String) -> ShellResult {
    blocking(move || recording::stop(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_camera_status(serial: String) -> String {
    blocking(move || recording::status(&serial).status).await
}

#[tauri::command]
pub async fn scrcpy_start_input(
    serial: String,
    mode: String,
    options: serde_json::Value,
) -> ShellResult {
    blocking(move || {
        let Ok(options) = serde_json::from_value::<ScrcpyInputOptions>(options) else {
            return ShellResult {
                success: false,
                stderr: "输入参数格式无效".into(),
                exit_code: -1,
                ..ShellResult::default()
            };
        };
        recording_shell_result(recording::start_input(
            &serial,
            &mode,
            options.keyboard,
            options.mouse,
            options.gamepad,
        ))
    })
    .await
}

#[tauri::command]
pub async fn scrcpy_stop_input(serial: String) -> ShellResult {
    blocking(move || recording::stop(&serial)).await
}

#[tauri::command]
pub async fn scrcpy_input_status(serial: String) -> String {
    blocking(move || recording::status(&serial).status).await
}

#[tauri::command]
pub async fn recording_start(
    serial: String,
    mode: String,
    output_path: String,
    camera_facing: String,
    camera_id: String,
    camera_ar: String,
    camera_high_speed: bool,
    camera_size: String,
    camera_fps: u32,
    time_limit: u32,
    record_format: String,
    record_orientation: String,
    camera_torch: bool,
    camera_zoom: Option<f64>,
    gamepad: String,
) -> RecordingSession {
    blocking(move || {
        recording::start(
            &serial,
            &mode,
            &output_path,
            &camera_facing,
            &camera_id,
            &camera_ar,
            camera_high_speed,
            &camera_size,
            camera_fps,
            time_limit,
            &record_format,
            &record_orientation,
            camera_torch,
            camera_zoom,
            &gamepad,
        )
    })
    .await
}

#[tauri::command]
pub async fn recording_stop(serial: String) -> ShellResult {
    blocking(move || recording::stop(&serial)).await
}

#[tauri::command]
pub async fn recording_status(serial: String) -> RecordingSession {
    blocking(move || recording::status(&serial)).await
}

// ---- Gnirehtet reverse tethering ----

#[tauri::command]
pub async fn gnirehtet_install(serial: String) -> ShellResult {
    blocking(move || gnirehtet::install(&serial)).await
}

#[tauri::command]
pub async fn gnirehtet_start(
    serial: String,
    dns: String,
    relay_port: u16,
    routes: String,
) -> GnirehtetSession {
    blocking(move || gnirehtet::start(&serial, &dns, relay_port, &routes)).await
}

#[tauri::command]
pub async fn gnirehtet_stop(serial: String) -> ShellResult {
    blocking(move || gnirehtet::stop(&serial)).await
}

#[tauri::command]
pub async fn gnirehtet_status(serial: String) -> GnirehtetSession {
    blocking(move || gnirehtet::status(&serial)).await
}

#[tauri::command]
pub async fn gnirehtet_repair(
    serial: String,
    dns: String,
    relay_port: u16,
    routes: String,
) -> GnirehtetSession {
    blocking(move || gnirehtet::repair(&serial, &dns, relay_port, &routes)).await
}

// ---- System logs ----

#[tauri::command]
pub async fn get_system_logs(
    source: Option<String>,
    level: Option<String>,
    keyword: Option<String>,
    limit: Option<usize>,
) -> Vec<LogEntry> {
    blocking(move || {
        log::list(
            source.as_deref(),
            level.as_deref(),
            keyword.as_deref(),
            limit.unwrap_or(200),
        )
    })
    .await
}

#[tauri::command]
pub async fn clear_system_logs(also_today_file: Option<bool>) {
    blocking(move || log::clear(also_today_file.unwrap_or(false))).await
}

#[tauri::command]
pub async fn export_system_logs(path: String, content: Option<String>) -> Result<String, String> {
    blocking_res(move || log::export(&path, content.as_deref())).await
}

#[tauri::command]
pub async fn append_log(level: String, source: String, message: String) {
    blocking(move || log::append(&level, &source, &message)).await
}

// ---- Settings ----

#[tauri::command]
pub async fn get_settings() -> AppSettings {
    blocking(settings::get).await
}

#[tauri::command]
pub async fn update_settings(settings: AppSettings) -> Result<AppSettings, String> {
    blocking_res(move || settings::update(settings)).await
}

#[tauri::command]
pub async fn read_config_file(path: String) -> Result<String, String> {
    blocking_res(move || config::read(&path)).await
}

// ---- Device tags (settings-backed grouping) ----

/// Full deviceId|serial → [tag, …] record as stored in settings.json.
#[tauri::command]
pub async fn get_device_tags() -> std::collections::BTreeMap<String, Vec<String>> {
    blocking(crate::services::device_tags::get_tags).await
}

/// Replace one device's tags. An empty list clears the record ("ungrouped").
#[tauri::command]
pub async fn set_device_tags(
    device_id: String,
    tags: Vec<String>,
) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    blocking_res(move || crate::services::device_tags::set_tags(&device_id, tags)).await
}

#[tauri::command]
pub async fn write_config_file(path: String, content: String) -> Result<(), String> {
    blocking_res(move || config::write(&path, &content)).await
}

#[tauri::command]
pub async fn probe_tool(kind: String, path: String) -> ShellResult {
    blocking(move || probe_tool_bin(&kind, &path)).await
}

fn probe_tool_bin(kind: &str, path: &str) -> ShellResult {
    let bin = path.trim();
    if bin.is_empty() {
        return ShellResult {
            success: false,
            stdout: String::new(),
            stderr: "路径为空".into(),
            exit_code: -1,
        };
    }
    let args: &[&str] = match kind {
        "docker" => &["version", "--format", "{{.Client.Version}}"],
        "adb" => &["version"],
        "scrcpy" => &["--version"],
        // The official Rust build has no --version flag; invoking it without
        // arguments prints its CLI help and exits successfully.
        "gnirehtet" => &[],
        _ => {
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("未知工具: {kind}"),
                exit_code: -1,
            };
        }
    };
    let mut r =
        crate::services::util::run_command_timeout(bin, args, std::time::Duration::from_secs(8));
    // A tool may print a version/help line before exiting non-zero. That is
    // still a failed probe; never turn useful-looking stdout into a fake OK.
    if r.success {
        r.stdout = r
            .stdout
            .lines()
            .next()
            .unwrap_or(&r.stdout)
            .trim()
            .to_string();
    }
    r
}

#[cfg(target_os = "windows")]
#[test]
fn probes_gnirehtet_without_an_unsupported_version_flag() {
    let result = probe_tool_bin("gnirehtet", "gnirehtet");
    assert!(result.success, "probe failed: {result:?}");
    assert!(
        result.stderr.contains("Syntax: gnirehtet"),
        "probe output: {result:?}"
    );
}

#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    blocking_res(move || reveal_path(&path)).await
}

fn reveal_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let target = if p.is_file() {
        p.parent().unwrap_or(p)
    } else {
        p
    };
    if !target.exists() {
        crate::services::util::ensure_dir(&target.to_string_lossy());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- WSL binder kernel (switch / restore / verify only) ----

#[tauri::command]
pub async fn get_wsl_kernel_status() -> WslKernelStatus {
    blocking(wsl_kernel::status).await
}

#[tauri::command]
pub async fn switch_wsl_kernel(mode: String, apply: bool) -> ShellResult {
    blocking(move || wsl_kernel::switch_kernel(&mode, apply)).await
}

#[tauri::command]
pub async fn verify_wsl_binder() -> ShellResult {
    blocking(wsl_kernel::verify_binder).await
}

// ---- QEMU track (qemu-center CLI bridge) ----

#[tauri::command]
pub async fn qemu_doctor() -> Result<crate::services::qemu::QemuDoctorReport, String> {
    blocking_res(crate::services::qemu::doctor).await
}

#[tauri::command]
pub async fn qemu_setup(
    step: String,
    distro: String,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::setup(&step, &distro)).await
}

#[tauri::command]
pub async fn qemu_vm_list() -> Result<Vec<crate::services::qemu::QemuVmEntry>, String> {
    blocking_res(crate::services::qemu::vm_list).await
}

#[tauri::command]
pub async fn qemu_vm_create(
    req: crate::services::qemu::QemuVmCreateRequest,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_create(req)).await
}

#[tauri::command]
pub async fn qemu_vm_start(name: String) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || {
        let _start_guard = QEMU_VM_START_LOCK.lock();
        let vm_memory_mib = crate::services::qemu::vm_list()?
            .into_iter()
            .find(|vm| vm.name == name)
            .map(|vm| vm.mem_mib)
            .ok_or_else(|| format!("节点不存在: {name}"))?;
        let snapshot =
            resource_monitor::read_runtime_resource_snapshot(None, None).unwrap_or_default();
        if should_block_qemu_vm_start(snapshot.host_available_bytes, Some(vm_memory_mib)) {
            let available = snapshot.host_available_bytes.unwrap_or_default();
            return Err(qemu_vm_start_memory_error(&name, available, vm_memory_mib));
        }
        crate::services::qemu::vm_start(&name)
    })
    .await
}

#[tauri::command]
pub async fn qemu_vm_set_memory(
    name: String,
    memory_mib: u32,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_set_memory(&name, memory_mib)).await
}

#[tauri::command]
pub async fn qemu_vm_memory_reclaim(
    name: String,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_memory_reclaim(&name)).await
}

#[tauri::command]
pub async fn qemu_vm_stop(name: String) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_stop(&name)).await
}

#[tauri::command]
pub async fn qemu_vm_delete(
    name: String,
    purge: bool,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_delete(&name, purge)).await
}

/// Create an internal qcow2 snapshot of a node's disk (VM should be stopped).
#[tauri::command]
pub async fn qemu_vm_snapshot(
    name: String,
    tag: String,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_snapshot(&name, &tag)).await
}

/// Restore (apply) an internal qcow2 snapshot. The VM must be stopped — the
/// UI confirms before calling; qemu-img refuses images locked by a running VM.
#[tauri::command]
pub async fn qemu_vm_restore(
    name: String,
    tag: String,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::vm_restore(&name, &tag)).await
}

#[tauri::command]
pub async fn qemu_guest_wait(
    name: String,
    timeout_secs: u64,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    blocking_res(move || crate::services::qemu::guest_wait(&name, timeout_secs)).await
}

#[tauri::command]
pub async fn qemu_redroid_create(
    req: crate::services::qemu::QemuRedroidCreateRequest,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    let version = req
        .android_version
        .as_deref()
        .filter(|version| !version.is_empty())
        .unwrap_or("14");
    // The preset runner is the protected core surface even for a basic
    // Redroid instance. Release builds never carry a local script fallback.
    let core = authorization_client::runtime_download_core_with_execution_grants(
        &format!("android-{version}"),
        &req.vm,
        &req.name,
        crate::services::qemu_presets::QEMU_CREATE_EXECUTION_GRANT_COUNT,
    )
    .await
    .map_err(|error| error.to_string())?;
    let execution_grants = core
        .execution_grants
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("执行票据无法编码: {error}"))?;
    blocking_res(move || crate::services::qemu::redroid_create_with_grants(req, execution_grants))
        .await
}

#[tauri::command]
pub async fn qemu_redroid_upgrade(
    req: crate::services::qemu::QemuRedroidCreateRequest,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    let version = req
        .android_version
        .as_deref()
        .filter(|version| !version.is_empty())
        .unwrap_or("14");
    let core = authorization_client::runtime_download_core_with_execution_grants(
        &format!("android-{version}"),
        &req.vm,
        &req.name,
        crate::services::qemu_presets::QEMU_UPGRADE_EXECUTION_GRANT_COUNT,
    )
    .await
    .map_err(|error| error.to_string())?;
    let execution_grants = core
        .execution_grants
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("执行票据无法编码: {error}"))?;
    blocking_res(move || crate::services::qemu::redroid_upgrade_with_grants(req, execution_grants))
        .await
}

#[tauri::command]
pub async fn qemu_redroid_restore(
    vm: String,
    name: String,
) -> Result<crate::services::qemu::QemuCliOutput, String> {
    let core = authorization_client::runtime_download_restore_core_with_execution_grant(&vm, &name)
        .await
        .map_err(|error| error.to_string())?;
    let execution_grant = serde_json::to_value(&core.execution_grant)
        .map_err(|error| format!("执行票据无法编码: {error}"))?;
    blocking_res(move || {
        crate::services::qemu::redroid_restore_with_grant(&vm, &name, execution_grant)
    })
    .await
}

#[tauri::command]
pub async fn qemu_redroid_list(
    vm: String,
) -> Result<Vec<crate::services::qemu::QemuRedroidInstance>, String> {
    // Enhanced metadata uses the same version-independent server-delivered
    // runner as restore. If authorization is unavailable, keep ordinary
    // diagnostics usable and return the CLI's basic list without enrichment.
    let core = authorization_client::runtime_download_metadata_core_with_execution_grant(&vm)
        .await
        .ok();
    blocking_res(move || match core {
        Some(core) => {
            let Ok(execution_grant) = serde_json::to_value(&core.execution_grant) else {
                return crate::services::qemu::redroid_list(&vm);
            };
            crate::services::qemu::redroid_list_with_grant(&vm, execution_grant)
        }
        None => crate::services::qemu::redroid_list(&vm),
    })
    .await
}

#[tauri::command]
pub async fn qemu_redroid_stats(
    vm: String,
    instance: Option<String>,
) -> Result<Vec<crate::services::qemu::QemuRedroidRuntimeStats>, String> {
    blocking_res(move || crate::services::qemu::redroid_stats(&vm, instance.as_deref())).await
}

#[tauri::command]
pub async fn qemu_adb_list() -> Result<Vec<crate::services::qemu::QemuAdbMapping>, String> {
    blocking_res(crate::services::qemu::adb_list).await
}

#[tauri::command]
pub async fn qemu_verify(vm: String) -> Result<crate::services::qemu::QemuVerifyReport, String> {
    blocking_res(move || crate::services::qemu::verify(&vm)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qemu_row(instance: &str, status: &str) -> crate::services::qemu::QemuRedroidInstance {
        crate::services::qemu::QemuRedroidInstance {
            instance: instance.into(),
            container: format!("qc-{instance}"),
            port: 24500,
            serial: "127.0.0.1:24500".into(),
            status: status.into(),
            profile: "lean".into(),
            android_version: "13".into(),
            image: "redroid/redroid:13.0.0-latest".into(),
            rollback_available: false,
            metrics: None,
        }
    }

    #[test]
    fn unknown_pressure_blocks_only_batch_runtime_starts() {
        assert!(!should_block_runtime_start(
            resource_monitor::MemoryPressure::Unknown,
            false
        ));
        assert!(should_block_runtime_start(
            resource_monitor::MemoryPressure::Unknown,
            true
        ));
        assert!(should_block_runtime_start(
            resource_monitor::MemoryPressure::Critical,
            false
        ));
        assert!(!should_block_runtime_start(
            resource_monitor::MemoryPressure::Caution,
            true
        ));
    }

    #[test]
    fn critical_pressure_guest_reclaim_respects_existing_auto_release_policy() {
        assert!(should_attempt_critical_guest_reclaim(
            resource_monitor::MemoryPressure::Critical,
            false,
            true
        ));
        assert!(!should_attempt_critical_guest_reclaim(
            resource_monitor::MemoryPressure::Critical,
            true,
            true
        ));
        assert!(!should_attempt_critical_guest_reclaim(
            resource_monitor::MemoryPressure::Critical,
            false,
            false
        ));
        assert!(!should_attempt_critical_guest_reclaim(
            resource_monitor::MemoryPressure::Unknown,
            false,
            true
        ));
    }

    #[test]
    fn app_hibernate_reclaims_only_after_force_stop_succeeds() {
        let mut calls = 0;
        assert!(run_guest_reclaim_after_app_hibernate(true, || {
            calls += 1;
            true
        }));
        assert_eq!(calls, 1);

        assert!(!run_guest_reclaim_after_app_hibernate(false, || {
            calls += 1;
            true
        }));
        assert_eq!(calls, 1);
    }

    #[test]
    fn protected_create_requests_all_three_server_grants() {
        assert_eq!(
            crate::services::qemu_presets::QEMU_CREATE_EXECUTION_GRANT_COUNT,
            3
        );
        assert_eq!(
            crate::services::qemu_presets::QEMU_UPGRADE_EXECUTION_GRANT_COUNT,
            2
        );
    }

    #[test]
    fn qemu_vm_start_requires_requested_memory_headroom() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(should_block_qemu_vm_start(Some(3 * GIB), Some(3072)));
        assert!(!should_block_qemu_vm_start(Some(5 * GIB), Some(3072)));
        assert!(!should_block_qemu_vm_start(None, Some(3072)));
    }

    #[test]
    fn auto_reclaim_candidate_skips_target_and_unconfirmed_statuses() {
        let rows = vec![
            qemu_row("r13", "Up 4 minutes"),
            qemu_row("r1", "Exited (137) 2 hours ago"),
            qemu_row("r2", "unknown"),
            qemu_row("r3", "Up 2 hours"),
        ];
        let reclaimable = vec!["r13".into(), "r1".into(), "r2".into(), "r3".into()];
        assert_eq!(
            select_idle_reclaim_candidate(&rows, &reclaimable, "r13"),
            Some("r3".into())
        );
    }

    #[test]
    fn idle_release_only_stops_an_empty_node() {
        let stopped_target = vec![qemu_row("r13", "Exited (0) 1 minute ago")];
        assert!(should_stop_vm_after_idle_release(
            false,
            Some(&stopped_target),
            "r13"
        ));

        let other_running = vec![
            qemu_row("r13", "Exited (0) 1 minute ago"),
            qemu_row("r1", "Up 4 hours"),
        ];
        assert!(!should_stop_vm_after_idle_release(
            false,
            Some(&other_running),
            "r13"
        ));

        let other_unknown = vec![
            qemu_row("r13", "Exited (0) 1 minute ago"),
            qemu_row("r1", "unknown"),
        ];
        assert!(!should_stop_vm_after_idle_release(
            false,
            Some(&other_unknown),
            "r13"
        ));
        assert!(!should_stop_vm_after_idle_release(false, None, "r13"));
        assert!(!should_stop_vm_after_idle_release(
            true,
            Some(&stopped_target),
            "r13"
        ));
    }

    #[test]
    fn critical_pressure_overrides_warm_node_preference_but_unknown_does_not() {
        assert!(!keep_vm_warm_for_pressure(
            true,
            resource_monitor::MemoryPressure::Critical
        ));
        assert!(keep_vm_warm_for_pressure(
            true,
            resource_monitor::MemoryPressure::Caution
        ));
        assert!(keep_vm_warm_for_pressure(
            true,
            resource_monitor::MemoryPressure::Normal
        ));
        assert!(keep_vm_warm_for_pressure(
            true,
            resource_monitor::MemoryPressure::Unknown
        ));
        assert!(!keep_vm_warm_for_pressure(
            false,
            resource_monitor::MemoryPressure::Critical
        ));
    }

    #[test]
    fn older_lifecycle_policy_defaults_auto_reclaim_to_enabled() {
        let policy: runtime_scheduler::LifecyclePolicy =
            serde_json::from_str(
                r#"{"idleTimeoutMinutes":30,"keepVmWarm":true,"maxParallelStarts":1,"protectedInstanceIds":[]}"#,
            )
            .unwrap();
        assert!(policy.auto_release_idle_on_critical);
    }
}
