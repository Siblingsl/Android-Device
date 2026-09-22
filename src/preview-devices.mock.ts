import type {
  AdbInfo,
  AppInfo,
  AppSettings,
  AuditCheck,
  BatteryState,
  CloakStatus,
  DeviceInfo,
  DockerInfo,
  DockerVolume,
  FileEntry,
  GeoCheck,
  LogEntry,
  QemuDoctorReport,
  QemuVerifyReport,
  SpoofProfileSummary,
  SystemStatus,
} from "./types";

const now = "2026-09-21T00:00:00.000Z";

export const MOCK_DEVICES: DeviceInfo[] = [
  {
    id: "6d706def",
    name: "6d706def",
    serial: "6d706def",
    adbPort: 5555,
    scrcpyPort: 0,
    ip: "—",
    online: false,
    adbStatus: "unauthorized",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "",
    cpu: "",
    ram: "",
    fps: 0,
    mac: "",
    resolution: "",
    dpi: "",
    startedAt: "",
    uptime: "",
    source: "adb",
  },
  {
    id: "redroid-14",
    name: "redroid14_x86_64",
    serial: "127.0.0.1:24500",
    adbPort: 24500,
    scrcpyPort: 0,
    ip: "127.0.0.1",
    online: true,
    adbStatus: "device",
    dockerStatus: "running",
    scrcpyStatus: "stopped",
    containerId: "9f8fa852d6a35b401",
    image: "redroid/redroid:13.0.0-latest",
    dataVolume: "rdc-redroid-14-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    fps: 60,
    mac: "02:42:ac:11:00:14",
    resolution: "1080x1920",
    dpi: "320",
    startedAt: now,
    uptime: "1h",
    source: "docker",
    batteryLevel: 86,
    batteryCharging: true,
    batteryTemperatureC: 31.6,
    batteryVoltageV: 4.1,
    batteryPowerSource: "AC",
  },
  {
    id: "2210132C",
    name: "2210132C",
    serial: "emulator-5554",
    adbPort: 5555,
    scrcpyPort: 0,
    ip: "emulator-5554",
    online: true,
    adbStatus: "device",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "14",
    cpu: "x86_64",
    ram: "8G",
    fps: 60,
    mac: "",
    resolution: "1080x1920",
    dpi: "420",
    startedAt: now,
    uptime: "30m",
    source: "emulator",
  },
  {
    id: "redroid-3",
    name: "redroid-3",
    serial: "127.0.0.1:5556",
    adbPort: 5556,
    scrcpyPort: 0,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "exited",
    scrcpyStatus: "stopped",
    containerId: "0af706be081f606b",
    image: "rdc-gapps:rdc-preset-redroid-redroid-13.0.0-latest-0af706be081f606b-7c704fe-6a8befd8",
    dataVolume: "rdc-redroid-3-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    fps: 0,
    mac: "02:42:ac:11:00:03",
    resolution: "1080x1920",
    dpi: "320",
    startedAt: "",
    uptime: "",
    source: "docker",
  },
  {
    id: "redroid-2",
    name: "redroid-2",
    serial: "127.0.0.1:5555",
    adbPort: 5555,
    scrcpyPort: 0,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "exited",
    scrcpyStatus: "stopped",
    containerId: "89fa852d6a35b401",
    image: "rdc-gapps:rdc-preset-redroid-redroid-13.0.0-latest-89fa852d6a35b401-b7c04fe-6a8befd8",
    dataVolume: "rdc-redroid-2-data",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "4G",
    fps: 0,
    mac: "02:42:ac:11:00:02",
    resolution: "1080x1920",
    dpi: "320",
    startedAt: "",
    uptime: "",
    source: "docker",
  },
  {
    id: "qemu-node-1",
    name: "node1-r13",
    serial: "127.0.0.1:24501",
    adbPort: 24501,
    scrcpyPort: 0,
    ip: "127.0.0.1",
    online: false,
    adbStatus: "disconnected",
    dockerStatus: "n/a",
    scrcpyStatus: "stopped",
    containerId: "",
    image: "",
    dataVolume: "",
    androidVersion: "13",
    cpu: "x86_64",
    ram: "6G",
    fps: 0,
    mac: "",
    resolution: "1080x1920",
    dpi: "320",
    startedAt: "",
    uptime: "",
    source: "qemu",
  },
];

const systemStatus: SystemStatus = {
  dockerRunning: true,
  dockerVersion: "Docker Desktop preview",
  adbRunning: true,
  adbVersion: "Android Debug Bridge preview",
  onlineDevices: MOCK_DEVICES.filter((device) => device.online).length,
  cpuUsage: 12,
  memoryUsage: 40,
  memoryTotalMb: 16384,
  memoryUsedMb: 6554,
};

const spoofProfiles: SpoofProfileSummary[] = [
  {
    id: "prof-pixel7",
    brand: "google",
    manufacturer: "Google",
    model: "Pixel 7",
    marketName: "Pixel 7",
    androidVersion: "13",
    securityPatch: "2024-01-05",
    fingerprint: "google/panther/panther:13/TQ1A.230205.002/9999999:user/release-keys",
    source: "builtin",
  },
  {
    id: "prof-capture-1",
    brand: "Xiaomi",
    manufacturer: "Xiaomi",
    model: "23127PN0CC",
    marketName: "小米 14",
    androidVersion: "14",
    securityPatch: "2024-02-01",
    fingerprint: "Xiaomi/23127PN0CC/23127PN0CC:14/UKQ1.231003.002/9999999:user/release-keys",
    source: "captured",
  },
];

const settings: AppSettings = {
  theme: "light",
  language: "zh-CN",
  autoUpdate: true,
  logPath: "",
  screenshotPath: "",
  apkPath: "",
  proxy: "",
  dockerPath: "docker",
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  gnirehtetPath: "gnirehtet",
  recordingPath: "",
  closeToTray: false,
  launchAtLogin: false,
  edgeHide: false,
  desktopShortcut: false,
  updateChannel: "stable",
  skippedUpdateVersion: "",
  gappsZipPath: "",
  installGapps: true,
  lastCpu: "2",
  lastRam: "2g",
  lastResolution: "1080x1920",
  lastDpi: "320",
  lastImage: "redroid/redroid:13.0.0-latest",
  autoStartDeviceIds: [],
  createAutoStart: false,
  createStayOnForm: false,
  createWaitAdb: true,
  resourceAlertThreshold: 80,
  deviceRefreshIntervalSecs: 10,
  deviceMonitorRules: {},
  runtimeIdleTimeoutMinutes: 30,
  runtimeKeepVmWarm: false,
  runtimeMaxParallelStarts: 1,
  runtimeProtectedInstanceIds: [],
  runtimeAutoReleaseIdleOnCritical: true,
  deviceTags: { "127.0.0.1:24500": ["云机"] },
};

const logs: LogEntry[] = [
  { id: "preview-1", timestamp: now, level: "INFO", source: "preview", message: "预览桥接已就绪" },
  { id: "preview-2", timestamp: now, level: "WARN", source: "preview", message: "真实设备连接需要人工确认" },
];

const files: FileEntry[] = [
  { name: "Download", path: "/sdcard/Download", isDir: true, size: "—", permissions: "drwxrwx--x", modified: now },
  { name: "device-info.txt", path: "/sdcard/device-info.txt", isDir: false, size: "128 B", permissions: "-rw-rw----", modified: now },
];

const apps: AppInfo[] = [
  {
    packageName: "com.android.settings",
    label: "Settings",
    versionName: "1.0",
    versionCode: "1",
    systemApp: true,
    enabled: true,
    apkPath: "/system/priv-app/Settings/Settings.apk",
    firstInstallTime: now,
    lastUpdateTime: now,
    size: "12 MB",
  },
  {
    packageName: "com.example.preview",
    label: "Preview App",
    versionName: "0.1.0",
    versionCode: "1",
    systemApp: false,
    enabled: true,
    apkPath: "/data/app/com.example.preview/base.apk",
    firstInstallTime: now,
    lastUpdateTime: now,
    size: "4 MB",
  },
];

const dockerInfo: DockerInfo = {
  running: true,
  version: "Docker Desktop preview",
  cpuUsage: 12,
  memoryUsage: 40,
  images: [
    { id: "image-preview", repository: "redroid/redroid", tag: "13.0.0-latest", size: "1.2 GB", created: now },
  ],
  containers: [
    {
      id: "9f8fa852d6a35b401",
      name: "redroid14_x86_64",
      image: "redroid/redroid:13.0.0-latest",
      status: "Up 1 hour",
      ports: "0.0.0.0:24500->5555/tcp",
      created: now,
      isRedroid: true,
    },
  ],
};

const volumes: DockerVolume[] = [
  { name: "rdc-redroid-14-data", driver: "local", mountpoint: "/var/lib/docker/volumes/rdc-redroid-14-data", size: "2 GB", inUse: true, isRdc: true, containerName: "redroid14_x86_64", adbSerial: "127.0.0.1:24500" },
  { name: "rdc-redroid-3-data", driver: "local", mountpoint: "/var/lib/docker/volumes/rdc-redroid-3-data", size: "1 GB", inUse: false, isRdc: true, containerName: "redroid-3", adbSerial: "127.0.0.1:5556" },
];

const ok = (stdout = "ok") => ({ success: true, stdout, stderr: "", exitCode: 0 });

export function mockInvoke(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "list_devices_unified":
    case "list_devices":
      return MOCK_DEVICES;
    case "list_spoof_profiles":
      return spoofProfiles;
    case "spoof_profile_usage":
      return [{ profileId: "prof-pixel7", count: 2 }];
    case "get_settings":
      return settings;
    case "get_dashboard":
      return { status: systemStatus, devices: MOCK_DEVICES, recentLogs: logs, recentScreenshots: [], recentApks: [], notifications: [] };
    case "get_system_status":
      return systemStatus;
    case "get_device": {
      const id = String(args?.id ?? "");
      return MOCK_DEVICES.find((device) => device.id === id) ?? MOCK_DEVICES[0];
    }
    case "get_device_telemetry":
      return { serial: String(args?.serial ?? ""), batteryLevel: 86, batteryTemperature: "31.6", powerState: "AC", voltage: "4.1V", updatedAt: now, status: "ok", message: "" };
    case "list_files":
    case "list_files_result":
      return files;
    case "storage_info":
      return "Used: 12 GB\nFree: 20 GB\nTotal: 32 GB";
    case "list_apps":
    case "list_apps_result":
      return apps;
    case "get_logcat":
      return "01-01 00:00:00.000 I/Preview: logcat preview ready";
    case "get_system_logs":
      return logs;
    case "get_root_status":
      return { magisk: false, version: "", zygiskEnabled: false, zygiskActive: false, denylistEnforced: false, lsposedActive: false, magiskApp: false, lsposedManager: false, modules: [], denylist: [], props: {}, presetLogTail: "", message: "预览环境未连接真实设备" };
    case "get_lsposed_scope":
      return { modules: [] };
    case "get_su_policies":
      return [];
    case "get_spoof_identity":
      return { brand: "google", model: "sdk_gphone64_x86_64", marketName: "", fingerprint: "", device: "" };
    case "get_magisk_assets":
      return { magiskDir: "", magiskOk: true, lsposedOk: true, shamikoOk: true };
    case "get_battery_state":
      return { level: 86, status: 2, charging: true } satisfies BatteryState;
    case "get_cloak_status":
      return { installed: false, enabled: false, scopeCount: 0 } satisfies CloakStatus;
    case "geo_consistency_check":
      return { profileId: args?.profileId == null ? null : String(args.profileId), deviceTimezone: "Asia/Shanghai", deviceLocale: "zh-CN", issues: [], consistent: true } satisfies GeoCheck;
    case "adversarial_audit":
      return { serial: String(args?.serial ?? ""), profileId: args?.profileId == null ? null : String(args.profileId), ranAt: now, message: "预览审计结果", checks: [{ id: "preview", category: "preview", verdict: "unknown", detail: "真实设备审计需要人工确认" }] satisfies AuditCheck[] };
    case "get_device_proxy_status":
      return { httpProxy: "", original: "", transparentRunning: false, message: "" };
    case "scrcpy_status":
    case "scrcpy_recording_status":
    case "scrcpy_camera_status":
    case "scrcpy_input_status":
      return "stopped";
    case "gnirehtet_status":
      return { serial: String(args?.serial ?? ""), status: "stopped", message: "", relay: "", installed: false };
    case "list_volumes":
      return volumes;
    case "get_adb_info":
      return { version: "Android Debug Bridge preview", serverRunning: true, devices: MOCK_DEVICES.filter((device) => device.online).map((device) => ({ serial: device.serial, state: device.adbStatus, product: "redroid", model: device.name, device: device.name, transportId: "1" })) } satisfies AdbInfo;
    case "adb_local_subnet":
      return "192.168.1.0/24";
    case "adb_lan_scan":
      return { subnet: String(args?.subnet ?? "192.168.1.0/24"), port: Number(args?.port ?? 5555), scanned: 0, found: [], connectedCount: 0, durationMs: 1, message: "预览环境未执行局域网扫描" };
    case "refresh_docker_info":
    case "get_docker_info":
      return dockerInfo;
    case "get_wsl_kernel_status":
      return { wslAvailable: false, mode: "unknown", configuredKernel: "", customKernelPath: "", customKernelExists: false, customKernelSize: 0, configSnapshotExists: false, liveKernelVersion: "", binderEnabled: false, dockerReadyHints: [], message: "预览环境未检测 WSL", scriptsDir: "", platform: "windows-x64", os: "windows", arch: "x64", strategy: "unsupported", platformSupported: false, needsWslKernel: false, releaseAssetBzImage: "", releaseAssetConfig: "" };
    case "get_local_gapps_path":
      return "";
    case "path_exists":
      return false;
    case "get_create_stage":
      return "";
    case "next_free_adb_port":
      return 24502;
    case "check_instance_name":
    case "check_adb_port":
      return false;
    case "authorization_status":
      return { status: "not_configured", detail: "预览环境未配置授权" };
    case "get_device_tags":
      return settings.deviceTags ?? {};
    case "read_runtime_resource_snapshot":
      return { capturedAt: now, hostTotalBytes: null, hostAvailableBytes: null, qemuPrivateBytes: null, qemuWorkingSetBytes: null, wslPrivateBytes: null, vmMemoryMiB: null, vmVcpus: null, instanceMemoryLimitBytes: null, instanceMemoryCurrentBytes: null, instanceMemoryPeakBytes: null, instanceOomKills: null, bootCompleted: null, appReadyMs: null, source: "host" };
    case "qemu_doctor":
      return { stateDir: "", checks: [{ id: "preview", title: "预览环境", status: "unknown", detail: "预览环境未检查 QEMU", fix: "" }] } satisfies QemuDoctorReport;
    case "qemu_vm_list":
    case "qemu_adb_list":
      return [];
    case "qemu_redroid_list":
    case "qemu_redroid_stats":
      return [];
    case "qemu_verify":
      return { vm: String(args?.vm ?? ""), checks: [] } satisfies QemuVerifyReport;
    case "authorization_register":
      return { clientId: "preview", deviceId: "preview", status: "not_configured" };
    case "qemu_setup":
    case "qemu_vm_create":
    case "qemu_vm_start":
    case "qemu_vm_set_memory":
    case "qemu_vm_memory_reclaim":
    case "qemu_vm_stop":
    case "qemu_vm_delete":
    case "qemu_vm_snapshot":
    case "qemu_vm_restore":
    case "qemu_guest_wait":
    case "qemu_redroid_create":
    case "qemu_redroid_upgrade":
    case "qemu_redroid_restore":
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    default:
      return ok();
  }
}
