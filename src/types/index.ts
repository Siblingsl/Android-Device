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
  /** Effective spoofed model from ro.product.model (may differ from the container name). */
  spoofedModel?: string;
  /** Origin track of this row (unified list only): "docker" | "adb" | "qemu". */
  source?: string;
  /** QEMU track only: the owning VM node name. */
  qemuVm?: string;
  /** QEMU track only: the redroid instance name inside the node. */
  qemuInstance?: string;
  batteryLevel?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryVoltageV?: number;
  batteryPowerSource?: string;
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
  /** Built-in spoof profile id; takes precedence over spoofProfile when set. */
  spoofProfileId?: string;
  /** Spoof ro.product.cpu.abilist* to arm64-v8a (unsafe on x86_64 without a translator). */
  spoofAbilist?: boolean;
  hidePackages?: string[];
  waitAdb?: boolean;
  /** Install the DeviceCloak LSPosed module after first boot and push its config. */
  installCloak?: boolean;
  /** L3 trace cleansing: fake /proc/cpuinfo + /proc/version bind mounts and
   *  a systemd-style cgroup parent. Defaults to true on both sides. */
  cleanTraces?: boolean;
  /** GPU passthrough: androidboot.redroid_gpu_mode=host + --device /dev/dri.
   *  Requires the host to expose GPU nodes (native Linux or a WSL2 kernel
   *  with GPU-PV); otherwise docker run itself fails. */
  gpuPassthrough?: boolean;
}

/** One row of the spoof-profile usage census (docker label rdc.spoof-profile). */
export interface SpoofProfileUsage {
  profileId: string;
  count: number;
}

/** Per-instance network egress state ("每实例住宅代理分流"). */
export interface DeviceProxyStatus {
  httpProxy: string;
  original: string;
  transparentRunning: boolean;
  message?: string;
}

export interface MagiskAssets {
  magiskDir: string;
  magiskOk: boolean;
  lsposedOk: boolean;
  shamikoOk: boolean;
  message?: string;
}

export interface SpoofProfileSummary {
  id: string;
  brand: string;
  manufacturer: string;
  model: string;
  marketName: string;
  androidVersion: string;
  securityPatch: string;
  fingerprint: string;
  notes?: string;
  /** "builtin" | "captured" */
  source?: string;
}

export interface CloakStatus {
  installed: boolean;
  enabled: boolean;
  scopeCount: number;
  configPushed?: boolean;
  /** Native Zygisk companion (rdc_nativecloak) installed under /data/adb/modules. */
  nativeInstalled?: boolean;
  message?: string;
}

/** Simulated battery state (BatteryManager status: 2/3/4/5). */
export interface BatteryState {
  level: number;
  status: number;
  charging: boolean;
}

/** One row of the adversarial self-audit checklist. */
export interface AuditCheck {
  id: string;
  category: string;
  /** "pass" | "fail" | "unknown" */
  verdict: string;
  detail: string;
}

export interface AdversarialAudit {
  serial: string;
  profileId?: string | null;
  ranAt: string;
  message?: string;
  checks: AuditCheck[];
}

/** One inconsistency found by the geo-consistency check. */
export interface GeoIssue {
  /** timezoneMismatch | timezoneCountryMismatch | localeMismatch | proxyCountryMismatch | noGeoData */
  code: string;
  message: string;
}

/** Result of the geo-consistency check for one device + profile. */
export interface GeoCheck {
  profileId?: string | null;
  deviceTimezone: string;
  deviceLocale: string;
  issues: GeoIssue[];
  consistent: boolean;
}

export interface SpoofIdentity {
  brand: string;
  model: string;
  marketName: string;
  fingerprint: string;
  device: string;
  matchedProfileId?: string;
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

/** Read-only Docker/QEMU metrics carried by an instance snapshot. */
export interface RuntimeMetrics {
  cpuQuotaCores: number | null;
  cpuUnlimited: boolean | null;
  memoryQuotaBytes: number | null;
  memoryUnlimited: boolean | null;
  diskBytes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  created: string;
  isRedroid: boolean;
  metrics?: RuntimeMetrics | null;
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

export type FileTransferDirection = "upload" | "download";
export type FileTransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface FileTransferProgress {
  operationId: string;
  direction: FileTransferDirection;
  status: FileTransferStatus;
  bytesTransferred: number | null;
  totalBytes: number | null;
  percent: number | null;
  message: string;
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

export type AutomationStepKind =
  | "tap"
  | "swipe"
  | "longPress"
  | "text"
  | "key"
  | "shell"
  | "wait"
  | "screenshot"
  | "record"
  | "launch"
  | "install"
  | "imageMatch"
  | "if"
  | "loop";

export type AutomationStepValue = string | number | boolean | string[];

export interface AutomationStep {
  id: string;
  kind: AutomationStepKind;
  label: string;
  enabled: boolean;
  continueOnError?: boolean;
  beforeDelayMs?: number;
  afterDelayMs?: number;
  params: Record<string, AutomationStepValue>;
}

export interface AutomationScript {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  tags: string[];
  variables: Record<string, string>;
  steps: AutomationStep[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export type AutomationRunStatus = "completed" | "failed" | "cancelled";

export interface AutomationRunLog {
  stepId: string;
  label: string;
  status: "completed" | "failed" | "skipped";
  message?: string;
  startedAt: string;
  finishedAt: string;
}

export interface AutomationRunResult {
  status: AutomationRunStatus;
  completedSteps: number;
  logs: AutomationRunLog[];
}

export interface AutomationBatchDeviceResult {
  serial: string;
  result: AutomationRunResult;
}

export interface AutomationBatchResult {
  status: AutomationRunStatus;
  results: AutomationBatchDeviceResult[];
}

export type ScrcpyRecordingFormat = "mp4" | "mkv";
export type ScrcpyVideoSource = "display" | "camera";
export type ScrcpyCameraFacing = "front" | "back" | "external";

export interface ScrcpyCameraOptions {
  cameraId: string;
  cameraSize: string;
  cameraAr: string;
  cameraFps: number;
  cameraFacing: ScrcpyCameraFacing;
  cameraTorch: boolean;
  cameraZoom: number;
}

export type ScrcpyInputMode = "uhid" | "otg";

export interface ScrcpyInputOptions {
  keyboard: boolean;
  mouse: boolean;
  gamepad: boolean;
}

export interface ScrcpyWindowPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScrcpyRecordingOptions extends ScrcpyCameraOptions {
  outputPath: string;
  format: ScrcpyRecordingFormat;
  audio: boolean;
  audioOnly: boolean;
  audioSource: "output" | "playback" | "mic";
  videoSource: ScrcpyVideoSource;
  timeLimitSecs: number;
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

export interface DeviceTelemetry {
  serial: string;
  batteryLevel: number;
  batteryTemperature: string;
  powerState: string;
  voltage: string;
  updatedAt: string;
  status: string;
  message: string;
}

export interface StreamSession {
  serial: string;
  status: "running" | "stopped" | "error";
  url: string;
  port: number;
  message: string;
}

export interface TerminalSession {
  id: string;
  kind: "device" | "local" | string;
  serial: string;
  status: "running" | "stopped" | "error";
  output: string;
  cols: number;
  rows: number;
  message: string;
}

export interface RecordingSession {
  serial: string;
  mode: string;
  status: "running" | "stopped" | "error";
  outputPath: string;
  message: string;
}

export interface GnirehtetSession {
  serial: string;
  status: "running" | "stopped" | "error";
  message: string;
  relay: string;
  installed: boolean;
}

export interface AppSettings {
  /** "light" | "dark" | null (= follow the system via prefers-color-scheme). */
  theme?: string | null;
  language: string;
  autoUpdate: boolean;
  logPath: string;
  screenshotPath: string;
  apkPath: string;
  proxy: string;
  dockerPath: string;
  adbPath: string;
  scrcpyPath: string;
  gnirehtetPath?: string;
  recordingPath?: string;
  closeToTray?: boolean;
  launchAtLogin?: boolean;
  edgeHide?: boolean;
  desktopShortcut?: boolean;
  updateChannel?: "stable" | "beta";
  skippedUpdateVersion?: string;
  gappsZipPath?: string;
  installGapps?: boolean;
  lastCpu?: string;
  lastRam?: string;
  lastResolution?: string;
  lastDpi?: string;
  lastImage?: string;
  lastSpoofProfileId?: string;
  autoStartDeviceIds?: string[];
  createAutoStart?: boolean;
  createStayOnForm?: boolean;
  createWaitAdb?: boolean;
  /** Local tun2socks binary for per-instance transparent proxy takeover. */
  tun2socksPath?: string;
  /** Apply the simulated battery curve while detail pages are open (default true). */
  batteryAutoRefresh?: boolean | null;
  /** Preferred runtime track: "docker" (default) | "qemu". Preference only —
   * the QEMU track stays experimental until its verify report is all-green. */
  defaultTrack?: string;
  resourceAlertThreshold: number;
  deviceRefreshIntervalSecs: number;
  deviceMonitorRules: Record<string, DeviceMonitorRule>;
  /** Per-device grouping tags: deviceId|serial → tag names (tags ARE groups). */
  deviceTags?: Record<string, string[]> | null;
}

export interface DashboardData {
  status: SystemStatus;
  devices: DeviceInfo[];
  recentLogs: LogEntry[];
  recentScreenshots: string[];
  recentApks: string[];
  notifications: string[];
}

/** One row of the Dashboard first-use readiness checklist. */
export interface ReadinessItem {
  /** docker | adb | scrcpy | whpx | qemu-bin | cloud-image | android-image | abi | gapps */
  id: string;
  title: string;
  done: boolean;
  /** What to do when not done (rendered verbatim from the backend). */
  hint: string;
  /** Frontend route the "go fix" button navigates to. */
  cta: string;
  /** Newer backends distinguish actionable, unsupported and unknown probes. */
  status?: "ready" | "action_required" | "unsupported" | "unknown";
  /** shared | docker | qemu */
  track?: "shared" | "docker" | "qemu";
  /** Concrete probe result or compatibility explanation. */
  detail?: string;
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

export interface WirelessDiscovery {
  status: string;
  services: string[];
  message: string;
}

export type QueueItemStatus = "fulfilled" | "rejected" | "cancelled";

export type QueueItemResult<TItem, TValue> =
  | { item: TItem; status: "fulfilled"; value: TValue }
  | { item: TItem; status: "rejected"; reason: string }
  | { item: TItem; status: "cancelled" };

export interface QueueResult<TItem, TValue> {
  results: Array<QueueItemResult<TItem, TValue>>;
  cancelled: boolean;
}

export interface QueueHandle<TItem, TValue> {
  done: Promise<QueueResult<TItem, TValue>>;
  cancel: () => void;
}

// ---- QEMU track (qemu-center CLI bridge) ----

export interface QemuCliOutput {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface QemuDoctorCheck {
  id: string;
  title: string;
  /** "ok" | "fail" | "unknown" */
  status: string;
  detail: string;
  fix: string;
}

export interface QemuDoctorReport {
  stateDir: string;
  checks: QemuDoctorCheck[];
}

export interface QemuAdbAssignment {
  instance: string;
  port: number;
  serial: string;
}

export interface QemuVmEntry {
  name: string;
  vcpus: number;
  memMib: number;
  accel: string;
  sshHostPort: number;
  adbPorts: number[];
  adbAssignments: QemuAdbAssignment[];
  /** qcow2 internal snapshot tags registered in state.json. */
  snapshots?: string[];
}

export interface QemuVerifyCheck {
  id: string;
  title: string;
  /** "PASS" | "FAIL" | "UNTESTED" */
  verdict: string;
  detail: string;
}

export interface QemuVerifyReport {
  vm: string;
  container?: string | null;
  checks: QemuVerifyCheck[];
}

export interface QemuRedroidInstance {
  instance: string;
  container: string;
  port: number;
  serial: string;
  status: string;
  androidVersion?: string;
  image?: string;
  rollbackAvailable?: boolean;
  metrics?: RuntimeMetrics | null;
}

export interface QemuAdbMapping {
  serial: string;
  vm: string;
  instance: string;
}

export interface QemuVmCreateRequest {
  name: string;
  /** Empty/absent → backend resolves the default downloaded cloud image. */
  imagePath?: string;
  cpus: number;
  memMib: number;
  diskGib: number;
  adbPortCount: number;
  autoSetup: boolean;
}

export interface QemuRedroidCreateRequest {
  vm: string;
  name: string;
  cpus: number;
  memoryMib: number;
  width: number;
  height: number;
  dpi: number;
  image?: string;
  androidVersion?: string;
  installGapps?: boolean;
  gappsZip?: string;
  installMagisk?: boolean;
  installLsposed?: boolean;
  installShamiko?: boolean;
  installCloak?: boolean;
  installNativeCloak?: boolean;
  nativeCloakZip?: string;
  moduleZips?: string[];
  spoofProfileId?: string;
  spoofProfile?: string;
  spoofAbilist?: boolean;
  hidePackages?: string[];
  cleanTraces?: boolean;
}
