import { Play, RefreshCw, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { DeviceService } from "../../services/deviceService";
import type { AppInfo, DeviceInfo } from "../../types";
import { Button } from "../ui/Button";

type QuickAppLauncherProps = {
  devices: DeviceInfo[];
  selectedDevices: DeviceInfo[];
  setStatusText: (text: string) => void;
};

function isOnline(device: DeviceInfo) {
  return device.online && device.adbStatus === "device" && Boolean(device.serial);
}

export function QuickAppLauncher({ devices, selectedDevices, setStatusText }: QuickAppLauncherProps) {
  const { t } = useI18n();
  const onlineDevices = useMemo(() => devices.filter(isOnline), [devices]);
  const preferredDevice = selectedDevices.find(isOnline) ?? onlineDevices[0];
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState(() => preferredDevice?.id ?? "");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [packageName, setPackageName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const target = onlineDevices.find((device) => device.id === deviceId) ?? preferredDevice;

  useEffect(() => {
    if (!target) {
      setDeviceId("");
      return;
    }
    if (!onlineDevices.some((device) => device.id === deviceId)) {
      setDeviceId(target.id);
    }
  }, [deviceId, onlineDevices, target]);

  const loadApps = async () => {
    if (!target?.serial) return;
    setLoading(true);
    setError("");
    try {
      const nextApps = await DeviceService.listApps(target.serial, false);
      setApps(nextApps);
      setPackageName((current) => nextApps.some((app) => app.packageName === current) ? current : "");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setApps([]);
      setPackageName("");
      setError(message || t("devices.quickLaunch.loadFailed"));
      setStatusText(message || t("devices.quickLaunch.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !target) return;
    void loadApps();
  }, [open, target?.id]);

  const launch = async () => {
    if (!target?.serial || !packageName || busy) return;
    const app = apps.find((item) => item.packageName === packageName);
    setBusy(true);
    setError("");
    setStatusText(t("devices.quickLaunch.launching", { pkg: packageName }));
    try {
      const result = await DeviceService.startApp(target.serial, packageName);
      if (!result.success) {
        const message = result.stderr || result.stdout || t("devices.quickLaunch.failed");
        setError(message);
        setStatusText(message);
        return;
      }
      setStatusText(t("devices.quickLaunch.started", { pkg: app?.label || packageName }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message || t("devices.quickLaunch.failed"));
      setStatusText(message || t("devices.quickLaunch.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-app-launcher">
      <Button
        size="sm"
        variant={open ? "primary" : "ghost"}
        icon={<Rocket size={13} />}
        aria-expanded={open}
        disabled={onlineDevices.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        {t("devices.quickLaunch.open")}
      </Button>
      {open && (
        <div className="quick-app-launcher-panel" role="group" aria-label={t("devices.quickLaunch.title")}>
          <label>
            <span>{t("devices.quickLaunch.device")}</span>
            <select aria-label={t("devices.quickLaunch.device")} value={target?.id ?? ""} onChange={(event) => setDeviceId(event.target.value)} disabled={loading || busy}>
              {onlineDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("devices.quickLaunch.app")}</span>
            <select aria-label={t("devices.quickLaunch.app")} value={packageName} onChange={(event) => setPackageName(event.target.value)} disabled={loading || busy || apps.length === 0}>
              <option value="">{loading ? t("devices.quickLaunch.loading") : t("devices.quickLaunch.appPlaceholder")}</option>
              {apps.map((app) => <option key={app.packageName} value={app.packageName}>{app.label} · {app.packageName}</option>)}
            </select>
          </label>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} aria-label={t("devices.quickLaunch.refresh")} disabled={!target || loading || busy} onClick={() => void loadApps()}>
            {t("devices.quickLaunch.refresh")}
          </Button>
          <Button size="sm" variant="primary" icon={<Play size={13} />} loading={busy} disabled={!target || !packageName || loading || busy} onClick={() => void launch()}>
            {busy ? t("devices.quickLaunch.launchingShort") : t("devices.quickLaunch.launch")}
          </Button>
          {error ? <span className="quick-app-launcher-error" role="alert">{error}</span> : null}
        </div>
      )}
    </div>
  );
}
