import type {
  DeviceMonitorPreset,
  DeviceMonitorRule,
  MonitorAlertSeverity,
  MonitorQuietHours,
} from "../types";

export type ResourceAlert = "cpu" | "memory" | "both" | null;

export interface MonitorPreferences {
  alertThreshold: number;
  refreshIntervalSecs: number;
}

export interface ResolvedDeviceMonitorPreferences extends MonitorPreferences {
  preset: DeviceMonitorPreset;
  alertsEnabled: boolean;
  warningAlertsEnabled: boolean;
  criticalAlertsEnabled: boolean;
  quietHours: MonitorQuietHours | null;
}

const DEVICE_MONITOR_PRESETS: Record<
  "sensitive" | "balanced" | "relaxed",
  MonitorPreferences
> = {
  sensitive: { alertThreshold: 65, refreshIntervalSecs: 5 },
  balanced: { alertThreshold: 80, refreshIntervalSecs: 10 },
  relaxed: { alertThreshold: 90, refreshIntervalSecs: 20 },
};

export function monitorCriticalThresholdFor(alertThreshold: number): number {
  const threshold = normalizeMonitorPreferences(alertThreshold, 10).alertThreshold;
  return Math.min(100, Math.max(90, threshold + 10));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const MONITOR_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeMonitorQuietHours(
  start?: string,
  end?: string,
): MonitorQuietHours | null {
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    !MONITOR_TIME_PATTERN.test(start) ||
    !MONITOR_TIME_PATTERN.test(end) ||
    start === end
  ) {
    return null;
  }
  return { start, end };
}

function monitorTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isWithinMonitorQuietHours(
  at: Date,
  quietHours: MonitorQuietHours | null,
): boolean {
  if (!(at instanceof Date) || Number.isNaN(at.getTime()) || !quietHours) return false;
  const normalized = normalizeMonitorQuietHours(quietHours.start, quietHours.end);
  if (!normalized) return false;

  const current = at.getHours() * 60 + at.getMinutes();
  const start = monitorTimeToMinutes(normalized.start);
  const end = monitorTimeToMinutes(normalized.end);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function shouldSuppressMonitorAlert(
  preferences: Pick<ResolvedDeviceMonitorPreferences, "alertsEnabled" | "quietHours">
    & Partial<Pick<ResolvedDeviceMonitorPreferences, "warningAlertsEnabled" | "criticalAlertsEnabled">>,
  at: Date,
  severity: MonitorAlertSeverity = "warning",
): boolean {
  const levelEnabled = severity === "critical"
    ? preferences.criticalAlertsEnabled !== false
    : preferences.warningAlertsEnabled !== false;
  return !preferences.alertsEnabled || !levelEnabled || isWithinMonitorQuietHours(at, preferences.quietHours);
}

export function resourceAlertSeverityFor(
  cpuUsage: number | null | undefined,
  memoryUsage: number | null | undefined,
  alertThreshold: number,
): MonitorAlertSeverity | null {
  const criticalThreshold = monitorCriticalThresholdFor(alertThreshold);
  const cpu = typeof cpuUsage === "number" && Number.isFinite(cpuUsage) ? cpuUsage : null;
  const memory = typeof memoryUsage === "number" && Number.isFinite(memoryUsage) ? memoryUsage : null;
  if ((cpu !== null && cpu >= criticalThreshold) || (memory !== null && memory >= criticalThreshold)) {
    return "critical";
  }
  const warningThreshold = normalizeMonitorPreferences(alertThreshold, 10).alertThreshold;
  if ((cpu !== null && cpu >= warningThreshold) || (memory !== null && memory >= warningThreshold)) {
    return "warning";
  }
  return null;
}

export function normalizeMonitorPreferences(
  alertThreshold?: number,
  refreshIntervalSecs?: number,
): MonitorPreferences {
  return {
    alertThreshold: Math.round(Math.min(100, Math.max(50, finiteOr(alertThreshold, 80)))),
    refreshIntervalSecs: Math.round(Math.min(60, Math.max(5, finiteOr(refreshIntervalSecs, 10)))),
  };
}

export function resolveDeviceMonitorPreferences(
  globalAlertThreshold?: number,
  globalRefreshIntervalSecs?: number,
  rule?: DeviceMonitorRule,
): ResolvedDeviceMonitorPreferences {
  const global = normalizeMonitorPreferences(globalAlertThreshold, globalRefreshIntervalSecs);
  const notificationPreferences = {
    alertsEnabled: rule?.alertsEnabled !== false,
    warningAlertsEnabled: rule?.warningAlertsEnabled !== false,
    criticalAlertsEnabled: rule?.criticalAlertsEnabled !== false,
    quietHours: normalizeMonitorQuietHours(rule?.quietStart, rule?.quietEnd),
  };
  if (
    !rule ||
    !(
      rule.preset === "inherit" ||
      rule.preset === "sensitive" ||
      rule.preset === "balanced" ||
      rule.preset === "relaxed" ||
      rule.preset === "custom"
    )
  ) {
    return {
      preset: "inherit",
      ...global,
      alertsEnabled: true,
      warningAlertsEnabled: true,
      criticalAlertsEnabled: true,
      quietHours: null,
    };
  }
  if (rule.preset === "inherit") {
    return { preset: "inherit", ...global, ...notificationPreferences };
  }
  if (rule.preset !== "custom") {
    return { preset: rule.preset, ...DEVICE_MONITOR_PRESETS[rule.preset], ...notificationPreferences };
  }
  const custom = normalizeMonitorPreferences(
    finiteOr(rule.alertThreshold, global.alertThreshold),
    finiteOr(rule.refreshIntervalSecs, global.refreshIntervalSecs),
  );
  return { preset: "custom", ...custom, ...notificationPreferences };
}

export function applyDeviceMonitorRule(
  rules: Record<string, DeviceMonitorRule> | undefined,
  deviceId: string,
  preferences: ResolvedDeviceMonitorPreferences,
): Record<string, DeviceMonitorRule> {
  const next = { ...(rules ?? {}) };
  const quietHours = normalizeMonitorQuietHours(
    preferences.quietHours?.start,
    preferences.quietHours?.end,
  );
  if (
    preferences.preset === "inherit" &&
    preferences.alertsEnabled &&
    preferences.warningAlertsEnabled &&
    preferences.criticalAlertsEnabled &&
    !quietHours
  ) {
    delete next[deviceId];
    return next;
  }
  const rule: DeviceMonitorRule = {
    preset: preferences.preset,
    alertsEnabled: preferences.alertsEnabled,
    warningAlertsEnabled: preferences.warningAlertsEnabled,
    criticalAlertsEnabled: preferences.criticalAlertsEnabled,
  };
  if (preferences.preset !== "inherit") {
    rule.alertThreshold = preferences.alertThreshold;
    rule.refreshIntervalSecs = preferences.refreshIntervalSecs;
  }
  if (quietHours) {
    rule.quietStart = quietHours.start;
    rule.quietEnd = quietHours.end;
  }
  next[deviceId] = rule;
  return next;
}

export function resourceAlertFor(
  cpuUsage: number | null | undefined,
  memoryUsage: number | null | undefined,
  alertThreshold: number,
): ResourceAlert {
  const threshold = normalizeMonitorPreferences(alertThreshold, 10).alertThreshold;
  const cpu = typeof cpuUsage === "number" && Number.isFinite(cpuUsage) && cpuUsage >= threshold;
  const memory =
    typeof memoryUsage === "number" && Number.isFinite(memoryUsage) && memoryUsage >= threshold;
  if (cpu && memory) return "both";
  if (cpu) return "cpu";
  if (memory) return "memory";
  return null;
}
