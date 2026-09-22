mod commands;
pub mod models;
pub mod services;

use commands::*;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::log::info("System", "Just Run starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(services::terminal_session::TerminalRegistry::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, Option::<&str>::None)?;
            let devices =
                MenuItem::with_id(app, "devices", "打开设备中心", true, Option::<&str>::None)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, Option::<&str>::None)?;
            let menu = Menu::with_items(app, &[&show, &devices, &quit])?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(tauri::include_image!("icons/icon.png"))
                .menu(&menu)
                .tooltip("Just Run")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        if event.id() == "devices" {
                            let _ = window.emit("rdc://navigate", "/devices");
                        }
                    }
                })
                .build(app)?;
            let _ = tray;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // System
            get_dashboard,
            get_system_status,
            readiness_checklist,
            authorization_status,
            authorization_register,
            authorization_acquire_session,
            authorization_heartbeat,
            authorization_revoke_local,
            read_runtime_resource_snapshot,
            runtime_mark_activity,
            runtime_request_start,
            runtime_release_idle,
            runtime_hibernate_app,
            // Devices
            list_devices,
            list_devices_unified,
            get_device,
            get_device_telemetry,
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
            device_lock,
            device_wake,
            device_rotate,
            device_set_rotation_mode,
            device_volume_mute,
            device_screen_off,
            device_reboot,
            device_shutdown,
            device_open_notifications,
            device_open_settings,
            device_send_clipboard,
            device_read_clipboard,
            device_shell,
            terminal_start,
            terminal_write,
            terminal_read,
            terminal_resize,
            terminal_stop,
            terminal_session_start,
            terminal_session_write,
            terminal_session_stop,
            terminal_session_list,
            // APK / Apps
            install_apk,
            uninstall_app,
            start_app,
            start_app_on_display,
            start_app_activity,
            create_app_shortcut,
            stop_app,
            clear_app_data,
            list_apps,
            list_apps_result,
            get_app_icon,
            get_app_detail,
            get_app_permissions,
            get_app_activities,
            get_app_detail_result,
            get_app_permissions_result,
            get_app_activities_result,
            // Files
            list_files,
            list_files_result,
            upload_file,
            upload_file_tracked,
            download_file,
            download_file_tracked,
            cancel_file_transfer,
            delete_file,
            mkdir_remote,
            move_remote_file,
            copy_remote_file,
            delete_remote_path,
            read_remote_file,
            write_remote_file,
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
            cancel_create_instance,
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
            list_spoof_profiles,
            get_spoof_identity,
            apply_spoof_profile,
            capture_spoof_profile,
            delete_custom_profile,
            install_cloak_module,
            push_cloak_config,
            get_cloak_status,
            install_native_cloak,
            seed_usage_baseline,
            geo_consistency_check,
            get_battery_state,
            apply_battery_policy,
            adversarial_audit,
            apply_device_proxy,
            clear_device_proxy,
            get_device_proxy_status,
            apply_transparent_proxy,
            stop_transparent_proxy,
            spoof_profile_usage,
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
            adb_discover,
            adb_tcpip,
            // Scrcpy
            scrcpy_start,
            scrcpy_start_layout,
            scrcpy_stop,
            scrcpy_restart,
            scrcpy_status,
            scrcpy_stream_start,
            scrcpy_stream_stop,
            scrcpy_stream_status,
            // Recording / camera / OTG
            recording_start,
            recording_stop,
            recording_status,
            scrcpy_start_recording,
            scrcpy_stop_recording,
            scrcpy_recording_status,
            scrcpy_start_camera,
            scrcpy_stop_camera,
            scrcpy_camera_status,
            scrcpy_start_input,
            scrcpy_stop_input,
            scrcpy_input_status,
            // Gnirehtet reverse tethering
            gnirehtet_install,
            gnirehtet_start,
            gnirehtet_stop,
            gnirehtet_status,
            gnirehtet_repair,
            // Logs
            get_system_logs,
            clear_system_logs,
            export_system_logs,
            append_log,
            // Settings
            get_settings,
            update_settings,
            read_config_file,
            write_config_file,
            reveal_in_folder,
            probe_tool,
            // Device tags (settings-backed grouping)
            get_device_tags,
            set_device_tags,
            // WSL binder kernel (switch / restore / verify)
            get_wsl_kernel_status,
            switch_wsl_kernel,
            verify_wsl_binder,
            optimize_app_art,
            // QEMU track (qemu-center CLI bridge)
            qemu_doctor,
            qemu_setup,
            qemu_vm_list,
            qemu_vm_create,
            qemu_vm_start,
            qemu_vm_set_memory,
            qemu_vm_memory_reclaim,
            qemu_vm_stop,
            qemu_vm_delete,
            qemu_vm_snapshot,
            qemu_vm_restore,
            qemu_guest_wait,
            qemu_redroid_create,
            qemu_redroid_upgrade,
            qemu_redroid_restore,
            qemu_redroid_list,
            qemu_redroid_stats,
            qemu_adb_list,
            qemu_verify,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
