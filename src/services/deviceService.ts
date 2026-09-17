import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { friendlyError } from "../lib/errors";
import type {
  AdbInfo,
  AppInfo,
  AppSettings,
  CreateInstanceRequest,
  DashboardData,
  DeviceInfo,
  DeviceTelemetry,
  DockerInfo,
  DockerVolume,
  FileEntry,
  LogEntry,
  LanScanResult,
  WirelessDiscovery,
  LsposedScopeReport,
  MagiskAssets,
  RootStatus,
  RecordingSession,
  GnirehtetSession,
  ScrcpyCameraOptions,
  ScrcpyInputMode,
  ScrcpyInputOptions,
  ScrcpyRecordingOptions,
  ScrcpyWindowPlacement,
  ScreenshotResult,
  ShellResult,
  StreamSession,
  TerminalSession,
  SuPolicyEntry,
  SystemStatus,
  WslKernelStatus,
  SpoofProfileSummary,
  SpoofIdentity,
  SpoofProfileUsage,
  DeviceProxyStatus,
  CloakStatus,
  BatteryState,
  AdversarialAudit,
  GeoCheck,
  QemuAdbMapping,
  QemuCliOutput,
  QemuDoctorReport,
  QemuRedroidCreateRequest,
  QemuRedroidInstance,
  QemuRedroidRuntimeStats,
  RuntimeIdleReleaseResult,
  RuntimeStartDecision,
  QemuVerifyReport,
  QemuVmCreateRequest,
  QemuVmEntry,
  ReadinessItem,
  RuntimeResourceSnapshot,
  ArtMode,
  ArtOptimizationResult,
} from "../types";

/** Unified Device Service — all device capabilities go through here */
const invoke = async <T,>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw friendlyError(e);
  }
};

export const DeviceService = {
  // System
  getDashboard: () => invoke<DashboardData>("get_dashboard"),
  getSystemStatus: () => invoke<SystemStatus>("get_system_status"),
  /** First-use readiness checklist (Dashboard 待办卡). */
  readinessChecklist: () => invoke<ReadinessItem[]>("readiness_checklist"),
  /** Read-only resource snapshot for the selected QEMU/Redroid runtime. */
  readRuntimeResourceSnapshot: (vm?: string, instance?: string) =>
    invoke<RuntimeResourceSnapshot>("read_runtime_resource_snapshot", {
      vm: vm ?? null,
      instance: instance ?? null,
    }),

  // Devices
  listDevices: () => invoke<DeviceInfo[]>("list_devices"),
  /** Unified list: Docker track + QEMU track (rows carry `source`). */
  listDevicesUnified: () => invoke<DeviceInfo[]>("list_devices_unified"),
  getDevice: (id: string) => invoke<DeviceInfo | null>("get_device", { id }),
  getDeviceTelemetry: (serial: string) => invoke<DeviceTelemetry>("get_device_telemetry", { serial }),
  connect: (serial: string) => invoke<ShellResult>("connect_device", { serial }),
  disconnect: (serial: string) => invoke<ShellResult>("disconnect_device", { serial }),
  restart: (id: string) => invoke<ShellResult>("restart_device", { id }),
  stop: (id: string) => invoke<ShellResult>("stop_device", { id }),

  // Control
  tap: (serial: string, x: number, y: number) =>
    invoke<ShellResult>("device_tap", { serial, x, y }),
  swipe: (serial: string, x1: number, y1: number, x2: number, y2: number, duration = 300) =>
    invoke<ShellResult>("device_swipe", { serial, x1, y1, x2, y2, duration }),
  longPress: (serial: string, x: number, y: number, duration = 800) =>
    invoke<ShellResult>("device_long_press", { serial, x, y, duration }),
  text: (serial: string, text: string) =>
    invoke<ShellResult>("device_text", { serial, text }),
  keyevent: (serial: string, code: number) =>
    invoke<ShellResult>("device_keyevent", { serial, code }),
  home: (serial: string) => invoke<ShellResult>("device_home", { serial }),
  back: (serial: string) => invoke<ShellResult>("device_back", { serial }),
  recent: (serial: string) => invoke<ShellResult>("device_recent", { serial }),
  power: (serial: string) => invoke<ShellResult>("device_power", { serial }),
  volumeUp: (serial: string) => invoke<ShellResult>("device_volume_up", { serial }),
  volumeDown: (serial: string) => invoke<ShellResult>("device_volume_down", { serial }),
  lock: (serial: string) => invoke<ShellResult>("device_lock", { serial }),
  wake: (serial: string) => invoke<ShellResult>("device_wake", { serial }),
  rotate: (serial: string, landscape: boolean) =>
    invoke<ShellResult>("device_rotate", { serial, landscape }),
  setRotationMode: (serial: string, mode: "portrait" | "landscape" | "auto" | "lock") =>
    invoke<ShellResult>("device_set_rotation_mode", { serial, mode }),
  volumeMute: (serial: string) => invoke<ShellResult>("device_volume_mute", { serial }),
  screenOff: (serial: string) => invoke<ShellResult>("device_screen_off", { serial }),
  rebootDevice: (serial: string) => invoke<ShellResult>("device_reboot", { serial }),
  shutdownDevice: (serial: string) => invoke<ShellResult>("device_shutdown", { serial }),
  openNotifications: (serial: string) =>
    invoke<ShellResult>("device_open_notifications", { serial }),
  openSettings: (serial: string) =>
    invoke<ShellResult>("device_open_settings", { serial }),
  sendClipboard: (serial: string, content: string) =>
    invoke<ShellResult>("device_send_clipboard", { serial, content }),
  readClipboard: (serial: string) =>
    invoke<ShellResult>("device_read_clipboard", { serial }),
  shell: (serial: string, command: string) =>
    invoke<ShellResult>("device_shell", { serial, command }),
  terminalStart: (kind: "device" | "local", serial = "") =>
    invoke<TerminalSession>("terminal_start", { kind, serial }),
  terminalWrite: (id: string, input: string) =>
    invoke<ShellResult>("terminal_write", { id, input }),
  terminalRead: (id: string) => invoke<TerminalSession>("terminal_read", { id }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<ShellResult>("terminal_resize", { id, cols, rows }),
  terminalStop: (id: string) => invoke<ShellResult>("terminal_stop", { id }),

  // APK / Apps
  installApk: (serial: string, path: string, replace = true) =>
    invoke<ShellResult>("install_apk", { serial, path, replace }),
  uninstallApp: (serial: string, packageName: string) =>
    invoke<ShellResult>("uninstall_app", { serial, package: packageName }),
  startApp: (serial: string, packageName: string) =>
    invoke<ShellResult>("start_app", { serial, package: packageName }),
  startAppOnDisplay: (serial: string, packageName: string, displayId: number) =>
    invoke<ShellResult>("start_app_on_display", { serial, package: packageName, displayId }),
  startAppActivity: (serial: string, packageName: string, activity: string) =>
    invoke<ShellResult>("start_app_activity", { serial, package: packageName, activity }),
  createAppShortcut: (serial: string, packageName: string) =>
    invoke<string>("create_app_shortcut", { serial, package: packageName }),
  openDeviceWindow: (id: string, title: string, x: number, y: number, width: number, height: number) =>
    invoke<void>("open_device_window", { id, title, x, y, width, height }),
  stopApp: (serial: string, packageName: string) =>
    invoke<ShellResult>("stop_app", { serial, package: packageName }),
  clearAppData: (serial: string, packageName: string) =>
    invoke<ShellResult>("clear_app_data", { serial, package: packageName }),
  listApps: (serial: string, includeSystem = false) =>
    invoke<AppInfo[]>("list_apps", { serial, includeSystem }),
  listAppsResult: (serial: string, includeSystem = false) =>
    invoke<AppInfo[]>("list_apps_result", { serial, includeSystem }),
  getAppIcon: (serial: string, packageName: string) =>
    invoke<string>("get_app_icon", { serial, package: packageName }),
  getAppDetail: (serial: string, packageName: string) =>
    invoke<AppInfo>("get_app_detail", { serial, package: packageName }),
  getAppDetailResult: (serial: string, packageName: string) =>
    invoke<AppInfo>("get_app_detail_result", { serial, package: packageName }),
  getAppPermissions: (serial: string, packageName: string) =>
    invoke<string>("get_app_permissions", { serial, package: packageName }),
  getAppPermissionsResult: (serial: string, packageName: string) =>
    invoke<string>("get_app_permissions_result", { serial, package: packageName }),
  getAppActivities: (serial: string, packageName: string) =>
    invoke<string>("get_app_activities", { serial, package: packageName }),
  getAppActivitiesResult: (serial: string, packageName: string) =>
    invoke<string>("get_app_activities_result", { serial, package: packageName }),

  // Files
  listFiles: (serial: string, path: string) =>
    invoke<FileEntry[]>("list_files", { serial, path }),
  listFilesResult: (serial: string, path: string) =>
    invoke<FileEntry[]>("list_files_result", { serial, path }),
  uploadFile: (serial: string, local: string, remote: string) =>
    invoke<ShellResult>("upload_file", { serial, local, remote }),
  downloadFile: (serial: string, remote: string, local: string) =>
    invoke<ShellResult>("download_file", { serial, remote, local }),
  uploadFileTracked: (serial: string, local: string, remote: string, operationId: string) =>
    invoke<ShellResult>("upload_file_tracked", { serial, local, remote, operationId }),
  downloadFileTracked: (serial: string, remote: string, local: string, operationId: string) =>
    invoke<ShellResult>("download_file_tracked", { serial, remote, local, operationId }),
  cancelFileTransfer: (operationId: string) =>
    invoke<boolean>("cancel_file_transfer", { operationId }),
  deleteFile: (serial: string, path: string) =>
    invoke<ShellResult>("delete_file", { serial, path }),
  mkdir: (serial: string, path: string) =>
    invoke<ShellResult>("mkdir_remote", { serial, path }),
  moveRemote: (serial: string, source: string, target: string) =>
    invoke<ShellResult>("move_remote_file", { serial, source, target }),
  copyRemote: (serial: string, source: string, target: string) =>
    invoke<ShellResult>("copy_remote_file", { serial, source, target }),
  deleteRemotePath: (serial: string, path: string) =>
    invoke<ShellResult>("delete_remote_path", { serial, path }),
  readRemote: (serial: string, path: string) =>
    invoke<ShellResult>("read_remote_file", { serial, path }),
  writeRemote: (serial: string, path: string, content: string) =>
    invoke<ShellResult>("write_remote_file", { serial, path, content }),
  storageInfo: (serial: string) => invoke<string>("storage_info", { serial }),

  // Screenshot
  screenshot: (serial: string) => invoke<ScreenshotResult>("take_screenshot", { serial }),

  // Logcat
  logcat: (serial: string, lines = 200, clear = false) =>
    invoke<string>("get_logcat", { serial, lines, clear }),

  // Device settings
  setResolution: (serial: string, resolution: string) =>
    invoke<ShellResult>("set_device_resolution", { serial, resolution }),
  setDpi: (serial: string, dpi: string) =>
    invoke<ShellResult>("set_device_dpi", { serial, dpi }),
  setLanguage: (serial: string, lang: string) =>
    invoke<ShellResult>("set_device_language", { serial, lang }),

  // Docker
  getDockerInfo: () => invoke<DockerInfo>("get_docker_info"),
  refreshDockerInfo: () => invoke<DockerInfo>("refresh_docker_info"),
  getCreateStage: () => invoke<string>("get_create_stage"),
  createInstance: (req: CreateInstanceRequest) =>
    invoke<ShellResult>("create_redroid_instance", { req }),
  cancelCreateInstance: (name: string) =>
    invoke<ShellResult>("cancel_create_instance", { name }),
  nextFreeAdbPort: () => invoke<number>("next_free_adb_port"),
  checkInstanceName: (name: string) => invoke<boolean>("check_instance_name", { name }),
  checkAdbPort: (port: number) => invoke<boolean>("check_adb_port", { port }),
  startDockerDesktop: () => invoke<boolean>("start_docker_desktop"),
  getLocalGappsPath: () => invoke<string>("get_local_gapps_path"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  // Root / Magisk preset
  getMagiskAssets: () => invoke<MagiskAssets>("get_magisk_assets"),
  getRootStatus: (serial: string) => invoke<RootStatus>("get_root_status", { serial }),
  magiskDenylistAdd: (serial: string, pkg: string) =>
    invoke<ShellResult>("magisk_denylist_add", { serial, package: pkg }),
  magiskDenylistRemove: (serial: string, pkg: string) =>
    invoke<ShellResult>("magisk_denylist_remove", { serial, package: pkg }),
  magiskApplySpoof: (serial: string) => invoke<ShellResult>("magisk_apply_spoof", { serial }),
  listSpoofProfiles: () => invoke<SpoofProfileSummary[]>("list_spoof_profiles"),
  getSpoofIdentity: (serial: string) => invoke<SpoofIdentity>("get_spoof_identity", { serial }),
  applySpoofProfile: (serial: string, profileId: string) =>
    invoke<ShellResult>("apply_spoof_profile", { serial, profileId }),
  captureSpoofProfile: (serial: string, idHint: string) =>
    invoke<SpoofProfileSummary>("capture_spoof_profile", { serial, idHint }),
  deleteCustomProfile: (id: string) => invoke<void>("delete_custom_profile", { id }),
  installCloakModule: (serial: string) =>
    invoke<ShellResult>("install_cloak_module", { serial }),
  pushCloakConfig: (serial: string, profileId: string) =>
    invoke<ShellResult>("push_cloak_config", { serial, profileId }),
  getCloakStatus: (serial: string) => invoke<CloakStatus>("get_cloak_status", { serial }),
  /** Install the native (Zygisk) NativeCloak module onto an existing instance. */
  installNativeCloak: (serial: string, zipPath?: string) =>
    invoke<ShellResult>("install_native_cloak", { serial, zipPath: zipPath ?? null }),
  /** Seed the usage-stats baseline + /sdcard timestamp backstop. */
  seedUsageBaseline: (serial: string, profileId: string) =>
    invoke<ShellResult>("seed_usage_baseline", { serial, profileId }),
  /** Geo/timezone consistency check against a spoof profile. */
  geoConsistencyCheck: (serial: string, profileId: string) =>
    invoke<GeoCheck>("geo_consistency_check", { serial, profileId }),
  // Battery spoofing curve
  getBatteryState: (serial: string) => invoke<BatteryState>("get_battery_state", { serial }),
  applyBatteryPolicy: (serial: string) => invoke<ShellResult>("apply_battery_policy", { serial }),
  // Adversarial self-audit
  adversarialAudit: (serial: string, profileId?: string) =>
    invoke<AdversarialAudit>("adversarial_audit", { serial, profileId: profileId || null }),
  // Per-instance proxy egress
  applyDeviceProxy: (serial: string, proxy: string) =>
    invoke<ShellResult>("apply_device_proxy", { serial, proxy }),
  clearDeviceProxy: (serial: string) =>
    invoke<ShellResult>("clear_device_proxy", { serial }),
  getDeviceProxyStatus: (serial: string) =>
    invoke<DeviceProxyStatus>("get_device_proxy_status", { serial }),
  applyTransparentProxy: (serial: string, proxy: string) =>
    invoke<ShellResult>("apply_transparent_proxy", { serial, proxy }),
  stopTransparentProxy: (serial: string) =>
    invoke<ShellResult>("stop_transparent_proxy", { serial }),
  // Spoof-profile diversity census
  spoofProfileUsage: () => invoke<SpoofProfileUsage[]>("spoof_profile_usage"),
  magiskSetShamikoMode: (serial: string, whitelist: boolean) =>
    invoke<ShellResult>("magisk_set_shamiko_mode", { serial, whitelist }),
  magiskModuleSetEnabled: (serial: string, id: string, enabled: boolean) =>
    invoke<ShellResult>("magisk_module_set_enabled", { serial, id, enabled }),
  magiskModuleRemove: (serial: string, id: string) =>
    invoke<ShellResult>("magisk_module_remove", { serial, id }),
  magiskRepairManagers: (serial: string) =>
    invoke<ShellResult>("magisk_repair_managers", { serial }),
  getLsposedScope: (serial: string) =>
    invoke<LsposedScopeReport>("get_lsposed_scope", { serial }),
  getSuPolicies: (serial: string) =>
    invoke<SuPolicyEntry[]>("get_su_policies", { serial }),
  magiskSetSuPolicy: (serial: string, uid: number, allow: boolean) =>
    invoke<ShellResult>("magisk_set_su_policy", { serial, uid, allow }),
  magiskRemoveSuPolicy: (serial: string, uid: number) =>
    invoke<ShellResult>("magisk_remove_su_policy", { serial, uid }),
  // LAN scan (ADB over TCP discovery)
  getLocalSubnet: () => invoke<string>("adb_local_subnet"),
  lanScan: (subnet: string, port: number, autoConnect: boolean) =>
    invoke<LanScanResult>("adb_lan_scan", { subnet, port, autoConnect }),
  startContainer: (id: string) => invoke<ShellResult>("start_container", { id }),
  stopContainer: (id: string) => invoke<ShellResult>("stop_container", { id }),
  restartContainer: (id: string) => invoke<ShellResult>("restart_container", { id }),
  removeContainer: (id: string, force = true) =>
    invoke<ShellResult>("remove_container", { id, force }),
  renameContainer: (id: string, newName: string) =>
    invoke<ShellResult>("rename_container", { id, newName }),
  cloneContainer: (id: string, newName: string) =>
    invoke<ShellResult>("clone_container", { id, newName }),
  inspectContainer: (id: string) => invoke<ShellResult>("inspect_container", { id }),
  getContainerLogs: (id: string, tail = 200) =>
    invoke<ShellResult>("get_container_logs", { id, tail }),
  exportContainerConfig: (id: string, path: string) =>
    invoke<string>("export_container_config", { id, path }),
  listVolumes: () => invoke<DockerVolume[]>("list_volumes"),
  removeVolume: (name: string, force = false) =>
    invoke<ShellResult>("remove_volume", { name, force }),
  removeImage: (id: string, force = false) =>
    invoke<ShellResult>("remove_image", { id, force }),
  pruneDanglingImages: () => invoke<ShellResult>("prune_dangling_images"),

  // ADB
  getAdbInfo: () => invoke<AdbInfo>("get_adb_info"),
  adbStartServer: () => invoke<ShellResult>("adb_start_server"),
  adbKillServer: () => invoke<ShellResult>("adb_kill_server"),
  adbRestartServer: () => invoke<ShellResult>("adb_restart_server"),
  adbConnect: (address: string) => invoke<ShellResult>("adb_connect", { address }),
  adbDisconnect: (address: string) => invoke<ShellResult>("adb_disconnect", { address }),
  adbReconnect: (serial: string) => invoke<ShellResult>("adb_reconnect", { serial }),
  adbAutoFix: () => invoke<ShellResult>("adb_auto_fix"),
  adbPair: (address: string, code: string) => invoke<ShellResult>("adb_pair", { address, code }),
  adbDiscover: () => invoke<WirelessDiscovery>("adb_discover"),
  adbTcpip: (serial: string, port: number) => invoke<ShellResult>("adb_tcpip", { serial, port }),

  // Scrcpy
  scrcpyStart: (serial: string, maxSize = 1080, bitRate = 8, extra = "--no-audio") =>
    invoke<ShellResult>("scrcpy_start", { serial, maxSize, bitRate, extra }),
  scrcpyStop: (serial: string) => invoke<ShellResult>("scrcpy_stop", { serial }),
  scrcpyRestart: (serial: string) => invoke<ShellResult>("scrcpy_restart", { serial }),
  scrcpyStatus: (serial: string) => invoke<string>("scrcpy_status", { serial }),
  scrcpyStartLayout: (
    serial: string,
    placement: ScrcpyWindowPlacement,
    maxSize = 1080,
    bitRate = 8,
    extra = "",
  ) =>
    invoke<ShellResult>("scrcpy_start_layout", {
      serial,
      maxSize,
      bitRate,
      extra,
      placement,
    }),
  scrcpyStartRecording: (serial: string, options: ScrcpyRecordingOptions) =>
    invoke<ShellResult>("scrcpy_start_recording", { serial, options }),
  scrcpyStopRecording: (serial: string) => invoke<ShellResult>("scrcpy_stop_recording", { serial }),
  scrcpyRecordingStatus: (serial: string) => invoke<string>("scrcpy_recording_status", { serial }),
  scrcpyStartCamera: (serial: string, options: ScrcpyCameraOptions) =>
    invoke<ShellResult>("scrcpy_start_camera", {
      serial,
      options: {
        ...options,
        outputPath: "",
        format: "mp4",
        audio: false,
        audioOnly: false,
        audioSource: "output",
        videoSource: "camera",
        timeLimitSecs: 0,
      },
    }),
  scrcpyStopCamera: (serial: string) => invoke<ShellResult>("scrcpy_stop_camera", { serial }),
  scrcpyCameraStatus: (serial: string) => invoke<string>("scrcpy_camera_status", { serial }),
  scrcpyStartInput: (serial: string, mode: ScrcpyInputMode, options: ScrcpyInputOptions) =>
    invoke<ShellResult>("scrcpy_start_input", { serial, mode, options }),
  scrcpyStopInput: (serial: string) => invoke<ShellResult>("scrcpy_stop_input", { serial }),
  scrcpyInputStatus: (serial: string) => invoke<string>("scrcpy_input_status", { serial }),
  scrcpyStreamStart: (serial: string, maxSize = 1080, bitRate = 8, extra = "") =>
    invoke<StreamSession>("scrcpy_stream_start", {
      serial,
      maxSize,
      bitRate,
      extra,
    }),
  scrcpyStreamStop: (serial: string) =>
    invoke<ShellResult>("scrcpy_stream_stop", { serial }),
  scrcpyStreamStatus: (serial: string) =>
    invoke<StreamSession>("scrcpy_stream_status", { serial }),
  recordingStart: (
    serial: string,
    mode: string,
    outputPath = "",
    cameraFacing = "back",
    cameraId = "",
    cameraAr = "",
    cameraHighSpeed = false,
    cameraSize = "",
    cameraFps = 30,
    timeLimit = 0,
    recordFormat = "",
    recordOrientation = "",
    cameraTorch = false,
    cameraZoom: number | null = null,
    gamepad = "",
  ) => invoke<RecordingSession>("recording_start", {
    serial,
    mode,
    outputPath,
    cameraFacing,
    cameraId,
    cameraAr,
    cameraHighSpeed,
    cameraSize,
    cameraFps,
    timeLimit,
    recordFormat,
    recordOrientation,
    cameraTorch,
    cameraZoom,
    gamepad,
  }),
  recordingStop: (serial: string) => invoke<ShellResult>("recording_stop", { serial }),
  recordingStatus: (serial: string) => invoke<RecordingSession>("recording_status", { serial }),
  gnirehtetInstall: (serial: string) => invoke<ShellResult>("gnirehtet_install", { serial }),
  gnirehtetStart: (serial: string, dns = "", relayPort = 31416, routes = "") =>
    invoke<GnirehtetSession>("gnirehtet_start", { serial, dns, relayPort, routes }),
  gnirehtetStop: (serial: string) => invoke<ShellResult>("gnirehtet_stop", { serial }),
  gnirehtetStatus: (serial: string) => invoke<GnirehtetSession>("gnirehtet_status", { serial }),
  gnirehtetRepair: (serial: string, dns = "", relayPort = 31416, routes = "") =>
    invoke<GnirehtetSession>("gnirehtet_repair", { serial, dns, relayPort, routes }),

  // System logs
  getLogs: (opts?: {
    source?: string;
    level?: string;
    keyword?: string;
    limit?: number;
  }) =>
    invoke<LogEntry[]>("get_system_logs", {
      source: opts?.source ?? null,
      level: opts?.level ?? null,
      keyword: opts?.keyword ?? null,
      limit: opts?.limit ?? 200,
    }),
  clearLogs: (alsoTodayFile = false) =>
    invoke("clear_system_logs", { alsoTodayFile }),
  exportLogs: (path: string, content?: string) =>
    invoke<string>("export_system_logs", { path, content: content ?? null }),
  appendLog: (level: string, source: string, message: string) =>
    invoke("append_log", { level, source, message }),

  // Settings
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings: AppSettings) =>
    invoke<AppSettings>("update_settings", { settings }),
  /** Full deviceId|serial → [tag, …] grouping record. */
  getDeviceTags: () => invoke<Record<string, string[]>>("get_device_tags"),
  /** Replace one device's tags; empty list clears (ungrouped). */
  setDeviceTags: (deviceId: string, tags: string[]) =>
    invoke<Record<string, string[]>>("set_device_tags", { deviceId, tags }),
  readConfigFile: (path: string) => invoke<string>("read_config_file", { path }),
  writeConfigFile: (path: string, content: string) => invoke<void>("write_config_file", { path, content }),
  revealInFolder: (path: string) => invoke<void>("reveal_in_folder", { path }),
  probeTool: (kind: "docker" | "adb" | "scrcpy" | "gnirehtet", path: string) =>
    invoke<ShellResult>("probe_tool", { kind, path }),

  // WSL binder kernel (Redroid) — switch / restore / verify only
  getWslKernelStatus: () => invoke<WslKernelStatus>("get_wsl_kernel_status"),
  switchWslKernel: (mode: "custom" | "default", apply = false) =>
    invoke<ShellResult>("switch_wsl_kernel", { mode, apply }),
  verifyWslBinder: () => invoke<ShellResult>("verify_wsl_binder"),
  optimizeAppArt: (serial: string, packageName: string, mode: ArtMode) =>
    invoke<ArtOptimizationResult>("optimize_app_art", {
      serial,
      package: packageName,
      mode,
    }),
};

/**
 * QEMU track service — thin wrappers over the `qemu-center` CLI bridge
 * commands (see src-tauri/src/services/qemu.rs). Experimental track; the
 * Docker track above remains the default runtime.
 */
export const QemuService = {
  /** Host readiness report (WHPX / QEMU / disk / tools). */
  doctor: () => invoke<QemuDoctorReport>("qemu_doctor"),
  /** step: "whpx" | "qemu" | "image" | "all" (long-running, up to 60 min). */
  setup: (step: "whpx" | "qemu" | "image" | "all", distro = "noble") =>
    invoke<QemuCliOutput>("qemu_setup", { step, distro }),
  vmList: () => invoke<QemuVmEntry[]>("qemu_vm_list"),
  vmCreate: (req: QemuVmCreateRequest) =>
    invoke<QemuCliOutput>("qemu_vm_create", { req }),
  vmStart: (name: string) => invoke<QemuCliOutput>("qemu_vm_start", { name }),
  vmStop: (name: string) => invoke<QemuCliOutput>("qemu_vm_stop", { name }),
  vmDelete: (name: string, purge = true) =>
    invoke<QemuCliOutput>("qemu_vm_delete", { name, purge }),
  /** Create an internal qcow2 snapshot of the node's disk (VM should be stopped). */
  vmSnapshot: (name: string, tag: string) =>
    invoke<QemuCliOutput>("qemu_vm_snapshot", { name, tag }),
  /** Apply a qcow2 internal snapshot — VM must be stopped (UI confirms). */
  vmRestore: (name: string, tag: string) =>
    invoke<QemuCliOutput>("qemu_vm_restore", { name, tag }),
  /** Poll guest SSH readiness; caller budgets timeoutSecs. */
  guestWait: (name: string, timeoutSecs: number) =>
    invoke<QemuCliOutput>("qemu_guest_wait", { name, timeoutSecs }),
  redroidCreate: (req: QemuRedroidCreateRequest) =>
    invoke<QemuCliOutput>("qemu_redroid_create", { req }),
  redroidUpgrade: (req: QemuRedroidCreateRequest) =>
    invoke<QemuCliOutput>("qemu_redroid_upgrade", { req }),
  redroidRestore: (vm: string, name: string) =>
    invoke<QemuCliOutput>("qemu_redroid_restore", { vm, name }),
  redroidList: (vm: string) =>
    invoke<QemuRedroidInstance[]>("qemu_redroid_list", { vm }),
  redroidStats: (vm: string, instance?: string) =>
    invoke<QemuRedroidRuntimeStats[]>("qemu_redroid_stats", {
      vm,
      instance: instance ?? null,
    }),
  runtimeMarkActivity: (instance: string, kind: string) =>
    invoke<void>("runtime_mark_activity", { instance, kind }),
  runtimeRequestStart: (vm: string, instance: string) =>
    invoke<RuntimeStartDecision>("runtime_request_start", { vm, instance }),
  runtimeReleaseIdle: (vm: string, instance: string) =>
    invoke<RuntimeIdleReleaseResult>("runtime_release_idle", { vm, instance }),
  adbList: () => invoke<QemuAdbMapping[]>("qemu_adb_list"),
  verify: (vm: string) => invoke<QemuVerifyReport>("qemu_verify", { vm }),
};
