import type { MonitorAlertSeverity } from "../types";
import type { ResourceAlert } from "./monitorPreferences";

export type { ResourceAlert } from "./monitorPreferences";

export const MONITOR_ALERT_COOLDOWN_MS = 60_000;
export const MAX_MONITOR_ALERTS = 8;
export const MAX_MONITOR_ALERT_HISTORY = 50;
export const MONITOR_ALERT_STORAGE_KEY = "rdc.monitorAlerts";

export type MonitorAlertKind = Exclude<ResourceAlert, null>;
export type MonitorAlertTimeRange = "24h" | "7d" | "all";

export interface MonitorAlertFilter {
  deviceId: string;
  kind: MonitorAlertKind | "all";
  severity?: MonitorAlertSeverity | "all";
  timeRange: MonitorAlertTimeRange;
  dayStart?: number;
  query?: string;
}

export interface MonitorAlertSummary {
  total: number;
  cpu: number;
  memory: number;
  both: number;
  warning: number;
  critical: number;
}

export interface MonitorAlertTrendPoint {
  dayStart: number;
  warning: number;
  critical: number;
}

export interface MonitorAlertDeviceSummary {
  deviceId: string;
  deviceName: string;
  total: number;
  warning: number;
  critical: number;
  peakDayStart: number | null;
  peakCount: number;
  peakIsAnomaly: boolean;
}

export interface ResourceAlertTracker {
  active: ResourceAlert;
  lastEmittedAt: number | null;
}

export interface MonitorAlertState {
  kind: MonitorAlertKind;
  severity: MonitorAlertSeverity;
}

export interface MonitorAlertTracker {
  active: MonitorAlertState | null;
  lastEmittedAt: number | null;
}

export interface MonitorAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: Exclude<ResourceAlert, null>;
  createdAt: number;
  severity?: MonitorAlertSeverity;
  alertThreshold?: number;
}

export function evaluateMonitorAlert(
  previous: MonitorAlertTracker,
  current: MonitorAlertState | null,
  now: number,
  cooldownMs = MONITOR_ALERT_COOLDOWN_MS,
): { emit: boolean; tracker: MonitorAlertTracker } {
  if (!current) {
    return {
      emit: false,
      tracker: { active: null, lastEmittedAt: null },
    };
  }

  const changed =
    previous.active?.kind !== current.kind || previous.active?.severity !== current.severity;
  const cooldownElapsed =
    previous.lastEmittedAt === null || now - previous.lastEmittedAt >= Math.max(0, cooldownMs);
  const emit = changed || cooldownElapsed;

  return {
    emit,
    tracker: {
      active: current,
      lastEmittedAt: emit ? now : previous.lastEmittedAt,
    },
  };
}

export function evaluateResourceAlert(
  previous: ResourceAlertTracker,
  current: ResourceAlert,
  now: number,
  cooldownMs = MONITOR_ALERT_COOLDOWN_MS,
): { emit: boolean; tracker: ResourceAlertTracker } {
  if (!current) {
    return {
      emit: false,
      tracker: { active: null, lastEmittedAt: null },
    };
  }

  const changed = previous.active !== current;
  const cooldownElapsed =
    previous.lastEmittedAt === null || now - previous.lastEmittedAt >= Math.max(0, cooldownMs);
  const emit = changed || cooldownElapsed;

  return {
    emit,
    tracker: {
      active: current,
      lastEmittedAt: emit ? now : previous.lastEmittedAt,
    },
  };
}

export function appendMonitorAlert(
  alerts: MonitorAlert[],
  alert: MonitorAlert,
  limit = MAX_MONITOR_ALERTS,
): MonitorAlert[] {
  return [alert, ...alerts].slice(0, Math.max(1, limit));
}

export function parseStoredMonitorAlerts(raw: string | null): MonitorAlert[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is MonitorAlert => {
        if (!item || typeof item !== "object") return false;
        const alert = item as Partial<MonitorAlert>;
        return (
          typeof alert.id === "string" &&
          alert.id.length > 0 &&
          typeof alert.deviceId === "string" &&
          alert.deviceId.length > 0 &&
          typeof alert.deviceName === "string" &&
          (alert.kind === "cpu" || alert.kind === "memory" || alert.kind === "both") &&
          typeof alert.createdAt === "number" &&
          Number.isFinite(alert.createdAt) &&
          alert.createdAt >= 0
        );
      })
      .map((item) => {
        const threshold =
          typeof item.alertThreshold === "number" && Number.isFinite(item.alertThreshold)
            ? Math.round(Math.min(100, Math.max(50, item.alertThreshold)))
            : undefined;
        const severity: MonitorAlertSeverity = item.severity === "critical" ? "critical" : "warning";
        return {
          id: item.id,
          deviceId: item.deviceId,
          deviceName: item.deviceName,
          kind: item.kind,
          createdAt: item.createdAt,
          severity,
          ...(threshold === undefined ? {} : { alertThreshold: threshold }),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_MONITOR_ALERT_HISTORY);
  } catch {
    return [];
  }
}

export function clearMonitorAlertsBefore(
  alerts: MonitorAlert[],
  cutoff: number,
): MonitorAlert[] {
  return alerts.filter((alert) => alert.createdAt >= cutoff);
}

export function removeMonitorAlertsByIds(alerts: MonitorAlert[], ids: string[]): MonitorAlert[] {
  const selectedIds = new Set(ids);
  if (selectedIds.size === 0) return alerts;
  const next = alerts.filter((alert) => !selectedIds.has(alert.id));
  return next.length === alerts.length ? alerts : next;
}

export function summarizeMonitorAlerts(alerts: MonitorAlert[]): MonitorAlertSummary {
  return alerts.reduce<MonitorAlertSummary>(
    (summary, alert) => {
      summary.total += 1;
      summary[alert.kind] += 1;
      summary[alert.severity ?? "warning"] += 1;
      return summary;
    },
    { total: 0, cpu: 0, memory: 0, both: 0, warning: 0, critical: 0 },
  );
}

export function buildMonitorAlertTrend(
  alerts: MonitorAlert[],
  now: number,
  days = 7,
): MonitorAlertTrendPoint[] {
  const bucketCount = Number.isFinite(days) ? Math.max(1, Math.round(days)) : 7;
  const anchor = new Date(Number.isFinite(now) ? now : Date.now());
  anchor.setHours(0, 0, 0, 0);

  return Array.from({ length: bucketCount }, (_, index) => {
    const dayStart = new Date(anchor);
    dayStart.setDate(anchor.getDate() - (bucketCount - 1 - index));
    const nextDay = new Date(dayStart);
    nextDay.setDate(dayStart.getDate() + 1);
    const bucket = alerts.filter(
      (alert) => alert.createdAt >= dayStart.getTime() && alert.createdAt < nextDay.getTime(),
    );
    return {
      dayStart: dayStart.getTime(),
      warning: bucket.filter((alert) => (alert.severity ?? "warning") === "warning").length,
      critical: bucket.filter((alert) => alert.severity === "critical").length,
    };
  });
}

export function summarizeMonitorAlertsByDevice(
  alerts: MonitorAlert[],
  now: number,
  days = 7,
): MonitorAlertDeviceSummary[] {
  const summaries = new Map<string, MonitorAlertDeviceSummary>();
  alerts.forEach((alert) => {
    const current = summaries.get(alert.deviceId) ?? {
      deviceId: alert.deviceId,
      deviceName: alert.deviceName || alert.deviceId,
      total: 0,
      warning: 0,
      critical: 0,
      peakDayStart: null,
      peakCount: 0,
      peakIsAnomaly: false,
    };
    if (current.deviceName === current.deviceId && alert.deviceName) current.deviceName = alert.deviceName;
    current.total += 1;
    current[alert.severity ?? "warning"] += 1;
    summaries.set(alert.deviceId, current);
  });

  const trend = buildMonitorAlertTrend(alerts, now, days);
  summaries.forEach((summary) => {
    let activeDays = 0;
    let activeTotal = 0;
    trend.forEach((point) => {
      const nextDay = new Date(point.dayStart);
      nextDay.setDate(nextDay.getDate() + 1);
      const dailyCount = alerts.filter(
        (alert) =>
          alert.deviceId === summary.deviceId &&
          alert.createdAt >= point.dayStart &&
          alert.createdAt < nextDay.getTime(),
      ).length;
      if (dailyCount > 0) {
        activeDays += 1;
        activeTotal += dailyCount;
      }
      if (dailyCount >= summary.peakCount) {
        summary.peakCount = dailyCount;
        summary.peakDayStart = dailyCount > 0 ? point.dayStart : summary.peakDayStart;
      }
    });
    const activeAverage = activeDays > 0 ? activeTotal / activeDays : 0;
    summary.peakIsAnomaly = summary.peakCount >= 2 && summary.peakCount > activeAverage * 1.5;
  });

  return [...summaries.values()].sort(
    (a, b) =>
      Number(b.peakIsAnomaly) - Number(a.peakIsAnomaly) ||
      b.critical - a.critical ||
      b.total - a.total ||
      a.deviceName.localeCompare(b.deviceName),
  );
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeMonitorAlertsCsv(alerts: MonitorAlert[]): string {
  const rows = alerts.map((alert) =>
    [
      new Date(alert.createdAt).toISOString(),
      alert.deviceName,
      alert.deviceId,
      alert.kind,
      alert.severity ?? "warning",
      alert.alertThreshold === undefined ? "" : String(alert.alertThreshold),
    ]
      .map(csvField)
      .join(","),
  );
  return `\uFEFFtimestamp,device_name,device_id,resource,severity,alert_threshold${rows.length ? `\r\n${rows.join("\r\n")}` : ""}`;
}

export async function runConfirmedMonitorAlertCleanup(
  confirmAction: () => Promise<boolean>,
  cleanupAction: () => void,
): Promise<boolean> {
  if (!(await confirmAction())) return false;
  cleanupAction();
  return true;
}

export function filterMonitorAlerts(
  alerts: MonitorAlert[],
  filter: MonitorAlertFilter,
  now: number,
): MonitorAlert[] {
  const exactDay =
    typeof filter.dayStart === "number" && Number.isFinite(filter.dayStart)
      ? new Date(filter.dayStart)
      : null;
  exactDay?.setHours(0, 0, 0, 0);
  const exactDayStart = exactDay?.getTime() ?? null;
  const exactDayEnd =
    exactDayStart === null
      ? null
      : (() => {
          const nextDay = new Date(exactDayStart);
          nextDay.setDate(nextDay.getDate() + 1);
          return nextDay.getTime();
        })();
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const cutoff =
    exactDayStart !== null
      ? null
      : filter.timeRange === "24h"
      ? now - 24 * 60 * 60 * 1_000
      : filter.timeRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1_000
        : null;

  return alerts
    .filter((alert) => filter.deviceId === "all" || alert.deviceId === filter.deviceId)
    .filter((alert) => filter.kind === "all" || alert.kind === filter.kind)
    .filter(
      (alert) =>
        !filter.severity ||
        filter.severity === "all" ||
        (alert.severity ?? "warning") === filter.severity,
    )
    .filter(
      (alert) =>
        exactDayStart === null ||
        (exactDayEnd !== null && alert.createdAt >= exactDayStart && alert.createdAt < exactDayEnd),
    )
    .filter((alert) => {
      if (!query) return true;
      const severity = alert.severity ?? "warning";
      return [
        alert.deviceName,
        alert.deviceId,
        alert.kind,
        severity,
        severity === "critical" ? "critical alert 严重告警" : "warning alert 普通告警",
        alert.alertThreshold === undefined ? "" : String(alert.alertThreshold),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    })
    .filter((alert) => cutoff === null || alert.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function monitorAlertMessageKey(kind: MonitorAlertKind): string {
  if (kind === "cpu") return "detail.monitor.alert.resourceCpu";
  if (kind === "memory") return "detail.monitor.alert.resourceMemory";
  return "detail.monitor.alert.resourceBoth";
}

export function hasRecentMonitorAlert(
  alerts: MonitorAlert[],
  alert: MonitorAlert,
  cooldownMs = MONITOR_ALERT_COOLDOWN_MS,
): boolean {
  const cooldown = Math.max(0, cooldownMs);
  return alerts.some((existing) => {
    const elapsed = alert.createdAt - existing.createdAt;
    return (
      existing.deviceId === alert.deviceId &&
      existing.kind === alert.kind &&
      (existing.severity ?? "warning") === (alert.severity ?? "warning") &&
      elapsed >= 0 &&
      elapsed < cooldown
    );
  });
}
