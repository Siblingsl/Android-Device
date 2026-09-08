import { AlertTriangle, CheckCircle2, CircleOff, RefreshCw, ServerCrash, WifiOff } from "lucide-react";
import { useI18n } from "../../i18n";
import type { DeviceInfo } from "../../types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { summarizeDeviceHealth, type DeviceHealthState } from "../../lib/deviceMonitor";

interface Props {
  device: DeviceInfo;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  refreshError: string | null;
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
