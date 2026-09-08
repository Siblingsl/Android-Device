import type { DeviceMonitorPreset, DeviceMonitorRule } from "../types";

export type ResourceAlert = "cpu" | "memory" | "both" | null;

export interface MonitorPreferences {
  alertThreshold: number;
  refreshIntervalSecs: number;
}

export interface ResolvedDeviceMonitorPreferences extends MonitorPreferences {
  preset: DeviceMonitorPreset;
}

const DEVICE_MONITOR_PRESETS: Record<
  "sensitive" | "balanced" | "relaxed",
  MonitorPreferences
> = {
  sensitive: { alertThreshold: 65, refreshIntervalSecs: 5 },
  balanced: { alertThreshold: 80, refreshIntervalSecs: 10 },
  relaxed: { alertThreshold: 90, refreshIntervalSecs: 20 },
};

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  if (
    !rule ||
    !(
      rule.preset === "sensitive" ||
      rule.preset === "balanced" ||
      rule.preset === "relaxed" ||
      rule.preset === "custom"
    )
  ) {
    return { preset: "inherit", ...global };
  }
  if (rule.preset !== "custom") {
    return { preset: rule.preset, ...DEVICE_MONITOR_PRESETS[rule.preset] };
  }
  const custom = normalizeMonitorPreferences(
    finiteOr(rule.alertThreshold, global.alertThreshold),
    finiteOr(rule.refreshIntervalSecs, global.refreshIntervalSecs),
  );
  return { preset: "custom", ...custom };
}

export function applyDeviceMonitorRule(
  rules: Record<string, DeviceMonitorRule> | undefined,
  deviceId: string,
  preferences: ResolvedDeviceMonitorPreferences,
): Record<string, DeviceMonitorRule> {
  const next = { ...(rules ?? {}) };
  if (preferences.preset === "inherit") {
    delete next[deviceId];
    return next;
  }
  next[deviceId] = {
    preset: preferences.preset,
    alertThreshold: preferences.alertThreshold,
    refreshIntervalSecs: preferences.refreshIntervalSecs,
  };
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
