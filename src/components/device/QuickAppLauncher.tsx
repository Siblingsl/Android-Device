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
  const selectedOnlineDevices = useMemo(() => selectedDevices.filter(isOnline), [selectedDevices]);
  const preferredDevice = selectedDevices.find(isOnline) ?? onlineDevices[0];
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState(() => preferredDevice?.id ?? "");
  const [scope, setScope] = useState<"current" | "selected">(() => selectedDevices.some(isOnline) ? "selected" : "current");
  const [launchMode, setLaunchMode] = useState<"normal" | "display">("normal");
  const [displayId, setDisplayId] = useState("1");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [packageName, setPackageName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const target = onlineDevices.find((device) => device.id === deviceId) ?? preferredDevice;
  const launchTargets = scope === "selected" && selectedOnlineDevices.length > 0
    ? selectedOnlineDevices
    : target
      ? [target]
      : [];
  const appSource = launchTargets[0] ?? target;

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
    if (!appSource?.serial) return;
    setLoading(true);
    setError("");
    try {
      const nextApps = await DeviceService.listApps(appSource.serial, false);
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
  }, [open, appSource?.id]);

  const launch = async () => {
    const parsedDisplayId = Number(displayId);
    if (!launchTargets.length || !packageName || busy || (launchMode === "display" && (!/^\d+$/.test(displayId) || parsedDisplayId > 100))) return;
    const app = apps.find((item) => item.packageName === packageName);
    setBusy(true);
    setError("");
    setStatusText(launchTargets.length > 1
      ? t("devices.quickLaunch.launchingBatch", { pkg: packageName, n: launchTargets.length })
      : t("devices.quickLaunch.launching", { pkg: packageName }));
    try {
      const failures: string[] = [];
      for (const device of launchTargets) {
        try {
          const result = launchMode === "display"
            ? await DeviceService.startAppOnDisplay(device.serial, packageName, parsedDisplayId)
            : await DeviceService.startApp(device.serial, packageName);
          if (!result.success) failures.push(`${device.name}: ${result.stderr || result.stdout || t("devices.quickLaunch.failed")}`);
        } catch (cause) {
          failures.push(`${device.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (failures.length > 0) {
        const summary = launchTargets.length > 1
          ? t("devices.quickLaunch.partialFailed", { failed: failures.length, total: launchTargets.length })
          : failures[0];
        const message = `${summary}: ${failures[0]}`;
        setError(message);
        setStatusText(message);
      } else {
        setStatusText(launchTargets.length > 1
          ? t("devices.quickLaunch.startedCount", { n: launchTargets.length })
          : t("devices.quickLaunch.started", { pkg: app?.label || packageName }));
      }
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
            <span>{t("devices.quickLaunch.scope")}</span>
            <select aria-label={t("devices.quickLaunch.scope")} value={scope} onChange={(event) => setScope(event.target.value as "current" | "selected")} disabled={loading || busy}>
              <option value="current">{t("devices.quickLaunch.scopeCurrent")}</option>
              <option value="selected" disabled={selectedOnlineDevices.length === 0}>{t("devices.quickLaunch.scopeSelected", { n: selectedOnlineDevices.length })}</option>
            </select>
          </label>
          <label>
            <span>{t("devices.quickLaunch.device")}</span>
            <select aria-label={t("devices.quickLaunch.device")} value={target?.id ?? ""} onChange={(event) => setDeviceId(event.target.value)} disabled={loading || busy || scope === "selected"}>
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
          <label>
            <span>{t("devices.quickLaunch.mode")}</span>
            <select aria-label={t("devices.quickLaunch.mode")} value={launchMode} onChange={(event) => setLaunchMode(event.target.value as "normal" | "display")} disabled={loading || busy}>
              <option value="normal">{t("devices.quickLaunch.modeNormal")}</option>
              <option value="display">{t("devices.quickLaunch.modeDisplay")}</option>
            </select>
          </label>
          {launchMode === "display" ? (
            <label>
              <span>{t("devices.quickLaunch.displayId")}</span>
              <input aria-label={t("devices.quickLaunch.displayId")} type="number" min={0} max={100} inputMode="numeric" value={displayId} onChange={(event) => setDisplayId(event.target.value)} placeholder={t("devices.quickLaunch.displayIdHint")} />
            </label>
          ) : null}
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} aria-label={t("devices.quickLaunch.refresh")} disabled={!target || loading || busy} onClick={() => void loadApps()}>
            {t("devices.quickLaunch.refresh")}
          </Button>
          <Button size="sm" variant="primary" icon={<Play size={13} />} loading={busy} disabled={!launchTargets.length || !packageName || loading || busy || (launchMode === "display" && (!/^\d+$/.test(displayId) || Number(displayId) > 100))} onClick={() => void launch()}>
            {busy ? t("devices.quickLaunch.launchingShort") : t("devices.quickLaunch.launch")}
          </Button>
          {error ? <span className="quick-app-launcher-error" role="alert">{error}</span> : null}
        </div>
      )}
    </div>
  );
}
