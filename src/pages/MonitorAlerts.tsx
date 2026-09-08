import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, BellRing, Clock3, Cpu, Download, MemoryStick, Trash2, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { alertMsg, askConfirm } from "../lib/dialogs";
import { useI18n } from "../i18n";
import {
  filterMonitorAlerts,
  buildMonitorAlertTrend,
  MAX_MONITOR_ALERT_HISTORY,
  monitorAlertMessageKey,
  runConfirmedMonitorAlertCleanup,
  serializeMonitorAlertsCsv,
  summarizeMonitorAlerts,
  summarizeMonitorAlertsByDevice,
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
  const dismissMonitorAlerts = useAppStore((s) => s.dismissMonitorAlerts);
  const clearMonitorAlerts = useAppStore((s) => s.clearMonitorAlerts);
  const clearMonitorAlertsBefore = useAppStore((s) => s.clearMonitorAlertsBefore);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const [cleanupChoice, setCleanupChoice] = useState("");
  const [filters, setFilters] = useState<MonitorAlertFilter>({
    deviceId: "all",
    kind: "all",
    severity: "all",
    timeRange: "7d",
    query: "",
  });
  const [selectedAlertIds, setSelectedAlertIds] = useState<string[]>([]);
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
  const counts = summarizeMonitorAlerts(filteredAlerts);
  const trend = buildMonitorAlertTrend(filteredAlerts, Date.now());
  const trendMax = Math.max(1, ...trend.map((point) => point.warning + point.critical));
  const hasTrendData = trend.some((point) => point.warning > 0 || point.critical > 0);
  const selectedDayLabel =
    typeof filters.dayStart === "number" && Number.isFinite(filters.dayStart)
      ? new Date(filters.dayStart).toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
      : "";
  const visibleAlertIds = useMemo(
    () => new Set(filteredAlerts.map((alert) => alert.id)),
    [filteredAlerts],
  );
  const selectedVisibleIds = useMemo(
    () => selectedAlertIds.filter((id) => visibleAlertIds.has(id)),
    [selectedAlertIds, visibleAlertIds],
  );
  const allVisibleSelected = filteredAlerts.length > 0 && selectedVisibleIds.length === filteredAlerts.length;
  const deviceSummaries = useMemo(
    () => summarizeMonitorAlertsByDevice(filteredAlerts, Date.now()),
    [filteredAlerts],
  );

  useEffect(() => {
    setSelectedAlertIds((current) => {
      const next = current.filter((id) => visibleAlertIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleAlertIds]);

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

  const toggleAlertSelection = (id: string) => {
    setSelectedAlertIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    );
  };

  const toggleVisibleAlertSelection = () => {
    const visibleIds = filteredAlerts.map((alert) => alert.id);
    setSelectedAlertIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return [...next];
    });
  };

  const dismissSelectedAlerts = async () => {
    const count = selectedVisibleIds.length;
    if (count === 0) return;
    const completed = await runConfirmedMonitorAlertCleanup(
      () => askConfirm(t("monitor.batchDismiss.confirm", { n: count })),
      () => dismissMonitorAlerts(selectedVisibleIds),
    );
    if (completed) {
      setSelectedAlertIds([]);
      setStatusText(t("monitor.batchDismiss.done", { n: count }));
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
        <SummaryCard
          icon={<AlertTriangle size={18} />}
          label={t("monitor.stat.warning")}
          value={counts.warning}
          tone="warning"
        />
        <SummaryCard
          icon={<AlertTriangle size={18} />}
          label={t("monitor.stat.critical")}
          value={counts.critical}
          tone="critical"
        />
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
                  if (completed) setStatusText(t("monitor.clearAll.done", { n: count }));
                });
              }}
            >
              {t("monitor.clearAll")}
            </Button>
          ) : null
        }
      >
        <div className="monitor-alert-filters">
          <label className="field monitor-alert-search-field">
            <span>{t("monitor.filter.search")}</span>
            <div className="monitor-alert-search-control">
              <input
                type="search"
                value={filters.query ?? ""}
                placeholder={t("monitor.filter.searchPlaceholder")}
                onChange={(e) => setFilters((current) => ({ ...current, query: e.target.value }))}
              />
              {filters.query ? (
                <button
                  type="button"
                  className="monitor-alert-search-clear"
                  aria-label={t("monitor.filter.clearSearch")}
                  title={t("monitor.filter.clearSearch")}
                  onClick={() => setFilters((current) => ({ ...current, query: "" }))}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </label>
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
            <span>{t("monitor.filter.severity")}</span>
            <select
              value={filters.severity ?? "all"}
              onChange={(e) =>
                setFilters((current) => ({
                  ...current,
                  severity: e.target.value as MonitorAlertFilter["severity"],
                }))
              }
            >
              <option value="all">{t("monitor.filter.allSeverities")}</option>
              <option value="warning">{t("monitor.severity.warning")}</option>
              <option value="critical">{t("monitor.severity.critical")}</option>
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
                  dayStart: undefined,
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
        {selectedDayLabel ? (
          <div className="monitor-alert-filter-day">
            <span>{t("monitor.filter.selectedDay", { date: selectedDayLabel })}</span>
            <button
              type="button"
              onClick={() => setFilters((current) => ({ ...current, dayStart: undefined }))}
            >
              {t("monitor.filter.clearDay")}
            </button>
          </div>
        ) : null}
      </Card>

      <Card
        title={t("monitor.card.trend")}
        className="monitor-alert-trend-card"
        action={<span className="muted monitor-alert-trend-range">{t("monitor.trend.range")}</span>}
      >
        {!hasTrendData ? (
          <div className="monitor-alert-trend-empty">{t("monitor.trend.empty")}</div>
        ) : (
          <>
            <div className="monitor-alert-trend-legend">
              <span><i className="warning" />{t("monitor.severity.warning")}</span>
              <span><i className="critical" />{t("monitor.severity.critical")}</span>
            </div>
            <div className="monitor-alert-trend" role="group" aria-label={t("monitor.card.trend")}>
              {trend.map((point) => {
                const day = new Date(point.dayStart);
                const label = day.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
                return (
                  <button
                    type="button"
                    className={`monitor-alert-trend-column${filters.dayStart === point.dayStart ? " selected" : ""}`}
                    aria-pressed={filters.dayStart === point.dayStart}
                    title={t("monitor.trend.selectDay", { date: label })}
                    onClick={() =>
                      setFilters((current) => ({
                        ...current,
                        dayStart: current.dayStart === point.dayStart ? undefined : point.dayStart,
                      }))
                    }
                    key={point.dayStart}
                  >
                    <div className="monitor-alert-trend-bars">
                      <div
                        className="monitor-alert-trend-bar warning"
                        title={`${label} · ${t("monitor.severity.warning")} ${point.warning}`}
                      >
                        <span style={{ height: `${(point.warning / trendMax) * 100}%` }} />
                      </div>
                      <div
                        className="monitor-alert-trend-bar critical"
                        title={`${label} · ${t("monitor.severity.critical")} ${point.critical}`}
                      >
                        <span style={{ height: `${(point.critical / trendMax) * 100}%` }} />
                      </div>
                    </div>
                    <span className="monitor-alert-trend-label">{label}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card
        title={t("monitor.card.deviceComparison")}
        className="monitor-alert-device-card"
        action={<span className="muted monitor-alert-device-range">{t("monitor.deviceComparison.range")}</span>}
      >
        {deviceSummaries.length === 0 ? (
          <div className="monitor-alert-device-empty">{t("monitor.deviceComparison.empty")}</div>
        ) : (
          <div className="monitor-alert-device-table" role="table" aria-label={t("monitor.card.deviceComparison")}>
            <div className="monitor-alert-device-row monitor-alert-device-head" role="row">
              <span role="columnheader">{t("monitor.deviceComparison.device")}</span>
              <span role="columnheader">{t("monitor.deviceComparison.total")}</span>
              <span role="columnheader">{t("monitor.deviceComparison.severity")}</span>
              <span role="columnheader">{t("monitor.deviceComparison.peak")}</span>
            </div>
            {deviceSummaries.map((summary) => {
              const peakDayStart = summary.peakDayStart;
              const peakLabel = peakDayStart === null
                ? "—"
                : new Date(peakDayStart).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
              return (
                <div className="monitor-alert-device-row" role="row" key={summary.deviceId}>
                  <div className="monitor-alert-device-name" role="cell">
                    <button
                      type="button"
                      className="monitor-alert-device-link"
                      onClick={() => openDevice(summary.deviceId)}
                    >
                      {summary.deviceName}
                    </button>
                    {summary.peakIsAnomaly && peakDayStart !== null ? (
                      <button
                        type="button"
                        className="monitor-alert-device-peak-badge"
                        title={t("monitor.deviceComparison.peakHint")}
                        aria-label={t("monitor.deviceComparison.selectPeak", {
                          device: summary.deviceName,
                          date: peakLabel,
                        })}
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            deviceId: summary.deviceId,
                            dayStart: peakDayStart,
                          }))
                        }
                      >
                        <AlertTriangle size={11} />
                        {t("monitor.deviceComparison.peak")}
                      </button>
                    ) : null}
                  </div>
                  <span
                    className="monitor-alert-device-total"
                    role="cell"
                    data-label={t("monitor.deviceComparison.total")}
                  >
                    {summary.total}
                  </span>
                  <div
                    className="monitor-alert-device-severity"
                    role="cell"
                    data-label={t("monitor.deviceComparison.severity")}
                  >
                    <span className="warning" title={t("monitor.severity.warning")}>{summary.warning}</span>
                    <span className="critical" title={t("monitor.severity.critical")}>{summary.critical}</span>
                  </div>
                  <div
                    className="monitor-alert-device-peak"
                    role="cell"
                    data-label={t("monitor.deviceComparison.peak")}
                  >
                    <span>{peakLabel}</span>
                    {summary.peakCount > 0 ? <span className="muted">{summary.peakCount}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
          <>
            <div className="monitor-alert-selection-bar">
              <label className="monitor-alert-select-all">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisibleAlertSelection}
                  aria-label={t("monitor.batchDismiss.selectAll")}
                />
                <span>{t("monitor.batchDismiss.selectAll")}</span>
              </label>
              <div className="monitor-alert-selection-actions">
                <span className="muted">{t("monitor.batchDismiss.selected", { n: selectedVisibleIds.length })}</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={selectedVisibleIds.length === 0}
                  onClick={() => void dismissSelectedAlerts()}
                >
                  {t("monitor.batchDismiss.action")}
                </Button>
              </div>
            </div>
            <div className="monitor-alert-history-list">
              {filteredAlerts.map((alert) => (
                <div className="monitor-alert-history-item" key={alert.id}>
                  <label className="monitor-alert-select-control">
                    <input
                      type="checkbox"
                      checked={selectedAlertIds.includes(alert.id)}
                      onChange={() => toggleAlertSelection(alert.id)}
                      aria-label={t("monitor.batchDismiss.selectOne", {
                        device: alert.deviceName || t("monitor.deviceUnknown"),
                      })}
                    />
                  </label>
                  <div className={`monitor-alert-kind ${alert.kind}`}>
                    {kindIcon(alert.kind)}
                  </div>
                  <div className="monitor-alert-history-content">
                    <div className="monitor-alert-history-device">
                      {alert.deviceName || t("monitor.deviceUnknown")}
                    </div>
                    <div className="monitor-alert-history-message">
                      <span className={`monitor-severity-badge ${alert.severity ?? "warning"}`}>
                        {t(`monitor.severity.${alert.severity ?? "warning"}`)}
                      </span>{" "}
                      {t(monitorAlertMessageKey(alert.kind), {
                        threshold: alert.alertThreshold ?? monitorPreferences.alertThreshold,
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
          </>
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
  tone?: MonitorAlertKind | "warning" | "critical";
}) {
  return (
    <Card className={`monitor-alert-summary-card ${tone ?? ""}`}>
      <div className="monitor-alert-summary-icon">{icon}</div>
      <div className="monitor-alert-summary-label">{label}</div>
      <div className="monitor-alert-summary-value">{value}</div>
    </Card>
  );
}
