import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CircleOff,
  RefreshCw,
  ServerCrash,
  SlidersHorizontal,
  WifiOff,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import type {
  DeviceInfo,
  DeviceMonitorPreset,
  MonitorQuietHours,
} from "../../types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { summarizeDeviceHealth, type DeviceHealthState } from "../../lib/deviceMonitor";
import type { ResourceSample } from "../../lib/resourceMetrics";
import {
  normalizeMonitorQuietHours,
  resourceAlertFor,
  type ResourceAlert,
} from "../../lib/monitorPreferences";
import { monitorAlertMessageKey, type MonitorAlert } from "../../lib/monitorAlerts";

interface Props {
  device: DeviceInfo;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  refreshError: string | null;
  metricHistory: ResourceSample[];
  alertThreshold: number;
  refreshIntervalSecs: number;
  monitorPreset: DeviceMonitorPreset;
  alertsEnabled: boolean;
  warningAlertsEnabled: boolean;
  criticalAlertsEnabled: boolean;
  quietHours: MonitorQuietHours | null;
  monitorRuleSaving: boolean;
  onMonitorRuleChange: (
    preset: DeviceMonitorPreset,
    alertThreshold: number,
    refreshIntervalSecs: number,
    alertsEnabled: boolean,
    warningAlertsEnabled: boolean,
    criticalAlertsEnabled: boolean,
    quietHours: MonitorQuietHours | null,
  ) => Promise<boolean>;
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
  refreshIntervalSecs,
  monitorPreset,
  alertsEnabled,
  warningAlertsEnabled,
  criticalAlertsEnabled,
  quietHours,
  monitorRuleSaving,
  onMonitorRuleChange,
  monitorAlerts,
  onDismissMonitorAlert,
  onClearMonitorAlerts,
  autoRefresh,
  onAutoRefreshChange,
  onRefresh,
}: Props) {
  const { t } = useI18n();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [draftPreset, setDraftPreset] = useState<DeviceMonitorPreset>(monitorPreset);
  const [customThreshold, setCustomThreshold] = useState(alertThreshold);
  const [customRefreshInterval, setCustomRefreshInterval] = useState(refreshIntervalSecs);
  const [draftAlertsEnabled, setDraftAlertsEnabled] = useState(alertsEnabled);
  const [draftWarningAlertsEnabled, setDraftWarningAlertsEnabled] = useState(warningAlertsEnabled);
  const [draftCriticalAlertsEnabled, setDraftCriticalAlertsEnabled] = useState(criticalAlertsEnabled);
  const [draftQuietStart, setDraftQuietStart] = useState(quietHours?.start ?? "");
  const [draftQuietEnd, setDraftQuietEnd] = useState(quietHours?.end ?? "");
  const [quietHoursError, setQuietHoursError] = useState<string | null>(null);
  useEffect(() => {
    setDraftPreset(monitorPreset);
    setCustomThreshold(alertThreshold);
    setCustomRefreshInterval(refreshIntervalSecs);
    setDraftAlertsEnabled(alertsEnabled);
    setDraftWarningAlertsEnabled(warningAlertsEnabled);
    setDraftCriticalAlertsEnabled(criticalAlertsEnabled);
    setDraftQuietStart(quietHours?.start ?? "");
    setDraftQuietEnd(quietHours?.end ?? "");
    setQuietHoursError(null);
  }, [
    alertThreshold,
    alertsEnabled,
    criticalAlertsEnabled,
    monitorPreset,
    quietHours?.end,
    quietHours?.start,
    refreshIntervalSecs,
    warningAlertsEnabled,
  ]);

  const saveDraftPolicy = (
    preset: DeviceMonitorPreset,
    threshold: number,
    interval: number,
    resetPresetOnFailure = false,
  ) => {
    const hasQuietHoursInput = Boolean(draftQuietStart || draftQuietEnd);
    const nextQuietHours = normalizeMonitorQuietHours(draftQuietStart, draftQuietEnd);
    if (hasQuietHoursInput && !nextQuietHours) {
      setQuietHoursError(t("detail.monitor.policy.quietHoursInvalid"));
      return;
    }
    setQuietHoursError(null);
    void onMonitorRuleChange(
      preset,
      threshold,
      interval,
      draftAlertsEnabled,
      draftWarningAlertsEnabled,
      draftCriticalAlertsEnabled,
      nextQuietHours,
    ).then((saved) => {
      if (!saved && resetPresetOnFailure) setDraftPreset(monitorPreset);
    });
  };
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
            {t("detail.monitor.autoRefresh", { seconds: refreshIntervalSecs })}
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

      <div className={`device-monitor-policy ${monitorPreset}`}>
        <button
          type="button"
          className="device-monitor-policy-toggle"
          aria-expanded={policyOpen}
          onClick={() => setPolicyOpen((open) => !open)}
        >
          <span className="device-monitor-policy-name">
            <SlidersHorizontal size={14} />
            {t("detail.monitor.policy.title")}
          </span>
          <span className="device-monitor-policy-current">
            {t(`detail.monitor.policy.preset.${monitorPreset}`)} · {alertThreshold}% /{" "}
            {refreshIntervalSecs}s · {alertsEnabled
              ? t("detail.monitor.policy.alertsEnabled")
              : t("detail.monitor.policy.alertsDisabled")}
          </span>
          <span className="device-monitor-policy-action">
            {t(policyOpen ? "detail.monitor.policy.close" : "detail.monitor.policy.configure")}
          </span>
        </button>
        {policyOpen && (
          <div className="device-monitor-policy-editor">
            <label className="field">
              <span>{t("detail.monitor.policy.preset")}</span>
              <select
                value={draftPreset}
                disabled={monitorRuleSaving}
                onChange={(event) => {
                  const preset = event.target.value as DeviceMonitorPreset;
                  setDraftPreset(preset);
                  if (preset !== "custom") {
                    saveDraftPolicy(preset, alertThreshold, refreshIntervalSecs, true);
                  }
                }}
              >
                <option value="inherit">{t("detail.monitor.policy.preset.inherit")}</option>
                <option value="sensitive">{t("detail.monitor.policy.preset.sensitive")}</option>
                <option value="balanced">{t("detail.monitor.policy.preset.balanced")}</option>
                <option value="relaxed">{t("detail.monitor.policy.preset.relaxed")}</option>
                <option value="custom">{t("detail.monitor.policy.preset.custom")}</option>
              </select>
            </label>
            {draftPreset === "custom" && (
              <div className="device-monitor-policy-custom">
                <label className="field">
                  <span>{t("detail.monitor.policy.threshold")}</span>
                  <div className="row">
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={customThreshold}
                      onChange={(event) => setCustomThreshold(Number(event.target.value))}
                    />
                    <span className="muted">%</span>
                  </div>
                </label>
                <label className="field">
                  <span>{t("detail.monitor.policy.interval")}</span>
                  <div className="row">
                    <input
                      type="number"
                      min={5}
                      max={60}
                      value={customRefreshInterval}
                      onChange={(event) => setCustomRefreshInterval(Number(event.target.value))}
                    />
                    <span className="muted">s</span>
                  </div>
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  loading={monitorRuleSaving}
                  onClick={() =>
                    saveDraftPolicy("custom", customThreshold, customRefreshInterval)
                  }
                >
                  {t("detail.monitor.policy.save")}
                </Button>
              </div>
            )}
            <div className="device-monitor-policy-notifications">
              <label className="device-monitor-policy-alert-toggle">
                <input
                  type="checkbox"
                  checked={draftAlertsEnabled}
                  onChange={(event) => setDraftAlertsEnabled(event.target.checked)}
                />
                <span>{t("detail.monitor.policy.alertsEnabled")}</span>
              </label>
              <div className="device-monitor-policy-levels">
                <label className="device-monitor-policy-level-toggle warning">
                  <input
                    type="checkbox"
                    checked={draftWarningAlertsEnabled}
                    disabled={!draftAlertsEnabled}
                    onChange={(event) => setDraftWarningAlertsEnabled(event.target.checked)}
                  />
                  <span>{t("detail.monitor.policy.severity.warning")}</span>
                </label>
                <label className="device-monitor-policy-level-toggle critical">
                  <input
                    type="checkbox"
                    checked={draftCriticalAlertsEnabled}
                    disabled={!draftAlertsEnabled}
                    onChange={(event) => setDraftCriticalAlertsEnabled(event.target.checked)}
                  />
                  <span>{t("detail.monitor.policy.severity.critical")}</span>
                </label>
              </div>
              <div className="device-monitor-policy-quiet">
                <span className="device-monitor-policy-quiet-label">
                  {t("detail.monitor.policy.quietHours")}
                </span>
                <div className="device-monitor-policy-quiet-inputs">
                  <label className="field">
                    <span>{t("detail.monitor.policy.quietStart")}</span>
                    <input
                      type="time"
                      value={draftQuietStart}
                      onChange={(event) => setDraftQuietStart(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{t("detail.monitor.policy.quietEnd")}</span>
                    <input
                      type="time"
                      value={draftQuietEnd}
                      onChange={(event) => setDraftQuietEnd(event.target.value)}
                    />
                  </label>
                </div>
                <div className="device-monitor-policy-quiet-hint">
                  {t("detail.monitor.policy.quietHoursHint")}
                </div>
              </div>
            </div>
            {quietHoursError && (
              <div className="device-monitor-policy-error" role="alert">
                {quietHoursError}
              </div>
            )}
            {draftPreset !== "custom" && (
              <div className="device-monitor-policy-notification-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={monitorRuleSaving}
                  onClick={() => saveDraftPolicy(draftPreset, alertThreshold, refreshIntervalSecs)}
                >
                  {t("detail.monitor.policy.saveNotifications")}
                </Button>
              </div>
            )}
            <div className="device-monitor-policy-hint">
              {t("detail.monitor.policy.hint")}
            </div>
          </div>
        )}
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
                  <span className={`monitor-severity-badge ${alert.severity ?? "warning"}`}>
                    {t(`detail.monitor.policy.severity.${alert.severity ?? "warning"}`)}
                  </span>
                  {resourceAlertMessageFor(alert.kind, t, alert.alertThreshold ?? threshold)}
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
