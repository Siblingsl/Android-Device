import { Activity, Battery, Cpu, Gauge, HardDrive, Info, Network, Server, Thermometer } from "lucide-react";
import type { DeviceInfo } from "../../types";
import { useI18n } from "../../i18n";
import { deviceCapabilitySummary } from "../../lib/deviceBoard";

export function DeviceHoverCard({ device }: { device: DeviceInfo }) {
  const { t } = useI18n();
  const capability = deviceCapabilitySummary(device);
  const metric = (value: number | undefined, suffix = "%") =>
    typeof value === "number" ? `${value.toFixed(1)}${suffix}` : t("dashboard.board.notProvided");

  return (
    <div className="device-hover-card" role="tooltip">
      <div className="device-hover-heading">
        <div>
          <div className="device-hover-title">{device.name}</div>
          <div className="device-hover-serial mono">{device.serial || "—"}</div>
        </div>
        <Info size={14} />
      </div>
      <div className="device-hover-grid">
        <HoverValue icon={<Activity size={13} />} label="Android" value={device.androidVersion || "—"} />
        <HoverValue icon={<Gauge size={13} />} label="FPS" value={device.fps ? String(device.fps) : "—"} />
        <HoverValue icon={<Cpu size={13} />} label="CPU" value={metric(device.cpuUsage)} />
        <HoverValue icon={<HardDrive size={13} />} label={t("common.panel.memory")} value={metric(device.memoryUsage)} />
        <HoverValue icon={<Battery size={13} />} label={t("dashboard.board.battery")} value={t("dashboard.board.notProvided")} />
        <HoverValue icon={<Thermometer size={13} />} label={t("dashboard.board.temperature")} value={t("dashboard.board.notProvided")} />
        <HoverValue icon={<Server size={13} />} label={t("dashboard.board.resolution")} value={device.resolution || "—"} />
        <HoverValue icon={<Network size={13} />} label="IP" value={device.ip || "—"} />
      </div>
      <div className="device-hover-footer">
        <span>ADB {device.adbStatus || "—"}</span>
        <span>scrcpy {capability.scrcpy || "—"}</span>
        <span>{device.uptime || t("dashboard.board.notProvided")}</span>
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
