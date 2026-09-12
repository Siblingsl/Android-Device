import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  ChevronDown,
  ClipboardList,
  Cable,
  FileText,
  Grid2X2,
  Home,
  Lock,
  MonitorDown,
  MoreHorizontal,
  RotateCw,
  SlidersHorizontal,
  Settings2,
  TerminalSquare,
  Video,
  Volume1,
  Volume2,
  VolumeX,
  Zap,
  RefreshCw,
  PackagePlus,
} from "lucide-react";
import { askConfirm } from "../../lib/dialogs";
import { getControlActions, type DeviceActionId } from "../../lib/controlActions";
import { DeviceService } from "../../services/deviceService";
import { Button } from "../ui/Button";

interface Props {
  serial: string;
  online: boolean;
  setStatusText: (text: string) => void;
  onScreenshot?: () => void;
  onInstallApk?: () => void;
  onOpenApps?: () => void;
  onOpenNetwork?: () => void;
  onOpenScrcpyConfig?: () => void;
  onOpenFiles?: () => void;
  onOpenTerminal?: () => void;
}

const ORDER_KEY = "rdc.controlBar.order";
const HIDDEN_KEY = "rdc.controlBar.hidden";
const COLLAPSED_KEY = "rdc.controlBar.collapsed";
const FLOATING_KEY = "rdc.controlBar.floating";

function scopedKey(key: string, serial: string) {
  return `${key}.${encodeURIComponent(serial)}`;
}

const iconById: Record<DeviceActionId, typeof Home> = {
  home: Home,
  back: ChevronDown,
  recent: ClipboardList,
  power: Zap,
  lock: Lock,
  wake: MonitorDown,
  "screen-off": MonitorDown,
  rotate: RotateCw,
  "volume-up": Volume2,
  "volume-down": Volume1,
  mute: VolumeX,
  restart: RefreshCw,
  recording: Video,
  stream: MonitorDown,
  notifications: Bell,
  settings: Settings2,
  screenshot: FileText,
  "install-apk": PackagePlus,
  apps: Grid2X2,
  network: Cable,
  "scrcpy-config": SlidersHorizontal,
  files: FileText,
  terminal: TerminalSquare,
};

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function DeviceControlBar({
  serial,
  online,
  setStatusText,
  onScreenshot,
  onInstallApk,
  onOpenApps,
  onOpenNetwork,
  onOpenScrcpyConfig,
  onOpenFiles,
  onOpenTerminal,
}: Props) {
  const actions = useMemo(() => getControlActions(online), [online]);
  const ids = actions.map((action) => action.id);
  const [order, setOrder] = useState<DeviceActionId[]>(() => {
    const saved = readList(scopedKey(ORDER_KEY, serial)).filter((id): id is DeviceActionId => ids.includes(id as DeviceActionId));
    return [...saved, ...ids.filter((id) => !saved.includes(id))];
  });
  const [hidden, setHidden] = useState<DeviceActionId[]>(() =>
    readList(scopedKey(HIDDEN_KEY, serial)).filter((id): id is DeviceActionId => ids.includes(id as DeviceActionId)),
  );
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(scopedKey(COLLAPSED_KEY, serial)) === "true");
  const [floating, setFloating] = useState(() => localStorage.getItem(scopedKey(FLOATING_KEY, serial)) === "true");
  const [dragged, setDragged] = useState<DeviceActionId | null>(null);

  useEffect(() => {
    const savedOrder = readList(scopedKey(ORDER_KEY, serial)).filter((id): id is DeviceActionId => ids.includes(id as DeviceActionId));
    const savedHidden = readList(scopedKey(HIDDEN_KEY, serial)).filter((id): id is DeviceActionId => ids.includes(id as DeviceActionId));
    setOrder([...savedOrder, ...ids.filter((id) => !savedOrder.includes(id))]);
    setHidden(savedHidden);
    setCollapsed(localStorage.getItem(scopedKey(COLLAPSED_KEY, serial)) === "true");
    setFloating(localStorage.getItem(scopedKey(FLOATING_KEY, serial)) === "true");
  }, [serial, ids.join(",")]);

  useEffect(() => {
    try {
      localStorage.setItem(scopedKey(ORDER_KEY, serial), JSON.stringify(order));
      localStorage.setItem(scopedKey(HIDDEN_KEY, serial), JSON.stringify(hidden));
      localStorage.setItem(scopedKey(COLLAPSED_KEY, serial), String(collapsed));
      localStorage.setItem(scopedKey(FLOATING_KEY, serial), String(floating));
    } catch {
      /* local persistence is optional */
    }
  }, [order, hidden, collapsed, floating, serial]);

  const orderedActions = order
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is (typeof actions)[number] => action !== undefined)
    .filter((action) => !hidden.includes(action.id));

  const move = (target: DeviceActionId) => {
    if (!dragged || dragged === target) return;
    setOrder((current) => {
      const next = current.filter((id) => id !== dragged);
      const targetIndex = next.indexOf(target);
      next.splice(Math.max(0, targetIndex), 0, dragged);
      return next;
    });
    setDragged(null);
  };

  const run = async (id: DeviceActionId) => {
    const action = actions.find((item) => item.id === id);
    if (!action || action.disabled) {
      setStatusText(action?.disabledReason || "需在线");
      return;
    }
    if (action.dangerous && !(await askConfirm(`确定执行“${action.label}”吗？`))) return;
    if (id === "files") {
      onOpenFiles?.();
      return;
    }
    if (id === "terminal") {
      onOpenTerminal?.();
      return;
    }
    if (id === "screenshot") {
      onScreenshot?.();
      return;
    }
    if (id === "install-apk") {
      onInstallApk?.();
      return;
    }
    if (id === "apps") {
      onOpenApps?.();
      return;
    }
    if (id === "network") {
      onOpenNetwork?.();
      return;
    }
    if (id === "scrcpy-config") {
      onOpenScrcpyConfig?.();
      return;
    }
    if (id === "recording") {
      setStatusText("正在读取录制状态");
      try {
        const current = await DeviceService.recordingStatus(serial);
        if (current.status === "running") {
          const result = await DeviceService.recordingStop(serial);
          setStatusText(result.success ? "录制已停止" : result.stderr || result.stdout || "停止录制失败");
        } else {
          const result = await DeviceService.recordingStart(serial, "video");
          setStatusText(result.status === "running" ? "录制已开始" : result.message || "开始录制失败");
        }
      } catch (error) {
        setStatusText(`录制操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (id === "stream") {
      setStatusText("正在切换内嵌投屏");
      try {
        const current = await DeviceService.scrcpyStreamStatus(serial);
        const result = current.status === "running"
          ? await DeviceService.scrcpyStreamStop(serial)
          : await DeviceService.scrcpyStreamStart(serial);
        setStatusText("status" in result
          ? result.status === "running" ? "内嵌投屏已启动" : result.message || "内嵌投屏启动失败"
          : result.success ? "内嵌投屏已停止" : result.stderr || result.stdout || "投屏操作失败");
      } catch (error) {
        setStatusText(`投屏操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    setStatusText(`正在执行 ${action.label}`);
    const result = await (() => {
      switch (id) {
        case "home": return DeviceService.home(serial);
        case "back": return DeviceService.back(serial);
        case "recent": return DeviceService.recent(serial);
        case "power": return DeviceService.power(serial);
        case "lock": return DeviceService.lock(serial);
        case "wake": return DeviceService.wake(serial);
        case "screen-off": return DeviceService.keyevent(serial, 26);
        case "rotate": return DeviceService.rotate(serial, true);
        case "volume-up": return DeviceService.volumeUp(serial);
        case "volume-down": return DeviceService.volumeDown(serial);
        case "mute": return DeviceService.keyevent(serial, 91);
        case "restart": return DeviceService.restart(serial);
        case "notifications": return DeviceService.openNotifications(serial);
        case "settings": return DeviceService.openSettings(serial);
        default: return Promise.resolve({ success: false, stdout: "", stderr: "未知设备操作" });
      }
    })();
    setStatusText(result.success ? `${action.label} 已完成` : result.stderr || result.stdout || `${action.label} 失败`);
  };

  return (
    <div className={`device-control-bar${collapsed ? " is-collapsed" : ""}${floating ? " is-floating" : ""}`} aria-label="设备控制栏">
      {!collapsed && <div className="device-control-actions">
        {orderedActions.map((action) => {
          const Icon = iconById[action.id];
          return (
            <Button
              key={action.id}
              size="sm"
              variant={action.dangerous ? "danger" : "secondary"}
              disabled={action.disabled}
              title={action.disabled ? action.disabledReason : `拖动调整 ${action.label} 顺序`}
              draggable
              onDragStart={() => setDragged(action.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => move(action.id)}
              onClick={() => void run(action.id)}
            >
              <Icon size={13} />
              {action.label}
            </Button>
          );
        })}
      </div>}
      <details className="device-control-settings">
        <summary title="显示或隐藏控制按钮"><MoreHorizontal size={15} /></summary>
        <div className="device-control-settings-menu">
          {actions.map((action) => (
            <label key={action.id}>
              <input
                type="checkbox"
                checked={!hidden.includes(action.id)}
                onChange={() => setHidden((current) => current.includes(action.id)
                  ? current.filter((id) => id !== action.id)
                  : [...current, action.id])}
              />
              {action.label}
            </label>
          ))}
          <label><input type="checkbox" checked={collapsed} onChange={(event) => setCollapsed(event.target.checked)} />折叠控制栏</label>
          <label><input type="checkbox" checked={floating} onChange={(event) => setFloating(event.target.checked)} />悬浮显示</label>
          <button type="button" onClick={() => { setOrder(ids); setHidden([]); setCollapsed(false); setFloating(false); }}>恢复默认</button>
        </div>
      </details>
      {collapsed && <button type="button" className="device-control-expand" onClick={() => setCollapsed(false)} title="展开控制栏">展开控制栏</button>}
      {online ? <span className="device-control-online"><VolumeX size={12} /> ADB 已连接</span> : null}
    </div>
  );
}
