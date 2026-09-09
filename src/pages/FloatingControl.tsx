import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSearchParams } from "react-router-dom";
import { LockKeyhole, Power, RefreshCw, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { DeviceService } from "../services/deviceService";
import { useI18n } from "../i18n";
import {
  persistControlWindowPreferences,
  readControlWindowPreferences,
  type ControlWindowPreferences,
} from "../lib/controlWindow";
import type { DeviceInfo, ShellResult } from "../types";

const DEVICE_STORAGE_KEY = "rdc.controlWindow.deviceId";

function getOptionalCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function readStoredDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
  } catch {
    /* local persistence is best effort */
  }
}

export function FloatingControlPage() {
  const { t } = useI18n();
  const currentWindow = useMemo(getOptionalCurrentWindow, []);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ControlWindowPreferences>(() => readControlWindowPreferences());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [searchParams] = useSearchParams();
  const queryDeviceId = searchParams.get("device");

  const loadDevices = async () => {
    try {
      const next = await DeviceService.listDevices();
      setDevices(next);
      setSelectedId((current) => {
        const preferred = current ?? queryDeviceId ?? readStoredDeviceId();
        const selected = next.find((device) => device.id === preferred);
        const fallback = next.find((device) => device.online && device.adbStatus === "device") ?? next[0];
        return selected?.id ?? fallback?.id ?? null;
      });
    } catch (error) {
      setMessage(String(error));
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  useEffect(() => {
    if (!currentWindow) return;

    let unlistenBlur: (() => void) | undefined;
    let unlistenDeviceChange: (() => void) | undefined;

    void currentWindow.setAlwaysOnTop(preferences.alwaysOnTop).catch(() => undefined);
    void currentWindow
      .listen<{ deviceId?: string }>("control-device-change", (event) => {
        const nextId = event.payload?.deviceId;
        if (nextId) setSelectedId(nextId);
      })
      .then((unlisten) => {
        unlistenDeviceChange = unlisten;
      })
      .catch(() => undefined);

    if (preferences.autoHide) {
      void currentWindow
        .listen("tauri://blur", () => {
          void currentWindow.hide().catch(() => undefined);
        })
        .then((unlisten) => {
          unlistenBlur = unlisten;
        })
        .catch(() => undefined);
    }

    return () => {
      unlistenBlur?.();
      unlistenDeviceChange?.();
    };
  }, [currentWindow, preferences.alwaysOnTop, preferences.autoHide]);

  const selectedDevice = devices.find((device) => device.id === selectedId) ?? null;
  const actionable = Boolean(selectedDevice?.online && selectedDevice.adbStatus === "device");

  const changeDevice = (deviceId: string) => {
    setSelectedId(deviceId);
    persistDeviceId(deviceId);
    setMessage("");
  };

  const run = async (key: string, action: string, operation: (serial: string) => Promise<ShellResult>) => {
    if (!selectedDevice || !actionable || busy) return;
    setBusy(key);
    setMessage("");
    try {
      const result = await operation(selectedDevice.serial);
      if (!result.success) {
        setMessage(result.stderr || result.stdout || t("controlWindow.actionFailed"));
      } else {
        setMessage(t("controlWindow.actionDone", { action }));
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  const updatePreference = (key: keyof ControlWindowPreferences, value: boolean) => {
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    persistControlWindowPreferences(next);
    if (key === "alwaysOnTop") {
      void currentWindow?.setAlwaysOnTop(value).catch(() => undefined);
    }
  };

  const buttonDisabled = !actionable || Boolean(busy);

  return (
    <main className="control-window-page control-window-workbench">
      <div className="control-window-header">
        <div>
          <div className="control-window-kicker">Redroid</div>
          <h1>{t("controlWindow.title")}</h1>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={14} />}
          aria-label={t("common.refresh")}
          loading={busy === "refresh"}
          onClick={() => {
            setBusy("refresh");
            void loadDevices().finally(() => setBusy(null));
          }}
        >
          {t("common.refresh")}
        </Button>
      </div>

      <Card className="control-window-device-card" padding>
        <div className="field">
          <label htmlFor="floating-control-device">{t("controlWindow.device")}</label>
          <select
            id="floating-control-device"
            aria-label={t("controlWindow.device")}
            value={selectedId ?? ""}
            onChange={(event) => changeDevice(event.target.value)}
          >
            {devices.length === 0 && <option value="">{t("controlWindow.noDevices")}</option>}
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} · {device.online ? t("common.online") : t("common.offline")}
              </option>
            ))}
          </select>
        </div>
        {selectedDevice && (
          <div className="control-window-device-meta">
            <span className={actionable ? "ok" : "bad"}>
              {actionable ? t("controlWindow.ready") : t("controlWindow.unavailable")}
            </span>
            <span className="mono">{selectedDevice.serial}</span>
          </div>
        )}
      </Card>

      <Card title={t("controlWindow.navigation")} className="control-window-card" padding>
        <div className="control-window-button-grid three">
          <Button size="sm" disabled={buttonDisabled} loading={busy === "home"} onClick={() => void run("home", "HOME", DeviceService.home)}>HOME</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "back"} onClick={() => void run("back", t("detail.control.back"), DeviceService.back)}>{t("detail.control.back")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "recent"} onClick={() => void run("recent", "RECENT", DeviceService.recent)}>RECENT</Button>
        </div>
      </Card>

      <Card title={t("controlWindow.deviceActions")} className="control-window-card" padding>
        <div className="control-window-button-grid three">
          <Button size="sm" disabled={buttonDisabled} loading={busy === "volumeDown"} icon={<Volume2 size={13} />} onClick={() => void run("volumeDown", t("detail.control.volDown"), DeviceService.volumeDown)}>{t("detail.control.volDown")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "mute"} icon={<VolumeX size={13} />} onClick={() => void run("mute", t("controlWindow.mute"), DeviceService.volumeMute)}>{t("controlWindow.mute")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "volumeUp"} icon={<Volume2 size={13} />} onClick={() => void run("volumeUp", t("detail.control.volUp"), DeviceService.volumeUp)}>{t("detail.control.volUp")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "lock"} icon={<LockKeyhole size={13} />} onClick={() => void run("lock", t("detail.control.lock"), DeviceService.lock)}>{t("detail.control.lock")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "wake"} onClick={() => void run("wake", t("detail.control.wake"), DeviceService.wake)}>{t("detail.control.wake")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "power"} variant="danger" icon={<Power size={13} />} onClick={() => void run("power", "POWER", DeviceService.power)}>POWER</Button>
        </div>
      </Card>

      <Card title={t("controlWindow.display")} className="control-window-card" padding>
        <div className="control-window-button-grid three">
          <Button size="sm" disabled={buttonDisabled} loading={busy === "portrait"} icon={<RotateCcw size={13} />} onClick={() => void run("portrait", t("detail.control.rotatePortrait"), (serial) => DeviceService.setRotationMode(serial, "portrait"))}>{t("controlWindow.portrait")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "landscape"} icon={<RotateCcw size={13} />} onClick={() => void run("landscape", t("detail.control.rotateLandscape"), (serial) => DeviceService.setRotationMode(serial, "landscape"))}>{t("controlWindow.landscape")}</Button>
          <Button size="sm" disabled={buttonDisabled} loading={busy === "screenOff"} onClick={() => void run("screenOff", t("controlWindow.screenOff"), DeviceService.screenOff)}>{t("controlWindow.screenOff")}</Button>
        </div>
      </Card>

      <Card title={t("controlWindow.window")} className="control-window-card" padding>
        <div className="control-window-preferences">
          <label className="row">
            <input type="checkbox" checked={preferences.alwaysOnTop} onChange={(event) => updatePreference("alwaysOnTop", event.target.checked)} />
            {t("controlWindow.alwaysOnTop")}
          </label>
          <label className="row">
            <input type="checkbox" checked={preferences.autoHide} onChange={(event) => updatePreference("autoHide", event.target.checked)} />
            {t("controlWindow.autoHide")}
          </label>
        </div>
        {message && <div className="control-window-message" role="status">{message}</div>}
      </Card>
    </main>
  );
}
