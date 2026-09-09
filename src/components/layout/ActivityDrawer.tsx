import { useEffect, useState } from "react";
import { Activity, BellRing, ChevronDown, FileClock, ListChecks } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";

type ActivityTab = "monitor" | "batch" | "logs" | "alerts";

const tabs: Array<{ id: ActivityTab; icon: typeof Activity; labelKey: string }> = [
  { id: "monitor", icon: Activity, labelKey: "common.activity.monitor" },
  { id: "batch", icon: ListChecks, labelKey: "common.activity.batch" },
  { id: "logs", icon: FileClock, labelKey: "common.activity.logs" },
  { id: "alerts", icon: BellRing, labelKey: "common.activity.alerts" },
];

export function ActivityDrawer() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const statusText = useAppStore((s) => s.statusText);
  const devices = useAppStore((s) => s.devices);
  const monitorAlerts = useAppStore((s) => s.monitorAlerts);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("rdc.activity.open") === "1";
    } catch {
      return false;
    }
  });
  const [activeTab, setActiveTab] = useState<ActivityTab>(() => {
    try {
      const saved = localStorage.getItem("rdc.activity.tab");
      return tabs.some((tab) => tab.id === saved) ? (saved as ActivityTab) : "monitor";
    } catch {
      return "monitor";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("rdc.activity.open", open ? "1" : "0");
      localStorage.setItem("rdc.activity.tab", activeTab);
    } catch {
      /* storage is optional */
    }
  }, [activeTab, open]);

  const online = devices.filter((device) => device.online && device.adbStatus === "device").length;
  const casting = devices.filter((device) => device.scrcpyStatus === "running").length;

  return (
    <section className={`activity-drawer${open ? " open" : ""}`} aria-label={t("common.activity.label")}>
      <button
        type="button"
        className="activity-strip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-strip-title"><Activity size={15} /> {t("common.activity.title")}</span>
        <span className="activity-strip-summary">{online} {t("common.workspace.onlineShort")} · {casting} {t("common.activity.castingShort")}</span>
        <span className="activity-strip-message">{statusText}</span>
        <ChevronDown size={15} className="activity-chevron" />
      </button>

      {open && (
        <div className="activity-panel">
          <div className="activity-tabs" role="tablist" aria-label={t("common.activity.tabsLabel")}>
            {tabs.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                className={activeTab === id ? "active" : ""}
                onClick={() => setActiveTab(id)}
              >
                <Icon size={14} /> {t(labelKey)}
                {id === "alerts" && monitorAlerts.length > 0 ? <span className="activity-count">{monitorAlerts.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="activity-content" role="tabpanel">
            {activeTab === "monitor" && (
              <div className="activity-metrics">
                <div><span>{t("common.activity.onlineDevices")}</span><strong>{online}</strong></div>
                <div><span>{t("common.activity.casting")}</span><strong>{casting}</strong></div>
                <div><span>CPU</span><strong>{(status?.cpuUsage ?? 0).toFixed(1)}%</strong></div>
                <div><span>{t("common.panel.memory")}</span><strong>{(status?.memoryUsage ?? 0).toFixed(1)}%</strong></div>
                <button type="button" onClick={() => navigate("/monitor")}>{t("common.activity.openMonitor")}</button>
              </div>
            )}
            {activeTab === "batch" && (
              <div className="activity-inline">
                <span className="activity-inline-status">{statusText}</span>
                <button type="button" onClick={() => navigate("/devices")}>{t("common.activity.openBatch")}</button>
              </div>
            )}
            {activeTab === "logs" && (
              <div className="activity-inline">
                <span className="activity-inline-status">{statusText}</span>
                <button type="button" onClick={() => navigate("/logs")}>{t("common.activity.openLogs")}</button>
              </div>
            )}
            {activeTab === "alerts" && (
              monitorAlerts.length > 0 ? (
                <div className="activity-alert-list">
                  {monitorAlerts.slice(0, 3).map((alert) => (
                    <button key={alert.id} type="button" onClick={() => navigate(`/devices/${encodeURIComponent(alert.deviceId)}`)}>
                      <span className={`activity-alert-dot ${alert.severity ?? "warning"}`} />
                      <span>{alert.deviceName}</span>
                      <span className="muted">{alert.kind}</span>
                    </button>
                  ))}
                  <button type="button" className="activity-link" onClick={() => navigate("/monitor")}>{t("common.activity.openAlerts")}</button>
                </div>
              ) : (
                <div className="activity-empty">{t("common.activity.noAlerts")}</div>
              )
            )}
          </div>
        </div>
      )}
    </section>
  );
}
