export interface SystemStatus {
  dockerRunning: boolean;
  dockerVersion: string;
  adbRunning: boolean;
  adbVersion: string;
  onlineDevices: number;
  cpuUsage: number;
  memoryUsage: number;
  memoryTotalMb: number;
  memoryUsedMb: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  serial: string;
  androidVersion: string;
  online: boolean;
  cpu: string;
  ram: string;
  cpuUsage?: number;
  memoryUsage?: number;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
  resourceSource?: "container" | "android" | "";
  fps: number;
  adbStatus: string;
  scrcpyStatus: string;
  dockerStatus: string;
  ip: string;
  mac: string;
  resolution: string;
  dpi: string;
  containerId: string;
  image: string;
  startedAt: string;
  uptime: string;
  adbPort: number;
  scrcpyPort: number;
  dataVolume?: string;
}

export interface CreateInstanceRequest {
  name: string;
  androidVersion: string;
  cpu: string;
  ram: string;
  resolution: string;
  dpi: string;
  adbPort: number;
  scrcpyPort: number;
  image: string;
  installGapps?: boolean;
  gappsZip?: string;
  installMagisk?: boolean;
  installLsposed?: boolean;
  installShamiko?: boolean;
  spoofProfile?: string;
  hidePackages?: string[];
  waitAdb?: boolean;
}

export interface MagiskAssets {
  magiskDir: string;
  magiskOk: boolean;
  lsposedOk: boolean;
  shamikoOk: boolean;
  message?: string;
}

export interface RootModuleInfo {
  id: string;
  name: string;
  version: string;
  state: string;
}

export interface RootStatus {
  magisk: boolean;
  version: string;
  zygiskEnabled: boolean;
  /** Zygisk actually injecting the zygote (zygiskd running), not just the DB flag */
  zygiskActive: boolean;
  denylistEnforced: boolean;
  /** LSPosed daemon (lspd) running — module actually activated */
  lsposedActive: boolean;
  magiskApp: boolean;
  lsposedManager: boolean;
  /** Shamiko whitelist-mode marker; undefined when the module is absent */
  shamikoWhitelist?: boolean;
  modules: RootModuleInfo[];
  denylist: string[];
  props: Record<string, string>;
  presetLogTail: string;
  message?: string;
}

export interface LsposedScopeModule {
  pkg: string;
  enabled: boolean;
  scope: string[];
}

export interface LsposedScopeReport {
  modules: LsposedScopeModule[];
  message?: string;
}

export interface SuPolicyEntry {
  uid: number;
  package: string;
  /** "allow" | "deny" */
  policy: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  size: string;
  inUse: boolean;
  isRdc: boolean;
  containerName?: string;
  adbSerial?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  created: string;
  isRedroid: boolean;
}

export interface DockerInfo {
  running: boolean;
  version: string;
  images: DockerImage[];
  containers: DockerContainer[];
  cpuUsage: number;
  memoryUsage: number;
}

export interface AdbDevice {
  serial: string;
  state: string;
  product: string;
  model: string;
  device: string;
  transportId: string;
}

export interface AdbInfo {
  version: string;
  serverRunning: boolean;
  devices: AdbDevice[];
}

export interface AppInfo {
  packageName: string;
  label: string;
  versionName: string;
  versionCode: string;
  systemApp: boolean;
  enabled: boolean;
  apkPath: string;
  firstInstallTime: string;
  lastUpdateTime: string;
  size: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: string;
  permissions: string;
  modified: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  source: string;
  message: string;
}

export interface ShellResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScreenshotResult {
  success: boolean;
  path: string;
  base64: string;
  error?: string;
}

export type DeviceMonitorPreset = "inherit" | "sensitive" | "balanced" | "relaxed" | "custom";
export type MonitorAlertSeverity = "warning" | "critical";

export interface MonitorQuietHours {
  start: string;
  end: string;
}

export interface DeviceMonitorRule {
  preset: DeviceMonitorPreset;
  alertThreshold?: number;
  refreshIntervalSecs?: number;
  alertsEnabled?: boolean;
  warningAlertsEnabled?: boolean;
  criticalAlertsEnabled?: boolean;
  quietStart?: string;
  quietEnd?: string;
}

export interface AppSettings {
  theme: string;
  language: string;
  autoUpdate: boolean;
  logPath: string;
  screenshotPath: string;
  apkPath: string;
  proxy: string;
  dockerPath: string;
  adbPath: string;
  scrcpyPath: string;
  gappsZipPath?: string;
  installGapps?: boolean;
  lastCpu?: string;
  lastRam?: string;
  lastResolution?: string;
  lastDpi?: string;
  lastImage?: string;
  autoStartDeviceIds?: string[];
  createAutoStart?: boolean;
  createStayOnForm?: boolean;
  createWaitAdb?: boolean;
  resourceAlertThreshold: number;
  deviceRefreshIntervalSecs: number;
  deviceMonitorRules: Record<string, DeviceMonitorRule>;
}

export interface DashboardData {
  status: SystemStatus;
  devices: DeviceInfo[];
  recentLogs: LogEntry[];
  recentScreenshots: string[];
  recentApks: string[];
  notifications: string[];
}

/** WSL2 custom binder kernel (Redroid + Docker Desktop) */
export interface WslKernelStatus {
  wslAvailable: boolean;
  /** "custom" | "default" | "host" | "unknown" */
  mode: string;
  configuredKernel: string;
  customKernelPath: string;
  customKernelExists: boolean;
  customKernelSize: number;
  configSnapshotExists: boolean;
  liveKernelVersion: string;
  binderEnabled: boolean;
  dockerReadyHints: string[];
  message: string;
  scriptsDir: string;
  /** e.g. windows-x64, linux-arm64 */
  platform: string;
  os: string;
  arch: string;
  /** wsl-prebuilt-or-build | host-binder | unsupported */
  strategy: string;
  platformSupported: boolean;
  needsWslKernel: boolean;
  releaseAssetBzImage: string;
  releaseAssetConfig: string;
}

export type NavKey =
  | "dashboard"
  | "devices"
  | "docker"
  | "adb"
  | "apk"
  | "volumes"
  | "logs"
  | "settings";

export interface LanDevice {
  address: string;
  connected: boolean;
  model: string;
  message: string;
}

export interface LanScanResult {
  subnet: string;
  port: number;
  scanned: number;
  found: LanDevice[];
  connectedCount: number;
  durationMs: number;
  message: string;
}
