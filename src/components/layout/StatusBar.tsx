import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { DeviceService } from "../../services/deviceService";
import { useI18n } from "../../i18n";

export function StatusBar() {
  const status = useAppStore((s) => s.status);
  const statusText = useAppStore((s) => s.statusText);
  const lastDismissedMonitorAlerts = useAppStore((s) => s.lastDismissedMonitorAlerts);
  const monitorAlertUndoKind = useAppStore((s) => s.monitorAlertUndoKind);
  const monitorAlertUndoExpiresAt = useAppStore((s) => s.monitorAlertUndoExpiresAt);
  const restoreDismissedMonitorAlerts = useAppStore((s) => s.restoreDismissedMonitorAlerts);
  const expireDismissedMonitorAlertUndo = useAppStore((s) => s.expireDismissedMonitorAlertUndo);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const devices = useAppStore((s) => s.devices);
  const deviceCount = devices.length;
  const navigate = useNavigate();
  const online = devices.filter((d) => d.online && d.adbStatus === "device").length;
  const { t } = useI18n();
  const [startingDocker, setStartingDocker] = useState(false);
  const [undoNow, setUndoNow] = useState(() => Date.now());
  const logHint = /自动启动|失败|超时|错误|failed|timeout/i.test(statusText);
  const undoRemainingSeconds =
    monitorAlertUndoExpiresAt === null
      ? 0
      : Math.ceil(Math.max(0, monitorAlertUndoExpiresAt - undoNow) / 1_000);
  const canUndo =
    Boolean(lastDismissedMonitorAlerts?.length) &&
    monitorAlertUndoKind !== null &&
    undoRemainingSeconds > 0;
  const undoLabelKey =
    monitorAlertUndoKind === "clear"
      ? "monitor.clearAll.undo"
      : monitorAlertUndoKind === "cleanup"
        ? "monitor.cleanup.undo"
        : "monitor.batchDismiss.undo";

  useEffect(() => {
    if (monitorAlertUndoExpiresAt === null) return;
    const update = () => setUndoNow(Date.now());
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [monitorAlertUndoExpiresAt]);

  useEffect(() => {
    if (monitorAlertUndoExpiresAt !== null && undoNow >= monitorAlertUndoExpiresAt) {
      expireDismissedMonitorAlertUndo();
    }
  }, [expireDismissedMonitorAlertUndo, monitorAlertUndoExpiresAt, undoNow]);

  const goLogs = (source: string) => {
    try {
      sessionStorage.setItem("rdc.logs.source", source);
      sessionStorage.setItem("rdc.logs.level", "all");
      sessionStorage.setItem("rdc.logs.keyword", "");
    } catch {
      /* ignore */
    }
    navigate("/logs");
  };

  return (
    <footer className="statusbar">
      <div className="left">
        <button
          type="button"
          className={status?.dockerRunning ? "ok" : "bad"}
          title={t("common.status.openDocker")}
          style={status?.dockerRunning ? undefined : { textDecoration: "underline" }}
          onClick={() => navigate("/docker")}
        >
          Docker {status?.dockerRunning ? t("common.status.dockerRunning") : t("common.status.dockerNotRunning")}
        </button>
        {!status?.dockerRunning && (
          <>
            <span className="sep">·</span>
            <button
              type="button"
              className="bad"
              disabled={startingDocker}
              title={t("common.status.startDockerTitle")}
              onClick={() => {
                setStartingDocker(true);
                void DeviceService.startDockerDesktop();
              }}
            >
              {startingDocker
                ? t("common.status.startingDocker")
                : t("common.status.startDocker")}
            </button>
          </>
        )}
        <span className="sep">·</span>
        <button
          type="button"
          className={status?.adbRunning ? "ok" : "bad"}
          title={t("common.status.openAdb")}
          style={status?.adbRunning ? undefined : { textDecoration: "underline" }}
          onClick={() => navigate("/adb")}
        >
          ADB {status?.adbRunning ? t("common.status.adbOk") : t("common.status.adbErrorShort")}
        </button>
        <span className="sep">·</span>
        <button
          type="button"
          title={deviceCount === 0 ? t("common.status.goCreateInstance") : t("common.status.openDevices")}
          className={online === 0 ? "bad" : undefined}
          style={online === 0 ? { textDecoration: "underline" } : undefined}
          onClick={() => navigate(deviceCount === 0 ? "/docker" : "/devices")}
        >
          {deviceCount === 0
            ? t("common.status.deviceCount", { n: 0 })
            : online === 0
              ? t("common.status.devicesNoneOnline", { total: deviceCount })
              : t("common.status.devicesOnline", { online, total: deviceCount })}
        </button>
      </div>
      <div className="right">
        <button
          type="button"
          className="statusbar-message"
          title={logHint ? t("common.status.openRelatedLogs") : t("common.status.openSystemLogs")}
          onClick={() => goLogs(/自动启动|Docker/.test(statusText) ? "System" : /ADB/.test(statusText) ? "ADB" : "all")}
        >
          {statusText}
        </button>
        {canUndo ? (
          <button
            type="button"
            className="statusbar-undo"
            onClick={() => {
              const count = lastDismissedMonitorAlerts?.length ?? 0;
              if (restoreDismissedMonitorAlerts()) {
                setStatusText(t("monitor.batchDismiss.undoDone", { n: count }));
              }
            }}
          >
            {t(undoLabelKey, { seconds: undoRemainingSeconds })}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
