import type { ResourceAlert } from "./monitorPreferences";

export type { ResourceAlert } from "./monitorPreferences";

export const MONITOR_ALERT_COOLDOWN_MS = 60_000;
export const MAX_MONITOR_ALERTS = 8;
export const MAX_MONITOR_ALERT_HISTORY = 50;

export type MonitorAlertKind = Exclude<ResourceAlert, null>;
export type MonitorAlertTimeRange = "24h" | "7d" | "all";

export interface MonitorAlertFilter {
  deviceId: string;
  kind: MonitorAlertKind | "all";
  timeRange: MonitorAlertTimeRange;
}

export interface ResourceAlertTracker {
  active: ResourceAlert;
  lastEmittedAt: number | null;
}

export interface MonitorAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: Exclude<ResourceAlert, null>;
  createdAt: number;
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

export function filterMonitorAlerts(
  alerts: MonitorAlert[],
  filter: MonitorAlertFilter,
  now: number,
): MonitorAlert[] {
  const cutoff =
    filter.timeRange === "24h"
      ? now - 24 * 60 * 60 * 1_000
      : filter.timeRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1_000
        : null;

  return alerts
    .filter((alert) => filter.deviceId === "all" || alert.deviceId === filter.deviceId)
    .filter((alert) => filter.kind === "all" || alert.kind === filter.kind)
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
      elapsed >= 0 &&
      elapsed < cooldown
    );
  });
}
