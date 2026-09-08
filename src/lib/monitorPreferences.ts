export type ResourceAlert = "cpu" | "memory" | "both" | null;

export interface MonitorPreferences {
  alertThreshold: number;
  refreshIntervalSecs: number;
}

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
