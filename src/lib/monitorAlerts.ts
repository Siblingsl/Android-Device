import type { ResourceAlert } from "./monitorPreferences";

export type { ResourceAlert } from "./monitorPreferences";

export const MONITOR_ALERT_COOLDOWN_MS = 60_000;
export const MAX_MONITOR_ALERTS = 8;

export interface ResourceAlertTracker {
  active: ResourceAlert;
  lastEmittedAt: number | null;
}

export interface MonitorAlert {
  id: string;
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

export function appendMonitorAlert(alerts: MonitorAlert[], alert: MonitorAlert): MonitorAlert[] {
  return [alert, ...alerts].slice(0, MAX_MONITOR_ALERTS);
}
