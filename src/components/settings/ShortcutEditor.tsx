import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { DeviceService } from "../../services/deviceService";
import {
  createShortcutId,
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  normalizeShortcutKey,
  SHORTCUT_ACTIONS,
  SHORTCUT_STORAGE_KEY,
  shortcutKeyError,
  type ShortcutAction,
  type ShortcutBinding,
} from "../../lib/shortcutConfig";
import type { DeviceInfo } from "../../types";

interface Props {
  devices: DeviceInfo[];
  setStatusText: (text: string) => void;
}

function loadBindings(): ShortcutBinding[] {
  try {
    const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS.map((item) => ({ ...item }));
    const parsed = JSON.parse(raw) as ShortcutBinding[];
    if (!Array.isArray(parsed)) throw new Error("invalid");
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.key === "string");
  } catch {
    return DEFAULT_SHORTCUTS.map((item) => ({ ...item }));
  }
}

function deviceFor(binding: ShortcutBinding, devices: DeviceInfo[]): DeviceInfo | undefined {
  const online = devices.filter((device) => device.online && device.adbStatus === "device");
  if (binding.deviceId) {
    return devices.find(
      (device) => device.id === binding.deviceId || device.serial === binding.deviceId,
    );
  }
  return online[0] ?? devices.find((device) => device.online);
}

export function ShortcutEditor({ devices, setStatusText }: Props) {
  const [bindings, setBindings] = useState<ShortcutBinding[]>(loadBindings);
  const [draft, setDraft] = useState<ShortcutBinding[]>(loadBindings);
  const [runtimeMessage, setRuntimeMessage] = useState("尚未应用到系统");
  const registered = useRef(new Map<string, string>());
  const bindingsRef = useRef(bindings);
  const devicesRef = useRef(devices);

  useEffect(() => {
    bindingsRef.current = bindings;
    devicesRef.current = devices;
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  }, [bindings, devices]);

  const runAction = async (id: string) => {
    const binding = bindingsRef.current.find((item) => item.id === id);
    if (!binding) return;
    if (binding.action === "toggle-window") {
      try {
        const appWindow = getCurrentWindow();
        if (await appWindow.isVisible()) await appWindow.hide();
        else await appWindow.show();
      } catch {
        setStatusText("当前环境无法控制主窗口");
      }
      return;
    }
    const device = deviceFor(binding, devicesRef.current);
    if (!device || device.adbStatus !== "device") {
      setStatusText("快捷键未执行：没有可用的在线设备");
      return;
    }
    try {
      let message = "快捷键已执行";
      const runCommand = async (promise: ReturnType<typeof DeviceService.home>, label: string) => {
        const result = await promise;
        if (!result.success) throw new Error(result.stderr || result.stdout || `${label}失败`);
        message = `${label} 已完成`;
      };
      switch (binding.action) {
        case "screenshot": {
          const result = await DeviceService.screenshot(device.serial);
          message = result.success ? `已截图：${result.path}` : result.error || "截图失败";
          break;
        }
        case "home": await runCommand(DeviceService.home(device.serial), "Home"); break;
        case "back": await runCommand(DeviceService.back(device.serial), "返回"); break;
        case "recent": await runCommand(DeviceService.recent(device.serial), "最近任务"); break;
        case "lock": await runCommand(DeviceService.lock(device.serial), "锁屏"); break;
        case "wake": await runCommand(DeviceService.wake(device.serial), "唤醒"); break;
        case "recording": {
          const status = await DeviceService.recordingStatus(device.serial);
          if (status.status === "running") {
            const result = await DeviceService.recordingStop(device.serial);
            message = result.success ? "已停止录制" : result.stderr || "停止录制失败";
          } else {
            const result = await DeviceService.recordingStart(device.serial, "video");
            message = result.status === "error" ? result.message || "开始录制失败" : "已开始录制";
          }
          break;
        }
        case "terminal":
          window.location.hash = `/devices/${encodeURIComponent(device.id)}`;
          window.dispatchEvent(new CustomEvent("rdc:focus-terminal", { detail: device.id }));
          message = `已打开 ${device.name} 的交互终端`;
          break;
        case "files":
          sessionStorage.setItem(`rdc.detail.tab.${device.id}`, "files");
          window.location.hash = `/devices/${encodeURIComponent(device.id)}`;
          message = `已打开 ${device.name} 的文件管理`;
          break;
        case "automation":
          sessionStorage.setItem(`rdc.detail.tab.${device.id}`, "control");
          window.location.hash = `/devices/${encodeURIComponent(device.id)}`;
          message = `已打开 ${device.name} 的自动化工作台`;
          break;
        case "gnirehtet": {
          const status = await DeviceService.gnirehtetStatus(device.serial);
          if (status.status === "running") {
            const result = await DeviceService.gnirehtetStop(device.serial);
            message = result.success ? "网络供网已停止" : result.stderr || "网络供网操作失败";
          } else {
            const result = await DeviceService.gnirehtetStart(device.serial);
            message = result.status === "running" ? "网络供网已启动" : result.message || "网络供网启动失败";
          }
          break;
        }
        case "toggle-stream": {
          const status = await DeviceService.scrcpyStreamStatus(device.serial);
          if (status.status === "running") {
            const result = await DeviceService.scrcpyStreamStop(device.serial);
            message = result.success ? "内嵌投屏已停止" : result.stderr || "投屏操作失败";
          } else {
            const result = await DeviceService.scrcpyStreamStart(device.serial);
            message = result.status === "running" ? "内嵌投屏已启动" : result.message || "投屏启动失败";
          }
          break;
        }
      }
      setStatusText(message);
    } catch (error) {
      setStatusText(`快捷键执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const syncRuntime = async (next: ShortcutBinding[]) => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setRuntimeMessage("浏览器预览不可注册全局快捷键，请使用桌面版");
      return;
    }
    const wanted = new Map(next.filter((item) => item.enabled).map((item) => [item.id, normalizeShortcutKey(item.key)]));
    for (const [id, key] of registered.current) {
      if (wanted.get(id) !== key) {
        try { await unregister(key); } catch { /* stale registration */ }
        registered.current.delete(id);
      }
    }
    let failed = 0;
    for (const item of next) {
      const key = normalizeShortcutKey(item.key);
      if (!item.enabled || !key || registered.current.has(item.id)) continue;
      try {
        await register(key, (event) => {
          if (event.state === "Pressed") void runAction(item.id);
        });
        registered.current.set(item.id, key);
      } catch {
        failed += 1;
      }
    }
    const enabled = next.filter((item) => item.enabled).length;
    setRuntimeMessage(failed ? `${enabled - failed} 个已注册，${failed} 个被系统占用或不可用` : "已注册到系统");
  };

  useEffect(() => {
    void syncRuntime(bindings);
    return () => {
      const keys = [...registered.current.values()];
      registered.current.clear();
      if (keys.length && "__TAURI_INTERNALS__" in window) void unregister(keys).catch(() => undefined);
    };
  }, [bindings]);

  const conflictIds = useMemo(() => new Set(findShortcutConflicts(draft).flat()), [draft]);
  const changed = JSON.stringify(bindings) !== JSON.stringify(draft);
  const updateDraft = (id: string, patch: Partial<ShortcutBinding>) => {
    setDraft((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  return (
    <Card
      className="shortcut-editor"
      title="全局快捷键"
      action={<span className="muted shortcut-runtime-status">{runtimeMessage}</span>}
    >
      <div className="shortcut-editor-toolbar">
        <span className="muted">应用隐藏或切换到其他窗口后仍可触发；同一按键不能绑定多个动作。</span>
        <div className="row">
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setDraft((current) => [...current, { id: createShortcutId(), key: "CommandOrControl+Shift+N", action: "screenshot", deviceId: "", enabled: false }])}>新增</Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => setDraft(DEFAULT_SHORTCUTS.map((item) => ({ ...item })))}>恢复默认</Button>
          <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!changed || conflictIds.size > 0} onClick={() => {
            const error = draft.map((item) => shortcutKeyError(item.key)).find(Boolean);
            if (error) { setStatusText(error); return; }
            setBindings(draft.map((item) => ({ ...item, key: normalizeShortcutKey(item.key) })));
            setStatusText("快捷键配置已保存");
          }}>保存</Button>
        </div>
      </div>
      <div className="shortcut-list">
        {draft.map((item) => {
          const action = SHORTCUT_ACTIONS.find((entry) => entry.value === item.action) ?? SHORTCUT_ACTIONS[0];
          return (
            <div className={`shortcut-row${conflictIds.has(item.id) ? " has-error" : ""}`} key={item.id}>
              <label className="shortcut-enabled"><input type="checkbox" checked={item.enabled} onChange={(e) => updateDraft(item.id, { enabled: e.target.checked })} /><span>启用</span></label>
              <input className="shortcut-key-input mono" value={item.key} onChange={(e) => updateDraft(item.id, { key: e.target.value })} onBlur={() => updateDraft(item.id, { key: normalizeShortcutKey(item.key) })} placeholder="Ctrl+Shift+S" aria-label="快捷键" />
              <select value={item.action} onChange={(e) => updateDraft(item.id, { action: e.target.value as ShortcutAction })} aria-label="动作">
                {SHORTCUT_ACTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
              {action.needsDevice ? (
                <select value={item.deviceId} onChange={(e) => updateDraft(item.id, { deviceId: e.target.value })} aria-label="目标设备">
                  <option value="">当前在线设备</option>
                  {devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.serial}</option>)}
                </select>
              ) : <span className="shortcut-device-placeholder">应用窗口</span>}
              <Button size="sm" variant="ghost" icon={<Command size={13} />} onClick={() => void runAction(item.id)}>测试</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDraft((current) => current.filter((entry) => entry.id !== item.id))} aria-label="删除快捷键" />
              {conflictIds.has(item.id) && <span className="bad shortcut-error">按键冲突</span>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
