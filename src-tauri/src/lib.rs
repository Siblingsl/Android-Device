mod commands;
mod models;
mod services;

use commands::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::log::info("System", "Redroid Device Center starting");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .manage(services::terminal::TerminalRegistry::default())
        .manage(services::transfer::TransferRegistry::default())
        .invoke_handler(tauri::generate_handler![
            // System
            copilot_completion,
            check_for_updates,
            download_update,
            get_dashboard,
            get_system_status,
            // Devices
            list_devices,
            get_device,
            connect_device,
            disconnect_device,
            restart_device,
            stop_device,
            // Control
            device_tap,
            device_swipe,
            device_long_press,
            device_text,
            device_keyevent,
            device_home,
            device_back,
            device_recent,
            device_power,
            device_volume_up,
            device_volume_down,
            device_volume_mute,
            device_lock,
            device_wake,
            device_rotate,
            device_set_rotation_mode,
            device_screen_off,
            device_reboot,
            device_shutdown,
            device_open_notifications,
            device_open_settings,
            device_send_clipboard,
            device_shell,
            // Persistent terminal sessions
            terminal_session_start,
            terminal_session_write,
            terminal_session_stop,
            terminal_session_list,
            // APK / Apps
            install_apk,
            uninstall_app,
            start_app,
            stop_app,
            clear_app_data,
            list_apps,
            get_app_detail,
            get_app_permissions,
            get_app_activities,
            // Files
            list_files,
            upload_file,
            download_file,
            upload_file_tracked,
            download_file_tracked,
            cancel_file_transfer,
            delete_file,
            mkdir_remote,
            storage_info,
            // Screenshot
            take_screenshot,
            // Logcat
            get_logcat,
            // Device settings
            set_device_resolution,
            set_device_dpi,
            set_device_language,
            // Docker
            get_docker_info,
            refresh_docker_info,
            create_redroid_instance,
            get_create_stage,
            next_free_adb_port,
            check_instance_name,
            check_adb_port,
            start_docker_desktop,
            get_local_gapps_path,
            path_exists,
            // Root / Magisk preset
            get_magisk_assets,
            get_root_status,
            magisk_denylist_add,
            magisk_denylist_remove,
            magisk_apply_spoof,
            magisk_set_shamiko_mode,
            magisk_module_set_enabled,
            magisk_module_remove,
            magisk_repair_managers,
            get_lsposed_scope,
            get_su_policies,
            magisk_set_su_policy,
            magisk_remove_su_policy,
            start_container,
            stop_container,
            restart_container,
            remove_container,
            rename_container,
            clone_container,
            inspect_container,
            get_container_logs,
            export_container_config,
            list_volumes,
            remove_volume,
            remove_image,
            prune_dangling_images,
            // ADB
            get_adb_info,
            adb_start_server,
            adb_kill_server,
            adb_restart_server,
            adb_connect,
            adb_disconnect,
            adb_reconnect,
            adb_auto_fix,
            adb_local_subnet,
            adb_lan_scan,
            adb_pair,
            adb_mdns_services,
            adb_tcpip,
            // Scrcpy
            scrcpy_start,
            scrcpy_start_layout,
            scrcpy_stop,
            scrcpy_restart,
            scrcpy_status,
            scrcpy_start_recording,
            scrcpy_stop_recording,
            scrcpy_recording_status,
            scrcpy_start_camera,
            scrcpy_stop_camera,
            scrcpy_camera_status,
            scrcpy_start_input,
            scrcpy_stop_input,
            scrcpy_input_status,
            // Logs
            get_system_logs,
            clear_system_logs,
            export_system_logs,
            append_log,
            // Settings
            get_settings,
            update_settings,
            reveal_in_folder,
            probe_tool,
            // WSL binder kernel (switch / restore / verify)
            get_wsl_kernel_status,
            switch_wsl_kernel,
            verify_wsl_binder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(registry) =
                    app_handle.try_state::<services::terminal::TerminalRegistry>()
                {
                    services::terminal::stop_all(registry.inner());
                }
            }
        });
}
