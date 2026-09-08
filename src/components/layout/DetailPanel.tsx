import { useNavigate } from "react-router-dom";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { useAppStore } from "../../stores/appStore";
import { StatusDot } from "../ui/StatusDot";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";

export function DetailPanel() {
  const open = useAppStore((s) => s.detailOpen);
  const setOpen = useAppStore((s) => s.setDetailOpen);
  const devices = useAppStore((s) => s.devices);
  const selectedId = useAppStore((s) => s.selectedDeviceId);
  const status = useAppStore((s) => s.status);
  const device = devices.find((d) => d.id === selectedId) ?? devices[0];
  const navigate = useNavigate();
  const { t } = useI18n();

  if (!open) {
    return (
      <button className="detail-toggle closed" onClick={() => setOpen(true)} title={t("common.panel.expand")}>
        <ChevronLeft size={16} />
      </button>
    );
  }

  return (
    <aside className="detail">
      <div className="detail-head">
        <div className="detail-title">{t("common.detailPanel")}</div>
        <button className="detail-toggle" onClick={() => setOpen(false)}>
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="detail-body">
        <section>
          <div className="sec-title">{t("common.panel.system")}</div>
          <Info
            label="Docker"
            value={status?.dockerRunning ? status.dockerVersion : t("common.status.dockerOff")}
            onClick={() => navigate("/docker")}
          />
          <Info label="ADB" value={status?.adbVersion || "-"} onClick={() => navigate("/adb")} />
          <Info
            label={t("common.panel.onlineDevices")}
            value={String(devices.filter((d) => d.online && d.adbStatus === "device").length)}
            onClick={() => navigate("/devices")}
          />
          <Info label="CPU" value={`${(status?.cpuUsage ?? 0).toFixed(1)}%`} />
          <Info label={t("common.panel.memory")} value={`${(status?.memoryUsage ?? 0).toFixed(1)}%`} />
        </section>

        <section>
          <div className="sec-title">{t("common.panel.selectedDevice")}</div>
          {device ? (
            <>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <strong>{device.name}</strong>
                <StatusDot online={device.online && device.adbStatus === "device"} />
              </div>
              <Info
                label="Serial"
                value={device.serial || "-"}
                mono
                onClick={
                  device.serial
                    ? () => {
                        void copyText(device.serial).then(
                          () => useAppStore.getState().setStatusText(t("common.panel.copied", { value: device.serial })),
                          () => useAppStore.getState().setStatusText(t("common.panel.copyFailed")),
                        );
                      }
                    : undefined
                }
              />
              {device.containerId && !device.serial ? (
                <div className="badge warn" style={{ marginTop: 4, cursor: "help" }} title={t("devices.card.noAdbMappingHint")}>
                  {t("devices.card.noAdbMapping")}
                </div>
              ) : null}
              <Info label="Android" value={device.androidVersion || "-"} />
              <Info label={t("common.panel.resolution")} value={device.resolution || "-"} />
              <Info label="IP" value={device.ip || "-"} />
              <Info label="ADB" value={device.adbStatus} />
              <Info label="Scrcpy" value={device.scrcpyStatus} />
              <Info label="Docker" value={device.dockerStatus} />
              <Info label={t("common.panel.volume")} value={device.dataVolume || "-"} />
              <div style={{ marginTop: 12 }}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => navigate(`/devices/${encodeURIComponent(device.id)}`)}
                >
                  {t("common.panel.openDetail")}
                </Button>
              </div>
            </>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              {t("common.panel.noDevice")}
              <div style={{ marginTop: 10 }}>
                <Button size="sm" variant="primary" onClick={() => navigate("/docker")}>
                  {t("common.panel.goCreate")}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function Info({
  label,
  value,
  mono,
  onClick,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="info-row">
      <span className="muted">{label}</span>
      {onClick ? (
        <button
          type="button"
          className={mono ? "mono" : ""}
          title={label === "Serial" ? t("common.panel.copySerial") : t("common.panel.openLabel", { label })}
          style={{
            textAlign: "right",
            maxWidth: "60%",
            wordBreak: "break-all",
            background: "none",
            border: 0,
            padding: 0,
            color: "inherit",
            cursor: "pointer",
            textDecoration: "underline",
          }}
          onClick={onClick}
        >
          {value}
        </button>
      ) : (
        <span className={mono ? "mono" : ""} style={{ textAlign: "right", maxWidth: "60%", wordBreak: "break-all" }}>
          {value}
        </span>
      )}
    </div>
  );
}
