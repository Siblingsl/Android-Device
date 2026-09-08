import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { BellRing, Clock3, Cpu, Download, MemoryStick, Trash2, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { alertMsg, askConfirm } from "../lib/dialogs";
import { useI18n } from "../i18n";
import {
  filterMonitorAlerts,
  MAX_MONITOR_ALERT_HISTORY,
  monitorAlertMessageKey,
  runConfirmedMonitorAlertCleanup,
  serializeMonitorAlertsCsv,
  type MonitorAlertFilter,
  type MonitorAlertKind,
} from "../lib/monitorAlerts";
import { normalizeMonitorPreferences } from "../lib/monitorPreferences";
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";

export function MonitorAlertsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const devices = useAppStore((s) => s.devices);
  const alerts = useAppStore((s) => s.monitorAlerts);
  const settings = useAppStore((s) => s.settings);
  const setSelectedDeviceId = useAppStore((s) => s.setSelectedDeviceId);
  const dismissMonitorAlert = useAppStore((s) => s.dismissMonitorAlert);
  const clearMonitorAlerts = useAppStore((s) => s.clearMonitorAlerts);
  const clearMonitorAlertsBefore = useAppStore((s) => s.clearMonitorAlertsBefore);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const [cleanupChoice, setCleanupChoice] = useState("");
  const [filters, setFilters] = useState<MonitorAlertFilter>({
    deviceId: "all",
    kind: "all",
    timeRange: "7d",
  });
  const monitorPreferences = normalizeMonitorPreferences(
    settings?.resourceAlertThreshold,
    settings?.deviceRefreshIntervalSecs,
  );
  const alertDevices = useMemo(() => {
    const names = new Map<string, string>();
    devices.forEach((device) => names.set(device.id, device.name || device.id));
    alerts.forEach((alert) => {
      if (!names.has(alert.deviceId)) names.set(alert.deviceId, alert.deviceName || alert.deviceId);
    });
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [alerts, devices]);
  const filteredAlerts = useMemo(
    () => filterMonitorAlerts(alerts, filters, Date.now()),
    [alerts, filters],
  );
  const counts = {
    total: filteredAlerts.length,
    cpu: filteredAlerts.filter((alert) => alert.kind === "cpu").length,
    memory: filteredAlerts.filter((alert) => alert.kind === "memory").length,
    both: filteredAlerts.filter((alert) => alert.kind === "both").length,
  };

  const openDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    navigate(`/devices/${encodeURIComponent(deviceId)}`);
  };

  const cleanupOlderAlerts = async (range: "24h" | "7d") => {
    const days = range === "24h" ? 1 : 7;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000;
    const count = alerts.filter((alert) => alert.createdAt < cutoff).length;
    if (count === 0) {
      setStatusText(t("monitor.cleanup.none"));
      return;
    }
    const completed = await runConfirmedMonitorAlertCleanup(
      () => askConfirm(t("monitor.cleanup.confirm", { n: count, range: t(`monitor.cleanup.${range}`) })),
      () => clearMonitorAlertsBefore(cutoff),
    );
    if (completed) setStatusText(t("monitor.cleanup.done", { n: count }));
  };

  const exportFilteredAlerts = async () => {
    try {
      const path = await save({
        defaultPath: `monitor-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      const saved = await DeviceService.exportLogs(path, serializeMonitorAlertsCsv(filteredAlerts));
      setStatusText(t("monitor.export.done", { path: saved }));
      if (await askConfirm(t("monitor.export.confirm", { path: saved }))) {
        await DeviceService.revealInFolder(saved);
      }
    } catch (error) {
      if (!error) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(t("monitor.export.failed", { error: message }));
      await alertMsg(t("monitor.export.failed", { error: message }));
    }
  };

  return (
    <div className="monitor-alert-page">
      <div className="page-header monitor-alert-header">
        <div>
          <div className="monitor-alert-eyebrow">
            <span className="monitor-alert-signal-dot" />
            {t("monitor.sessionOnly")}
          </div>
          <div className="page-title">{t("monitor.title")}</div>
          <div className="page-subtitle">{t("monitor.subtitle")}</div>
        </div>
        <div className="monitor-alert-header-mark" aria-hidden="true">
          <BellRing size={20} />
        </div>
      </div>

      <div className="grid-stats monitor-alert-stats">
        <SummaryCard icon={<BellRing size={18} />} label={t("monitor.stat.total")} value={counts.total} />
        <SummaryCard icon={<Cpu size={18} />} label={t("monitor.stat.cpu")} value={counts.cpu} tone="cpu" />
        <SummaryCard
          icon={<MemoryStick size={18} />}
          label={t("monitor.stat.memory")}
          value={counts.memory}
          tone="memory"
        />
        <SummaryCard icon={<BellRing size={18} />} label={t("monitor.stat.both")} value={counts.both} tone="both" />
      </div>

      <Card
        title={t("monitor.card.filters")}
        className="monitor-alert-filter-card"
        action={
          alerts.length > 0 ? (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={() => {
                const count = alerts.length;
                void runConfirmedMonitorAlertCleanup(
                  () => askConfirm(t("monitor.clearConfirm", { n: count })),
                  () => clearMonitorAlerts(),
                ).then((completed) => {
                  if (completed) setStatusText(t("monitor.cleanup.done", { n: count }));
                });
              }}
            >
              {t("monitor.clearAll")}
            </Button>
          ) : null
        }
      >
        <div className="monitor-alert-filters">
          <label className="field">
            <span>{t("monitor.filter.device")}</span>
            <select
              value={filters.deviceId}
              onChange={(e) => setFilters((current) => ({ ...current, deviceId: e.target.value }))}
            >
              <option value="all">{t("monitor.filter.allDevices")}</option>
              {alertDevices.map(([deviceId, deviceName]) => (
                <option key={deviceId} value={deviceId}>
                  {deviceName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("monitor.filter.kind")}</span>
            <select
              value={filters.kind}
              onChange={(e) =>
                setFilters((current) => ({
                  ...current,
                  kind: e.target.value as MonitorAlertFilter["kind"],
                }))
              }
            >
              <option value="all">{t("monitor.filter.allKinds")}</option>
              <option value="cpu">{t("monitor.filter.cpu")}</option>
              <option value="memory">{t("monitor.filter.memory")}</option>
              <option value="both">{t("monitor.filter.both")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("monitor.filter.timeRange")}</span>
            <select
              value={filters.timeRange}
              onChange={(e) =>
                setFilters((current) => ({
                  ...current,
                  timeRange: e.target.value as MonitorAlertFilter["timeRange"],
                }))
              }
            >
              <option value="24h">{t("monitor.filter.24h")}</option>
              <option value="7d">{t("monitor.filter.7d")}</option>
              <option value="all">{t("monitor.filter.allTime")}</option>
            </select>
          </label>
        </div>
        <div className="monitor-alert-filter-result">{t("monitor.filter.result", { n: filteredAlerts.length })}</div>
      </Card>

      <Card
        title={t("monitor.card.history")}
        className="monitor-alert-history-card"
        action={
          <div className="monitor-alert-history-tools">
            <span className="muted monitor-alert-history-limit">
              {alerts.length} / {MAX_MONITOR_ALERT_HISTORY}
            </span>
            <label className="monitor-alert-cleanup-control">
              <Clock3 size={13} aria-hidden="true" />
              <select
                value={cleanupChoice}
                disabled={alerts.length === 0}
                aria-label={t("monitor.cleanup.label")}
                onChange={(event) => {
                  const range = event.target.value as "24h" | "7d" | "";
                  setCleanupChoice(range);
                  if (range) {
                    void cleanupOlderAlerts(range).finally(() => setCleanupChoice(""));
                  }
                }}
              >
                <option value="">{t("monitor.cleanup.label")}</option>
                <option value="24h">{t("monitor.cleanup.before24h")}</option>
                <option value="7d">{t("monitor.cleanup.before7d")}</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              icon={<Download size={14} />}
              disabled={filteredAlerts.length === 0}
              onClick={() => void exportFilteredAlerts()}
            >
              {t("monitor.export")}
            </Button>
          </div>
        }
      >
        {filteredAlerts.length === 0 ? (
          <div className="empty-state">
            {alerts.length === 0 ? t("monitor.empty.noAlerts") : t("monitor.empty.noMatches")}
          </div>
        ) : (
          <div className="monitor-alert-history-list">
            {filteredAlerts.map((alert) => (
              <div className="monitor-alert-history-item" key={alert.id}>
                <div className={`monitor-alert-kind ${alert.kind}`}>
                  {kindIcon(alert.kind)}
                </div>
                <div className="monitor-alert-history-content">
                  <div className="monitor-alert-history-device">
                    {alert.deviceName || t("monitor.deviceUnknown")}
                  </div>
                  <div className="monitor-alert-history-message">
                    {t(monitorAlertMessageKey(alert.kind), {
                      threshold: monitorPreferences.alertThreshold,
                    })}
                  </div>
                  <div className="monitor-alert-history-time">
                    {t("monitor.at", { time: new Date(alert.createdAt).toLocaleString() })}
                  </div>
                </div>
                <div className="monitor-alert-history-actions">
                  <Button size="sm" variant="ghost" onClick={() => openDevice(alert.deviceId)}>
                    {t("monitor.openDevice")}
                  </Button>
                  <button
                    type="button"
                    className="monitor-alert-dismiss"
                    aria-label={t("monitor.dismiss")}
                    title={t("monitor.dismiss")}
                    onClick={() => dismissMonitorAlert(alert.id)}
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function kindIcon(kind: MonitorAlertKind): ReactNode {
  if (kind === "cpu") return <Cpu size={16} />;
  if (kind === "memory") return <MemoryStick size={16} />;
  return <BellRing size={16} />;
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: MonitorAlertKind;
}) {
  return (
    <Card className={`monitor-alert-summary-card ${tone ?? ""}`}>
      <div className="monitor-alert-summary-icon">{icon}</div>
      <div className="monitor-alert-summary-label">{label}</div>
      <div className="monitor-alert-summary-value">{value}</div>
    </Card>
  );
}
