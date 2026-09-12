import { useEffect, useState } from "react";
import { Activity, Battery, BatteryCharging, Cpu, Gauge, HardDrive, Network, Server, Thermometer } from "lucide-react";
import type { DeviceInfo, ScreenshotResult } from "../../types";
import { useI18n } from "../../i18n";
import { deviceCapabilitySummary } from "../../lib/deviceBoard";
import { DeviceService } from "../../services/deviceService";

export function DeviceHoverCard({ device }: { device: DeviceInfo }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<DeviceInfo>(device);
  const [screenshot, setScreenshot] = useState<ScreenshotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setScreenshotLoading(false);
    setScreenshot(null);
    setError("");
    void DeviceService.getDevice(device.id)
      .then((next) => {
        if (!cancelled && next) setDetail(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    if (device.online && device.adbStatus === "device" && device.serial) {
      setScreenshotLoading(true);
      void DeviceService.screenshot(device.serial)
        .then((next) => {
          if (!cancelled) setScreenshot(next);
        })
        .catch((reason) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (!cancelled) setScreenshotLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [device.id, device.serial, device.online, device.adbStatus]);

  const capability = deviceCapabilitySummary(detail);
  const isOnline = detail.online && detail.adbStatus === "device";
  const metric = (value: number | undefined, suffix = "%") =>
    typeof value === "number" ? `${value.toFixed(1)}${suffix}` : t("dashboard.board.notProvided");
  const batteryValue = typeof detail.batteryLevel === "number"
    ? Math.min(100, Math.max(0, Math.round(detail.batteryLevel)))
    : null;
  const battery = batteryValue === null ? t("dashboard.board.notProvided") : `${batteryValue}%`;
  const charging = detail.batteryCharging === undefined
    ? ""
    : detail.batteryCharging
      ? t("dashboard.board.charging")
      : t("dashboard.board.notCharging");
  const temperature = typeof detail.batteryTemperatureC === "number" ? `${detail.batteryTemperatureC.toFixed(1)} °C` : t("dashboard.board.notProvided");
  const voltage = typeof detail.batteryVoltageV === "number" ? `${detail.batteryVoltageV.toFixed(2)} V` : t("dashboard.board.notProvided");
  const screenshotSrc = screenshot?.success && screenshot.base64 ? `data:image/png;base64,${screenshot.base64}` : "";

  return (
    <div className="device-hover-card" role="tooltip">
      <div className="device-hover-heading">
        <div>
          <div className="device-hover-title">{detail.name}</div>
          <div className="device-hover-serial mono">{detail.serial || "—"}</div>
        </div>
        <div className={`device-hover-status ${isOnline ? "online" : "offline"}`}>
          <span className="device-hover-status-dot" />
          <span>{isOnline ? t("common.online") : t("common.offline")}</span>
        </div>
      </div>
      <div className="device-hover-grid">
        <HoverValue icon={<Activity size={13} />} label="Android" value={detail.androidVersion || "—"} />
        <HoverValue icon={<Gauge size={13} />} label="FPS" value={detail.fps ? String(detail.fps) : "—"} />
        <HoverValue icon={<Cpu size={13} />} label="CPU" value={metric(detail.cpuUsage)} />
        <HoverValue icon={<HardDrive size={13} />} label={t("common.panel.memory")} value={metric(detail.memoryUsage)} />
        <div className="device-hover-value device-hover-battery-value">
          <span className="device-hover-value-label">{detail.batteryCharging ? <BatteryCharging size={13} /> : <Battery size={13} />}{t("dashboard.board.battery")}</span>
          <strong>{charging ? `${battery} · ${charging}` : battery}</strong>
          {batteryValue !== null ? (
            <div
              className="device-hover-battery-meter"
              role="meter"
              aria-label={t("dashboard.board.battery")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={batteryValue}
            >
              <span style={{ width: `${batteryValue}%` }} />
            </div>
          ) : null}
        </div>
        <HoverValue icon={<Thermometer size={13} />} label={t("dashboard.board.temperature")} value={`${temperature} · ${voltage}`} />
        <HoverValue icon={<Server size={13} />} label={t("dashboard.board.resolution")} value={detail.resolution || "—"} />
        <HoverValue icon={<Network size={13} />} label={t("dashboard.board.powerSource")} value={detail.batteryPowerSource || t("dashboard.board.notProvided")} />
      </div>
      <div className="device-hover-screenshot">
        {screenshotSrc ? <img src={screenshotSrc} alt={t("dashboard.board.screenshotAlt")} /> : screenshotLoading ? <span>{t("dashboard.board.screenshotLoading")}</span> : <span>{t("dashboard.board.screenshotUnavailable")}</span>}
      </div>
      {loading ? <div className="device-hover-loading">{t("dashboard.board.loadingDetails")}</div> : null}
      {error ? <div className="device-hover-error" title={error}>{error}</div> : null}
      <div className="device-hover-footer">
        <span>ADB {detail.adbStatus || "—"}</span>
        <span>scrcpy {capability.scrcpy || "—"}</span>
        <span>{detail.uptime || t("dashboard.board.notProvided")}</span>
      </div>
    </div>
  );
}

function HoverValue({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="device-hover-value">
      <span className="device-hover-value-label">{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
