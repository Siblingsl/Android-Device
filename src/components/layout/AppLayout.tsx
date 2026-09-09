import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { StatusBar } from "./StatusBar";
import { DetailPanel } from "./DetailPanel";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { ActivityDrawer } from "./ActivityDrawer";
import { useAppStore } from "../../stores/appStore";
import { DeviceService } from "../../services/deviceService";
import { tStatic } from "../../i18n/static";
import clsx from "clsx";

async function runAutoStart() {
  const { settings, devices, setStatusText } = useAppStore.getState();
  const ids = settings?.autoStartDeviceIds ?? [];
  if (!ids.length) return;
  setStatusText(tStatic("common.autostart.starting", { n: ids.length }));
  let skipped = 0;
  const missing: string[] = [];
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    const outcomes: PromiseSettledResult<void>[] = [];
    while (queue.length) {
      const id = queue.shift();
      if (!id) break;
      try {
        // Devices swap ids between serial (online) and container id (offline);
        // match all stable keys so saved auto-start entries keep working.
        const d = devices.find(
          (x) => x.id === id || x.serial === id || x.containerId === id,
        );
        if (!d) {
          missing.push(id);
          void DeviceService.appendLog("WARN", "System", tStatic("common.autostart.skipMissing", { id }));
          throw new Error("missing");
        }
        if (d.online && d.adbStatus === "device") {
          skipped += 1;
          void DeviceService.appendLog("INFO", "System", tStatic("common.autostart.skipOnline", { name: d.name }));
          outcomes.push({ status: "fulfilled", value: undefined });
          continue;
        }
        if (d.containerId && !(d.online && d.adbStatus === "device")) {
          const r = await DeviceService.startContainer(d.containerId);
          if (!r.success) {
            const reason = r.stderr || r.stdout || tStatic("common.autostart.startFailed");
            void DeviceService.appendLog("ERROR", "Docker", tStatic("common.autostart.failed", { name: d.name, reason }));
            throw new Error(reason);
          }
        }
        if (d.serial.includes(":")) {
          const c = await DeviceService.connect(d.serial);
          if (!c.success) {
            const reason = c.stderr || c.stdout || tStatic("common.autostart.adbNotReady");
            void DeviceService.appendLog("WARN", "ADB", tStatic("common.autostart.adbTimeout", { name: d.name, reason }));
            throw new Error(reason);
          }
        } else {
          void DeviceService.appendLog(
            "INFO",
            "System",
            tStatic("common.autostart.containerOnly", { name: d.name }),
          );
        }
        void DeviceService.appendLog("INFO", "System", tStatic("common.autostart.ok", { name: d.name, serial: d.serial }));
        outcomes.push({ status: "fulfilled", value: undefined });
      } catch {
        outcomes.push({ status: "rejected", reason: undefined });
      }
    }
    return outcomes;
  });
  const nested = await Promise.all(workers);
  const results = nested.flat();
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.length - ok;
  // Entries that match no device are containers deleted outside the app (or
  // lost to an engine crash); they would fail auto-start on every launch.
  // Only prune when the device list is non-empty, i.e. Docker is reachable —
  // an empty list means the engine is down and matching proves nothing.
  if (missing.length && devices.length > 0 && settings) {
    const kept = ids.filter((id) => !missing.includes(id));
    await useAppStore.getState().saveSettings({ ...settings, autoStartDeviceIds: kept });
    void DeviceService.appendLog(
      "INFO",
      "System",
      tStatic("common.autostart.pruned", { n: missing.length, ids: missing.join(", ") }),
    );
  }
  await useAppStore.getState().refreshDevices();
  useAppStore
    .getState()
    .setStatusText(
      tStatic("common.autostart.done", { ok: ok - skipped }) +
      (skipped ? tStatic("common.autostart.doneSkipped", { n: skipped }) : "") +
      (fail ? tStatic("common.autostart.doneFailed", { n: fail }) : ""),
    );
}

export function AppLayout() {
  const location = useLocation();
  const detailOpen = useAppStore((s) => s.detailOpen);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const language = useAppStore((s) => s.settings?.language);
  const booted = useRef(false);

  useEffect(() => {
    if (language) document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      await loadSettings();
      await refreshStatus();
      await refreshDevices();
      void runAutoStart();
    })();
  }, [loadSettings, refreshStatus, refreshDevices]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refreshStatus();
      void refreshDevices();
    };
    const t = setInterval(tick, 15000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshStatus, refreshDevices]);

  return (
    <div className={clsx("app-shell", detailOpen && "detail-open")}>
      <WorkspaceHeader />
      <div className="main-area">
        <div className="content">
          <div key={location.pathname} className="page-fade">
            <Outlet />
          </div>
        </div>
      </div>
      <ActivityDrawer />
      <DetailPanel />
      <StatusBar />
    </div>
  );
}
