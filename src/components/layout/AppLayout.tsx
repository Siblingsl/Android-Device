import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { DetailPanel } from "./DetailPanel";
import { useAppStore } from "../../stores/appStore";
import { DeviceService } from "../../services/deviceService";
import { RUNTIME_ROUTE, resolveRuntimeTrack } from "../../lib/runtimeTrack";
import { tStatic } from "../../i18n";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { autoConnectDeviceIds, getDeviceMetadata } from "../../lib/deviceMetadata";
import { arrangementAutoRestoreEnabled, readArrangement } from "../../stores/layoutStore";
import { dueTasks, markTaskRun, prepareScheduledTask, recordScheduledResult, SCHEDULER_STORAGE_KEY, createScheduledTask, type ScheduledTask } from "../../lib/scheduler";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript, type AutomationScript } from "../../lib/automation";
import { executeAutomationScript } from "../../lib/automationRuntime";

async function runAutoStart() {
  const { settings, devices, setStatusText } = useAppStore.getState();
  const ids = [...new Set([...(settings?.autoStartDeviceIds ?? []), ...autoConnectDeviceIds()])];
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
        const metadata = getDeviceMetadata(d.id);
        if (d.online && d.adbStatus === "device") {
          if (metadata.autoMirror && d.serial) {
            const mirror = await DeviceService.scrcpyStart(d.serial);
            if (!mirror.success) throw new Error(mirror.stderr || mirror.stdout || "自动投屏失败");
          }
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
        if (metadata.autoMirror && d.serial) {
          const mirror = await DeviceService.scrcpyStart(d.serial);
          if (!mirror.success) throw new Error(mirror.stderr || mirror.stdout || "自动投屏失败");
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
  const devices = useAppStore((s) => s.devices);
  const language = useAppStore((s) => s.settings?.language);
  const closeToTray = useAppStore((s) => Boolean(s.settings?.closeToTray));
  const defaultTrack = useAppStore((s) => s.settings?.defaultTrack);
  const booted = useRef(false);
  const restoredArrangementIds = useRef(new Set<string>());
  // `/containers` is the merged page: `.app-shell` keeps carrying the active
  // track's page scope class (`page-docker` / `page-qemu`) so the per-track
  // layout rules in global.css — grid columns, scroll container, the QEMU card
  // flex/overflow fixes — apply to the mounted panel exactly as on the old
  // routes. Every other route is unaffected.
  const pageKey = location.pathname.startsWith("/devices/")
    ? "device-detail"
    : location.pathname === RUNTIME_ROUTE
      ? resolveRuntimeTrack(new URLSearchParams(location.search).get("track"), defaultTrack)
      : location.pathname.split("/")[1] || "dashboard";

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
    if (!arrangementAutoRestoreEnabled() || !devices.length || !("__TAURI_INTERNALS__" in window)) return;
    const layouts = readArrangement(devices);
    const pending = layouts.filter((item) => {
      const device = devices.find((candidate) => candidate.id === item.id);
      return Boolean(device && device.online && device.adbStatus === "device" && !restoredArrangementIds.current.has(item.id));
    });
    if (!pending.length) return;
    pending.forEach((item) => restoredArrangementIds.current.add(item.id));
    void Promise.allSettled(pending.map(async (item) => {
      const device = devices.find((candidate) => candidate.id === item.id);
      if (!device) return;
      await DeviceService.openDeviceWindow(
        device.id,
        device.name || device.serial,
        item.x,
        item.y,
        item.width * (item.span === 2 ? 2 : 1),
        item.height,
      );
    })).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) useAppStore.getState().setStatusText(`自动恢复窗口失败 ${failed} 个`);
      else useAppStore.getState().setStatusText(`已按保存布局恢复 ${pending.length} 个独立窗口`);
    });
  }, [devices]);

  useEffect(() => {
    let active = true;
    const runningTaskIds = new Set<string>();
    const tick = async () => {
      if (!active) return;
      let tasks: ScheduledTask[] = [];
      try {
        const raw = JSON.parse(localStorage.getItem(SCHEDULER_STORAGE_KEY) || "[]") as unknown;
        tasks = Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object").map((item) => prepareScheduledTask(createScheduledTask(item as Partial<ScheduledTask>))) : [];
      } catch { return; }
      const due = dueTasks(tasks, new Date(), runningTaskIds);
      if (!due.length) return;
      const now = new Date();
      const marked = tasks.map((task) => due.some((item) => item.id === task.id) ? markTaskRun(task, now) : task);
      try { localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(marked)); } catch { /* ignore */ }
      const devices = useAppStore.getState().devices;
      for (const task of due) {
        runningTaskIds.add(task.id);
        const device = devices.find((item) => item.id === task.targetDeviceId || item.serial === task.targetDeviceId || item.containerId === task.targetDeviceId);
        try {
          if (!device) throw new Error("目标设备不存在");
          const online = device.online && device.adbStatus === "device";
          let result: { success: boolean; stderr?: string; stdout?: string } | undefined;
          if (task.action === "start-device") result = device.containerId
            ? await DeviceService.startContainer(device.containerId)
            : online
              ? { success: true, stdout: "设备已在线" }
              : { success: false, stderr: "设备没有关联可启动的容器" };
          else if (task.action === "stop-device") result = device.containerId ? await DeviceService.stopContainer(device.containerId) : { success: false, stderr: "设备没有关联容器" };
          else {
            if (!online) throw new Error("目标设备未在线");
            if (task.action === "launch-app") result = await DeviceService.startApp(device.serial, task.payload.trim());
            if (task.action === "install-apk") result = await DeviceService.installApk(device.serial, task.payload.trim(), true);
            if (task.action === "run-script") {
              let scripts: AutomationScript[] = [];
              try {
                const rawScripts = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
                scripts = Array.isArray(rawScripts) ? rawScripts.filter((item) => Boolean(item) && typeof item === "object").map((item) => normalizeAutomationScript(item as Record<string, unknown>)) : [];
              } catch { scripts = []; }
              const script = scripts.find((item) => item.id === task.payload || item.name === task.payload);
              if (!script) throw new Error("定时任务对应的自动化脚本不存在");
              await executeAutomationScript(script, { serial: device.serial, id: device.id, name: device.name });
              result = { success: true, stdout: `脚本已完成：${script.name}` };
            }
            if (task.action === "screenshot") { const shot = await DeviceService.screenshot(device.serial); result = { success: shot.success, stderr: shot.error }; }
            if (task.action === "recording-start") { const recording = await DeviceService.recordingStart(device.serial, "video"); result = { success: recording.status === "running", stderr: recording.message }; }
            if (task.action === "recording-stop") result = await DeviceService.recordingStop(device.serial);
            if (task.action === "shell") result = await DeviceService.shell(device.serial, task.payload);
          }
          if (!result?.success) throw new Error(result?.stderr || result?.stdout || "任务执行失败");
          tasks = recordScheduledResult(tasks, task.id, true, result.stdout || "执行完成");
          try { localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(tasks)); } catch { /* ignore */ }
          void DeviceService.appendLog("INFO", "Scheduler", `定时任务完成：${task.name}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          tasks = recordScheduledResult(tasks, task.id, false, reason);
          try { localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(tasks)); } catch { /* ignore */ }
          useAppStore.getState().setStatusText(`定时任务失败：${task.name} · ${reason}`);
          void DeviceService.appendLog("ERROR", "Scheduler", `定时任务失败：${task.name} · ${reason}`);
        } finally {
          runningTaskIds.delete(task.id);
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<string>("rdc://navigate", (event) => {
      window.location.hash = event.payload;
    }).then((unlisten) => { dispose = unlisten; }).catch(() => {
      /* browser preview has no Tauri event bridge */
    });
    return () => dispose?.();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (!closeToTray) return;
    const appWindow = getCurrentWindow();
    let dispose: (() => void) | undefined;
    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await appWindow.hide();
    }).then((unlisten) => { dispose = unlisten; }).catch(() => {
      /* Browser preview and unsupported shells have no native close event. */
    });
    return () => dispose?.();
  }, [closeToTray]);

  useEffect(() => {
    if (!useAppStore.getState().settings?.edgeHide) return;
    const appWindow = getCurrentWindow();
    let tucked = false;
    let restoreX = 0;
    let restoreY = 0;
    let timer: number | undefined;
    const checkEdge = async () => {
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const position = await appWindow.outerPosition();
        const size = await appWindow.outerSize();
        const cursor = await cursorPosition();
        const left = monitor.position.x;
        const right = left + monitor.size.width;
        const nearEdge = Math.abs(position.x - left) <= 4 || Math.abs(position.x + size.width - right) <= 4;
        if (tucked) {
          if (cursor.x <= left + 14 || cursor.x >= right - 14) {
            await appWindow.setPosition(new PhysicalPosition(restoreX, restoreY));
            tucked = false;
          }
          return;
        }
        if (nearEdge && !(await appWindow.isFocused()) && cursor.x > left + 14 && cursor.x < right - 14) {
          restoreX = position.x;
          restoreY = position.y;
          const hideX = position.x <= left + 4 ? left - size.width + 14 : right - 14;
          await appWindow.setPosition(new PhysicalPosition(hideX, position.y));
          tucked = true;
        }
      } catch {
        /* browser preview or a platform without window positioning */
      }
    };
    timer = window.setInterval(() => void checkEdge(), 700);
    return () => { if (timer !== undefined) window.clearInterval(timer); };
  }, [useAppStore((state) => state.settings?.edgeHide)]);

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
    <div className={clsx("app-shell", `page-${pageKey}`, detailOpen && "detail-open")}>
      <Sidebar />
      <main className="main-area">
        <div className="content">
          <div key={location.pathname} className="page-fade">
            <Outlet />
          </div>
        </div>
      </main>
      <DetailPanel />
      <StatusBar />
    </div>
  );
}
