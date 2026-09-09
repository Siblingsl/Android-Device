use crate::models::*;
use crate::services::{adb, device, docker, log, root, scrcpy, settings, transfer, wsl_kernel};

async fn blocking<T: Send + 'static + Default>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_default()
}

async fn blocking_opt<T: Send + 'static>(f: impl FnOnce() -> Option<T> + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(f).await.unwrap_or(None)
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

// ---- Devices ----

#[tauri::command]
pub async fn list_devices() -> Vec<DeviceInfo> {
    blocking(device::list_devices).await
}

#[tauri::command]
pub async fn get_device(id: String) -> Option<DeviceInfo> {
    blocking_opt(move || device::get_device(&id)).await
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
pub async fn device_shell(serial: String, command: String) -> ShellResult {
    blocking(move || device::shell_command(&serial, &command)).await
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
pub async fn stop_app(serial: String, package: String) -> ShellResult {
    blocking(move || device::stop_app(&serial, &package)).await
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

// ---- Files ----

fn tracked_transfer_error(message: impl Into<String>) -> ShellResult {
    ShellResult {
        success: false,
        stdout: String::new(),
        stderr: message.into(),
        exit_code: -1,
    }
}

#[tauri::command]
pub async fn list_files(serial: String, path: String) -> Vec<FileEntry> {
    blocking(move || device::list_files(&serial, &path)).await
}

#[tauri::command]
pub async fn upload_file(serial: String, local: String, remote: String) -> ShellResult {
    blocking(move || device::upload_file(&serial, &local, &remote)).await
}

#[tauri::command]
pub async fn download_file(serial: String, remote: String, local: String) -> ShellResult {
    blocking(move || device::download_file(&serial, &remote, &local)).await
}

#[tauri::command]
pub async fn upload_file_tracked(
    app: tauri::AppHandle,
    registry: tauri::State<'_, transfer::TransferRegistry>,
    serial: String,
    local: String,
    remote: String,
    operation_id: String,
) -> Result<ShellResult, String> {
    let registry = registry.inner().clone();
    let operation_id = operation_id.trim().to_string();
    let cancel = match registry.start(&operation_id) {
        Ok(cancel) => cancel,
        Err(error) => return Ok(tracked_transfer_error(error)),
    };
    let worker_operation_id = operation_id.clone();
    let result = blocking(move || {
        device::upload_file_tracked(
            &app,
            &serial,
            &local,
            &remote,
            &worker_operation_id,
            &cancel,
        )
    })
    .await;
    registry.finish(&operation_id);
    Ok(result)
}

#[tauri::command]
pub async fn download_file_tracked(
    app: tauri::AppHandle,
    registry: tauri::State<'_, transfer::TransferRegistry>,
    serial: String,
    remote: String,
    local: String,
    operation_id: String,
) -> Result<ShellResult, String> {
    let registry = registry.inner().clone();
    let operation_id = operation_id.trim().to_string();
    let cancel = match registry.start(&operation_id) {
        Ok(cancel) => cancel,
        Err(error) => return Ok(tracked_transfer_error(error)),
    };
    let worker_operation_id = operation_id.clone();
    let result = blocking(move || {
        device::download_file_tracked(
            &app,
            &serial,
            &remote,
            &local,
            &worker_operation_id,
            &cancel,
        )
    })
    .await;
    registry.finish(&operation_id);
    Ok(result)
}

#[tauri::command]
pub fn cancel_file_transfer(
    registry: tauri::State<'_, transfer::TransferRegistry>,
    operation_id: String,
) -> bool {
    registry.cancel(operation_id.trim())
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
pub async fn adb_pair(address: String, pairing_code: String) -> ShellResult {
    blocking(move || adb::pair(&address, &pairing_code)).await
}

#[tauri::command]
pub async fn adb_mdns_services() -> Vec<AdbMdnsService> {
    blocking(adb::mdns_services).await
}

#[tauri::command]
pub async fn adb_tcpip(serial: String, port: u16) -> ShellResult {
    blocking(move || adb::tcpip(&serial, port)).await
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

// ---- Scrcpy ----

#[tauri::command]
pub async fn scrcpy_start(
    serial: String,
    max_size: u32,
    bit_rate: u32,
    extra: Option<String>,
) -> ShellResult {
    blocking(move || scrcpy::start(&serial, max_size, bit_rate, extra.as_deref().unwrap_or(""))).await
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
        _ => {
            return ShellResult {
                success: false,
                stdout: String::new(),
                stderr: format!("未知工具: {kind}"),
                exit_code: -1,
            };
        }
    };
    let mut r = crate::services::util::run_command_timeout(bin, args, std::time::Duration::from_secs(8));
    if r.success || !r.stdout.is_empty() {
        r.success = true;
        r.stdout = r.stdout.lines().next().unwrap_or(&r.stdout).trim().to_string();
    }
    r
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_transfer_error_preserves_shell_result_contract() {
        let result = tracked_transfer_error("duplicate transfer");
        assert!(!result.success);
        assert_eq!(result.stderr, "duplicate transfer");
        assert_eq!(result.exit_code, -1);
    }
}
