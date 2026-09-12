import { useEffect, useRef, useState } from "react";
import { Camera, Clipboard, ClipboardCheck, Expand, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { DeviceService } from "../../services/deviceService";
import { Button } from "../ui/Button";
import { getStreamPresentation, mapContainedPoint } from "../../lib/streamState";
import { parseScrcpyStreamOptions } from "../../lib/streamOptions";
import { normalizeClipboardText } from "../../lib/clipboard";
import { KEYBOARD_MAPPING_STORAGE_KEY, matchingMapping, normalizeMapping, parseForegroundPackage, type KeyboardMapping } from "../../lib/keyboardMapping";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript, type AutomationScript } from "../../lib/automation";
import { executeAutomationScript } from "../../lib/automationRuntime";
import { getDeviceMetadata } from "../../lib/deviceMetadata";
import { resolveStoredScrcpyArgs } from "../../lib/scrcpyPreferences";

interface Props {
  serial: string;
  deviceId?: string;
  resolution?: string;
  disabled?: boolean;
  setStatusText: (text: string) => void;
  onTakeScreenshot?: () => void;
}

function parseResolution(raw?: string) {
  const match = (raw || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return { width: 1080, height: 1920 };
  return { width: Number(match[1]) || 1080, height: Number(match[2]) || 1920 };
}

function readScrcpyOptions(serial: string, deviceId: string) {
  try {
    const raw = sessionStorage.getItem(`rdc.settings.draft.${serial}`);
    const draftArgs = raw ? String((JSON.parse(raw) as { scrcpyArgs?: string }).scrcpyArgs || "") : "";
    const args = draftArgs || resolveStoredScrcpyArgs(
      serial,
      getDeviceMetadata(deviceId).group,
      "--max-size 1080 --video-bit-rate 8M",
    );
    return parseScrcpyStreamOptions(args);
  } catch {
    return parseScrcpyStreamOptions(resolveStoredScrcpyArgs(
      serial,
      getDeviceMetadata(deviceId).group,
      "--max-size 1080 --video-bit-rate 8M",
    ));
  }
}

function readAutomationScript(id: string): AutomationScript | undefined {
  if (!id) return undefined;
  try {
    const raw = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(raw)) return undefined;
    const value = raw.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === id);
    return value && typeof value === "object" ? normalizeAutomationScript(value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const ANDROID_KEYCODES: Record<string, number> = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Delete: 112,
  Home: 3,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Space: 62,
};

const CLIPBOARD_AUTOSYNC_KEY = "rdc.stream.clipboardAutosync";

export function DeviceStream({
  serial,
  deviceId = serial,
  resolution,
  disabled = false,
  setStatusText,
  onTakeScreenshot,
}: Props) {
  const [status, setStatus] = useState<"stopped" | "starting" | "running" | "error">("stopped");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(100);
  const [clipboardAutoSync, setClipboardAutoSync] = useState(() => {
    try {
      return localStorage.getItem(`${CLIPBOARD_AUTOSYNC_KEY}.${serial}`) === "1";
    } catch {
      return false;
    }
  });
  const areaRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastDeviceClipboardRef = useRef<string | null>(null);
  const lastHostClipboardRef = useRef<string | null>(null);
  const lastPushedClipboardRef = useRef<string | null>(null);
  const clipboardSyncBusyRef = useRef(false);
  const streamGenerationRef = useRef(0);
  const joystickMappingsRef = useRef(new Map<string, KeyboardMapping>());
  const automationKeysRef = useRef(new Set<string>());
  const foregroundPackageRef = useRef("");
  const { width, height } = parseResolution(resolution);
  const online = !disabled;
  const presentation = getStreamPresentation({
    online,
    adbStatus: online ? "device" : "offline",
    streamStatus: status,
  });
  const sync = async () => {
    try {
      const session = await DeviceService.scrcpyStreamStatus(serial);
      setStatus(session.status);
      setUrl(session.url);
      setMessage(session.message);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    try {
      setClipboardAutoSync(localStorage.getItem(`${CLIPBOARD_AUTOSYNC_KEY}.${serial}`) === "1");
    } catch {
      setClipboardAutoSync(false);
    }
  }, [serial]);

  useEffect(() => {
    if (disabled) {
      setStatus("stopped");
      setUrl("");
      return;
    }
    void sync();
    const timer = window.setInterval(() => void sync(), 4000);
    return () => window.clearInterval(timer);
  }, [serial, disabled]);

  useEffect(() => {
    foregroundPackageRef.current = "";
    if (disabled || status !== "running") return;
    let active = true;
    const refreshForegroundPackage = async () => {
      try {
        const result = await DeviceService.shell(serial, "dumpsys window windows");
        if (active && result.success) foregroundPackageRef.current = parseForegroundPackage(result.stdout);
      } catch {
        // App-scoped mappings remain inactive when foreground inspection is unavailable.
      }
    };
    void refreshForegroundPackage();
    const timer = window.setInterval(() => void refreshForegroundPackage(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [disabled, serial, status]);

  useEffect(() => {
    if (!clipboardAutoSync || status !== "running" || disabled) return;
    let active = true;
    lastDeviceClipboardRef.current = null;
    lastHostClipboardRef.current = null;
    lastPushedClipboardRef.current = null;

    const syncClipboard = async () => {
      if (!active || clipboardSyncBusyRef.current) return;
      clipboardSyncBusyRef.current = true;
      try {
        const device = await DeviceService.readClipboard(serial);
        if (device.success) {
          const deviceText = normalizeClipboardText(device.stdout);
          const changed = lastDeviceClipboardRef.current !== deviceText;
          lastDeviceClipboardRef.current = deviceText;
          if (
            changed
            && deviceText !== lastPushedClipboardRef.current
            && deviceText !== lastHostClipboardRef.current
            && navigator.clipboard
          ) {
            try {
              await navigator.clipboard.writeText(deviceText);
              lastHostClipboardRef.current = deviceText;
            } catch {
              // Clipboard permission can be unavailable in a browser preview.
            }
          }
        }

        if (!navigator.clipboard) return;
        try {
          const hostText = await navigator.clipboard.readText();
          if (
            hostText !== lastHostClipboardRef.current
            && hostText !== lastDeviceClipboardRef.current
            && hostText !== lastPushedClipboardRef.current
          ) {
            const result = await DeviceService.sendClipboard(serial, hostText);
            if (result.success) {
              lastHostClipboardRef.current = hostText;
              lastPushedClipboardRef.current = hostText;
            }
          }
        } catch {
          // Reading the host clipboard requires a user-granted permission.
        }
      } finally {
        clipboardSyncBusyRef.current = false;
      }
    };

    void syncClipboard();
    const timer = window.setInterval(() => void syncClipboard(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [clipboardAutoSync, disabled, serial, status]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === areaRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    streamGenerationRef.current += 1;
    return () => {
      streamGenerationRef.current += 1;
      // The stream is owned by this device-detail workbench. Stop it even
      // when navigation happens while startup is still awaiting the backend;
      // otherwise a late successful start can leave an orphaned scrcpy/ffmpeg
      // pair with no UI left to control it.
      void DeviceService.scrcpyStreamStop(serial).catch(() => undefined);
      for (const mapping of joystickMappingsRef.current.values()) {
        void DeviceService.swipe(serial, mapping.x2, mapping.y2, mapping.x, mapping.y, Math.min(mapping.duration, 300));
      }
      joystickMappingsRef.current.clear();
      automationKeysRef.current.clear();
    };
  }, [serial]);

  const start = async () => {
    if (!online) return;
    const generation = streamGenerationRef.current;
    setStatus("starting");
    setMessage("正在启动内嵌投屏…");
    setStatusText("正在启动内嵌投屏");
    const options = readScrcpyOptions(serial, deviceId);
    try {
      const session = await DeviceService.scrcpyStreamStart(
        serial,
        options.maxSize,
        options.bitRate,
        options.extra,
      );
      if (streamGenerationRef.current !== generation) {
        // Navigation can unmount the workbench while the backend is still
        // starting. Reconcile the late result so no orphaned process remains.
        void DeviceService.scrcpyStreamStop(serial).catch(() => undefined);
        return;
      }
      setStatus(session.status);
      setUrl(session.url);
      setMessage(session.message);
      setStatusText(session.status === "running" ? "内嵌投屏已启动" : session.message);
    } catch (error) {
      if (streamGenerationRef.current !== generation) return;
      const reason = error instanceof Error ? error.message : String(error);
      setStatus("error");
      setUrl("");
      setMessage(reason);
      setStatusText(reason);
    }
  };

  const stop = async () => {
    try {
      const result = await DeviceService.scrcpyStreamStop(serial);
      setStatus(result.success ? "stopped" : "error");
      if (result.success) setUrl("");
      setMessage(result.success ? "内嵌投屏已停止" : result.stderr || result.stdout || "停止投屏失败");
      setStatusText(result.success ? "内嵌投屏已停止" : result.stderr || result.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatus("error");
      setMessage(reason);
      setStatusText(reason);
    }
  };

  const reconnect = async () => {
    if (!online) return;
    setStatus("starting");
    setMessage("正在重建投屏会话…");
    try {
      const stopped = await DeviceService.scrcpyStreamStop(serial);
      if (!stopped.success) throw new Error(stopped.stderr || stopped.stdout || "旧投屏会话停止失败");
      await start();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatus("error");
      setUrl("");
      setMessage(reason);
      setStatusText(reason);
    }
  };

  const point = (event: React.PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return mapContainedPoint(rect, width, height, event.clientX, event.clientY);
  };

  const toggleFullscreen = () => {
    const element = areaRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) void document.exitFullscreen();
    else void element.requestFullscreen().catch((error: unknown) => setMessage(String(error)));
  };

  const sendHostClipboard = async () => {
    try {
      const content = await navigator.clipboard.readText();
      if (!content) {
        setMessage("本机剪贴板为空");
        return;
      }
      const result = await DeviceService.sendClipboard(serial, content);
      if (result.success) {
        lastHostClipboardRef.current = content;
        lastPushedClipboardRef.current = content;
      }
      setStatusText(result.success ? "本机剪贴板已发送到设备" : result.stderr || result.stdout || "发送剪贴板失败");
    } catch (error) {
      setStatusText(`读取本机剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readDeviceClipboard = async () => {
    try {
      const result = await DeviceService.readClipboard(serial);
      if (!result.success) throw new Error(result.stderr || result.stdout || "读取设备剪贴板失败");
      const content = normalizeClipboardText(result.stdout);
      await navigator.clipboard.writeText(content);
      lastDeviceClipboardRef.current = content;
      lastHostClipboardRef.current = content;
      setStatusText("设备剪贴板已写回本机");
    } catch (error) {
      setStatusText(`读取设备剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleMappedKey = (event: React.KeyboardEvent<HTMLImageElement>) => {
    if (status !== "running") return;
    try {
      const raw = JSON.parse(localStorage.getItem(KEYBOARD_MAPPING_STORAGE_KEY) || "[]") as unknown;
      const mappings = Array.isArray(raw) ? raw.map((item) => normalizeMapping(item as Partial<KeyboardMapping>)) : [];
      const mapping = matchingMapping(mappings, event.key, deviceId, foregroundPackageRef.current) ?? matchingMapping(mappings, event.code, deviceId, foregroundPackageRef.current);
      if (mapping) {
        event.preventDefault();
        if (mapping.action === "tap") void DeviceService.tap(serial, mapping.x, mapping.y);
        if (mapping.action === "long-press") void DeviceService.longPress(serial, mapping.x, mapping.y, mapping.duration);
        if (mapping.action === "swipe") void DeviceService.swipe(serial, mapping.x, mapping.y, mapping.x2, mapping.y2, mapping.duration);
        if (mapping.action === "joystick") {
          const key = event.code || event.key;
          if (!joystickMappingsRef.current.has(key)) {
            joystickMappingsRef.current.set(key, mapping);
            void DeviceService.swipe(serial, mapping.x, mapping.y, mapping.x2, mapping.y2, mapping.duration);
          }
        }
        if (mapping.action === "scroll") void DeviceService.swipe(serial, mapping.x, mapping.y, mapping.x, mapping.y - mapping.duration, 200);
        if (mapping.action === "keyevent") void DeviceService.keyevent(serial, mapping.keyCode);
        if (mapping.action === "automation") {
          const key = event.code || event.key;
          if (!automationKeysRef.current.has(key)) {
            automationKeysRef.current.add(key);
            const script = readAutomationScript(mapping.automationId);
            if (!script) {
              automationKeysRef.current.delete(key);
              setStatusText("自动化映射对应的脚本不存在或已被删除");
            } else {
              void executeAutomationScript(script, { serial, id: deviceId, name: deviceId })
                .then(() => setStatusText(`已执行自动化脚本：${script.name}`))
                .catch((error: unknown) => setStatusText(`自动化映射执行失败：${error instanceof Error ? error.message : String(error)}`));
            }
          }
        }
        return;
      }
      const keyCode = ANDROID_KEYCODES[event.key];
      if (keyCode) {
        event.preventDefault();
        void DeviceService.keyevent(serial, keyCode);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        void DeviceService.text(serial, event.key);
      }
    } catch {
      // A malformed local mapping must never break stream keyboard input.
    }
  };

  const handleMappedKeyUp = (event: React.KeyboardEvent<HTMLImageElement>) => {
    const key = event.code || event.key;
    const mapping = joystickMappingsRef.current.get(key);
    if (mapping) {
      event.preventDefault();
      joystickMappingsRef.current.delete(key);
      void DeviceService.swipe(serial, mapping.x2, mapping.y2, mapping.x, mapping.y, Math.min(mapping.duration, 300));
    }
    automationKeysRef.current.delete(key);
  };

  const releaseMappedKeys = () => {
    for (const mapping of joystickMappingsRef.current.values()) {
      void DeviceService.swipe(serial, mapping.x2, mapping.y2, mapping.x, mapping.y, Math.min(mapping.duration, 300));
    }
    joystickMappingsRef.current.clear();
    automationKeysRef.current.clear();
  };

  const stopLegacyHandlers = (event: { stopPropagation: () => void }) => {
    if (status === "running") event.stopPropagation();
  };

  return (
    <div
      ref={areaRef}
      className={`device-stream ${status === "running" ? "is-running" : "is-idle"}`}
      aria-label="内嵌设备投屏"
      onClick={stopLegacyHandlers}
      onMouseDown={stopLegacyHandlers}
      onMouseUp={stopLegacyHandlers}
      onWheel={stopLegacyHandlers}
      onContextMenu={stopLegacyHandlers}
      onAuxClick={stopLegacyHandlers}
    >
      <div className="device-stream-toolbar">
        <div className="row">
          {status === "running" ? (
            <Button size="sm" variant="primary" icon={<Square size={13} />} onClick={() => void stop()}>
              停止投屏
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!online || status === "starting"}
              loading={status === "starting"}
              onClick={() => void start()}
            >
              {presentation.label === "需在线" ? "需在线" : "启动投屏"}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={!online || status === "starting"} onClick={() => void reconnect()}>
            <RotateCcw size={13} />
            重连
          </Button>
          <Button size="sm" variant="ghost" disabled={status !== "running"} onClick={toggleFullscreen}>
            <Expand size={13} />
            {fullscreen ? "退出全屏" : "全屏"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!online || !onTakeScreenshot} onClick={onTakeScreenshot}>
            <Camera size={13} />
            截图
          </Button>
          <Button size="sm" variant="ghost" disabled={!online} onClick={() => void DeviceService.rotate(serial, true).then((result) => setStatusText(result.success ? "设备已旋转" : result.stderr || result.stdout || "旋转失败"))}>
            旋转
          </Button>
          <Button size="sm" variant="ghost" disabled={!online} onClick={() => void sendHostClipboard()} title="把本机剪贴板发送到设备">
            <Clipboard size={13} />
            发送剪贴板
          </Button>
          <Button size="sm" variant="ghost" disabled={!online} onClick={() => void readDeviceClipboard()} title="把设备剪贴板写回本机">
            <ClipboardCheck size={13} />
            读取剪贴板
          </Button>
          <label className="device-stream-clipboard-sync" title="设备和本机剪贴板每 2 秒尝试同步；需要操作系统剪贴板权限">
            <input
              type="checkbox"
              checked={clipboardAutoSync}
              disabled={!online}
              onChange={(event) => {
                const enabled = event.target.checked;
                setClipboardAutoSync(enabled);
                try { localStorage.setItem(`${CLIPBOARD_AUTOSYNC_KEY}.${serial}`, enabled ? "1" : "0"); } catch { /* optional persistence */ }
              }}
            />
            自动同步
          </label>
          <label className="device-stream-scale" title="调整投屏显示比例">
            缩放
            <select value={scale} onChange={(event) => setScale(Number(event.target.value))} aria-label="投屏缩放">
              {[50, 75, 100, 125, 150].map((value) => <option key={value} value={value}>{value}%</option>)}
            </select>
          </label>
        </div>
        <span className={`badge ${presentation.kind === "running" ? "online" : presentation.kind === "error" ? "offline" : "info"}`}>
          {presentation.kind === "starting" && <LoaderCircle className="create-spinner" size={12} />}
          {presentation.label}
        </span>
      </div>

      {status === "running" && url ? (
        <img
          className="device-stream-image"
          tabIndex={0}
          src={`${url}?serial=${encodeURIComponent(serial)}`}
          alt={`${serial} 实时画面`}
          draggable={false}
          style={{ transform: `scale(${scale / 100})` }}
          onKeyDown={handleMappedKey}
          onKeyUp={handleMappedKeyUp}
          onBlur={releaseMappedKeys}
          onContextMenu={(event) => {
            event.preventDefault();
            void DeviceService.back(serial);
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              void DeviceService.home(serial);
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pointerRef.current = { ...point(event), at: Date.now() };
          }}
          onPointerUp={(event) => {
            const startPoint = pointerRef.current;
            pointerRef.current = null;
            if (!startPoint) return;
            const endPoint = point(event);
            const distance = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
            const duration = Date.now() - startPoint.at;
            void (distance > 20
              ? DeviceService.swipe(serial, startPoint.x, startPoint.y, endPoint.x, endPoint.y, Math.max(300, duration))
              : duration >= 450
                ? DeviceService.longPress(serial, endPoint.x, endPoint.y, duration)
                : DeviceService.tap(serial, endPoint.x, endPoint.y));
          }}
          onWheel={(event) => {
            const current = point(event as unknown as React.PointerEvent<HTMLImageElement>);
            const distance = event.deltaY > 0 ? 300 : -300;
            void DeviceService.swipe(serial, current.x, current.y, current.x, current.y + distance, 200);
          }}
        />
      ) : (
        <div className="device-stream-empty">
          {status === "starting" ? <LoaderCircle className="create-spinner" size={22} /> : null}
          <strong>{presentation.label}</strong>
          <span>{message || (presentation.kind === "error" ? "请检查 Scrcpy 和 FFmpeg 路径" : "启动后在这里直接操作设备")}</span>
        </div>
      )}
    </div>
  );
}
