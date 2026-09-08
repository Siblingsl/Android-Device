import { AlertTriangle, Bell, CheckCircle2, CircleOff, RefreshCw, ServerCrash, WifiOff, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { DeviceInfo } from "../../types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { summarizeDeviceHealth, type DeviceHealthState } from "../../lib/deviceMonitor";
import type { ResourceSample } from "../../lib/resourceMetrics";
import { resourceAlertFor, type ResourceAlert } from "../../lib/monitorPreferences";
import { monitorAlertMessageKey, type MonitorAlert } from "../../lib/monitorAlerts";

interface Props {
  device: DeviceInfo;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  refreshError: string | null;
  metricHistory: ResourceSample[];
  alertThreshold: number;
  monitorAlerts: MonitorAlert[];
  onDismissMonitorAlert: (id: string) => void;
  onClearMonitorAlerts: () => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => void;
}

function stateIcon(state: DeviceHealthState) {
  if (state === "healthy") return <CheckCircle2 size={16} />;
  if (state === "offline") return <WifiOff size={16} />;
  if (state === "adb") return <AlertTriangle size={16} />;
  return <ServerCrash size={16} />;
}

export function DeviceHealthPanel({
  device,
  refreshing,
  lastUpdatedAt,
  refreshError,
  metricHistory,
  alertThreshold,
  monitorAlerts,
  onDismissMonitorAlert,
  onClearMonitorAlerts,
  autoRefresh,
  onAutoRefreshChange,
  onRefresh,
}: Props) {
  const { t } = useI18n();
  const health = summarizeDeviceHealth(device);
  const stateLabel = t(`detail.monitor.state.${health.state}`);
  const dockerReady = health.containerReady;
  const dockerValue = device.containerId
    ? device.dockerStatus || t("detail.monitor.unknown")
    : t("detail.monitor.notApplicable");
  const cpuUsage = typeof device.cpuUsage === "number" ? device.cpuUsage : null;
  const memoryUsage = typeof device.memoryUsage === "number" ? device.memoryUsage : null;
  const memoryValue =
    memoryUsage === null
      ? "—"
      : device.memoryTotalMb
        ? `${device.memoryUsedMb ?? 0} / ${device.memoryTotalMb} MB (${memoryUsage.toFixed(1)}%)`
        : `${memoryUsage.toFixed(1)}%`;
  const resourceSource =
    device.resourceSource === "container"
      ? t("detail.monitor.source.container")
      : device.resourceSource === "android"
        ? t("detail.monitor.source.android")
        : t("detail.monitor.source.none");
  const resourceAlert = resourceAlertFor(cpuUsage, memoryUsage, alertThreshold);
  const updatedLabel = lastUpdatedAt
    ? t("detail.monitor.updatedAt", { time: new Date(lastUpdatedAt).toLocaleTimeString() })
    : t("detail.monitor.notUpdated");

  const alertMessage = refreshError
    ? t("detail.monitor.refreshError", { msg: refreshError })
    : health.state === "offline"
      ? t("detail.monitor.alert.offline")
      : health.state === "adb"
        ? t("detail.monitor.alert.adb")
        : health.state === "container"
          ? t("detail.monitor.alert.container")
          : null;
  const resourceAlertMessage = resourceAlertMessageFor(resourceAlert, t, alertThreshold);

  return (
    <Card
      className="device-monitor"
      title={t("detail.monitor.title")}
      action={
        <div className="device-monitor-actions">
          <label className="device-monitor-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => onAutoRefreshChange(e.target.checked)}
            />
            {t("detail.monitor.autoRefresh")}
          </label>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={14} />}
            loading={refreshing}
            onClick={onRefresh}
          >
            {t("detail.monitor.refresh")}
          </Button>
        </div>
      }
    >
      <div className="device-monitor-summary">
        <span className={`device-monitor-state ${health.state}`}>
          {stateIcon(health.state)}
          {stateLabel}
        </span>
        <span className="muted">{updatedLabel}</span>
      </div>

      {alertMessage && (
        <div className={`notice device-monitor-alert ${refreshError ? "error" : "warn"}`} role="alert">
          {refreshError ? <CircleOff size={15} /> : <AlertTriangle size={15} />}
          <span>{alertMessage}</span>
        </div>
      )}

      {resourceAlertMessage && (
        <div className="notice device-monitor-alert warn" role="alert">
          <AlertTriangle size={15} />
          <span>{resourceAlertMessage}</span>
        </div>
      )}

      <MonitorAlertCenter
        alerts={monitorAlerts}
        threshold={alertThreshold}
        onDismiss={onDismissMonitorAlert}
        onClear={onClearMonitorAlerts}
      />

      <div className="device-monitor-runtime">
        <RuntimeMetric
          label={t("detail.monitor.runtime.cpu")}
          value={cpuUsage === null ? "—" : `${cpuUsage.toFixed(1)}%`}
          usage={cpuUsage}
          samples={metricHistory}
          sampleKey="cpuUsage"
          source={resourceSource}
          alertThreshold={alertThreshold}
        />
        <RuntimeMetric
          label={t("detail.monitor.runtime.memory")}
          value={memoryValue}
          usage={memoryUsage}
          samples={metricHistory}
          sampleKey="memoryUsage"
          source={resourceSource}
          alertThreshold={alertThreshold}
        />
      </div>

      <div className="device-monitor-grid">
        <MonitorMetric
          label={t("detail.monitor.metric.adb")}
          value={device.adbStatus || t("detail.monitor.unknown")}
          tone={health.adbReady ? "success" : "error"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.docker")}
          value={dockerValue}
          tone={dockerReady ? "success" : "error"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.android")}
          value={device.androidVersion || "—"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.resolution")}
          value={device.resolution || "—"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.cpu")}
          value={device.cpu || "—"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.memory")}
          value={device.ram || "—"}
        />
        <MonitorMetric
          label={t("detail.monitor.metric.uptime")}
          value={device.uptime || "—"}
        />
      </div>
    </Card>
  );
}

function MonitorAlertCenter({
  alerts,
  threshold,
  onDismiss,
  onClear,
}: {
  alerts: MonitorAlert[];
  threshold: number;
  onDismiss: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="device-monitor-notifications" aria-live="polite">
      <div className="device-monitor-notifications-head">
        <div className="device-monitor-notifications-title">
          <Bell size={14} />
          <span>{t("detail.monitor.notifications.title")}</span>
          <span className="badge warn">{alerts.length}</span>
        </div>
        {alerts.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("detail.monitor.notifications.clear")}
          </Button>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="device-monitor-notifications-empty">
          {t("detail.monitor.notifications.empty")}
        </div>
      ) : (
        <div className="device-monitor-notification-list">
          {alerts.map((alert) => (
            <div className="device-monitor-notification-item" key={alert.id}>
              <AlertTriangle size={14} />
              <div className="device-monitor-notification-content">
                <div className="device-monitor-notification-message">
                  {resourceAlertMessageFor(alert.kind, t, threshold)}
                </div>
                <div className="device-monitor-notification-time">
                  {t("detail.monitor.notifications.at", {
                    time: new Date(alert.createdAt).toLocaleTimeString(),
                  })}
                </div>
              </div>
              <button
                type="button"
                className="device-monitor-notification-dismiss"
                aria-label={t("detail.monitor.notifications.dismiss")}
                title={t("detail.monitor.notifications.dismiss")}
                onClick={() => onDismiss(alert.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function resourceAlertMessageFor(
  alert: ResourceAlert,
  t: (key: string, vars?: Record<string, string | number>) => string,
  threshold: number,
) {
  return alert ? t(monitorAlertMessageKey(alert), { threshold }) : null;
}

function RuntimeMetric({
  label,
  value,
  usage,
  samples,
  sampleKey,
  source,
  alertThreshold,
}: {
  label: string;
  value: string;
  usage: number | null;
  samples: ResourceSample[];
  sampleKey: "cpuUsage" | "memoryUsage";
  source: string;
  alertThreshold: number;
}) {
  const points = samples.slice(-12);
  const warning = usage !== null && usage >= alertThreshold;
  return (
    <div className={`device-monitor-runtime-card ${warning ? "warning" : ""}`}>
      <div className="device-monitor-runtime-head">
        <span className="device-monitor-label">{label}</span>
        <strong className={`device-monitor-runtime-value ${warning ? "warning" : ""}`}>{value}</strong>
      </div>
      <div className="device-monitor-runtime-source">{source}</div>
      <div className="device-monitor-trend" aria-label={label}>
        {points.length > 0 ? (
          points.map((point) => {
            const pointValue = point[sampleKey];
            const height = Math.max(6, Math.min(100, pointValue));
            return (
              <span
                key={`${point.at}-${sampleKey}`}
                className="device-monitor-trend-bar"
                style={{ height: `${height}%` }}
                title={`${pointValue.toFixed(1)}%`}
              />
            );
          })
        ) : (
          <span className="device-monitor-trend-empty">—</span>
        )}
      </div>
      {usage !== null && <div className="device-monitor-trend-scale">0% · 100%</div>}
    </div>
  );
}

function MonitorMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "error";
}) {
  return (
    <div className="device-monitor-metric">
      <div className="device-monitor-label">{label}</div>
      <div className={`device-monitor-value ${tone ?? ""}`}>{value}</div>
    </div>
  );
}
