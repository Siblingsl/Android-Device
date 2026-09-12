import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DeviceStream } from "../components/device/DeviceStream";
import { DeviceService } from "../services/deviceService";
import { updateArrangementBounds } from "../stores/layoutStore";
import type { DeviceInfo } from "../types";

export function DeviceWindowPage() {
  const deviceId = new URLSearchParams(window.location.search).get("device") || "";
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("准备打开设备窗口");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (!deviceId) {
        setLoading(false);
        setStatus("缺少设备标识");
        return;
      }
      try {
        const next = await DeviceService.getDevice(deviceId);
        if (!disposed) {
          setDevice(next);
          setStatus(next ? "设备独立窗口" : "设备不存在或已被移除");
          if (next) document.title = `${next.name || next.serial} · Just Run`;
        }
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || !("__TAURI_INTERNALS__" in window)) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let timer: number | undefined;
    let writing = false;
    const persistBounds = async () => {
      if (disposed || writing) return;
      writing = true;
      try {
        const [position, size, scale] = await Promise.all([
          appWindow.outerPosition(),
          appWindow.innerSize(),
          appWindow.scaleFactor(),
        ]);
        if (disposed) return;
        const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
        updateArrangementBounds(
          deviceId,
          position.x / factor,
          position.y / factor,
          size.width / factor,
          size.height / factor,
        );
      } catch {
        // Browser preview and a window being torn down have no usable bounds.
      } finally {
        writing = false;
      }
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void persistBounds(), 180);
    };
    void persistBounds();
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    void appWindow.onMoved(schedule).then((unlisten) => { unlistenMoved = unlisten; }).catch(() => undefined);
    void appWindow.onResized(schedule).then((unlisten) => { unlistenResized = unlisten; }).catch(() => undefined);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, [deviceId]);

  const online = Boolean(device?.online && device.adbStatus === "device");

  return (
    <main className="native-device-window">
      <header className="native-device-window-head">
        <div>
          <strong>{device?.name || deviceId || "设备"}</strong>
          <span className="mono muted">{device?.serial || deviceId}</span>
        </div>
        <span className={`badge ${online ? "online" : "offline"}`}>{online ? "在线" : loading ? "加载中" : "离线"}</span>
      </header>
      {device ? (
        <DeviceStream
          serial={device.serial}
          deviceId={device.id}
          resolution={device.resolution}
          disabled={!online}
          setStatusText={setStatus}
          onTakeScreenshot={() => void DeviceService.screenshot(device.serial).then((result) => setStatus(result.success ? `截图已保存：${result.path}` : result.error || "截图失败")).catch((error) => setStatus(`截图失败：${error instanceof Error ? error.message : String(error)}`))}
        />
      ) : (
        <div className="native-device-window-empty">{status}</div>
      )}
      <footer className="native-device-window-status muted">{status}</footer>
    </main>
  );
}
