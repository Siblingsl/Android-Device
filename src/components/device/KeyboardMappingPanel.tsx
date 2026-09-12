import { useEffect, useState } from "react";
import { Keyboard, Plus, Save, Trash2 } from "lucide-react";
import { open, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { KEYBOARD_MAPPING_STORAGE_KEY, mappingError, normalizeMapping, type KeyboardMapping, type MappingAction } from "../../lib/keyboardMapping";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript, type AutomationScript } from "../../lib/automation";
import { DeviceService } from "../../services/deviceService";
import type { DeviceInfo } from "../../types";

interface Props {
  device: DeviceInfo;
  setStatusText: (text: string) => void;
}

function load(deviceId: string): KeyboardMapping[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYBOARD_MAPPING_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.map((item) => normalizeMapping(item as Partial<KeyboardMapping>)).filter((item) => !item.deviceId || item.deviceId === deviceId) : [];
  } catch { return []; }
}

function loadScripts(): AutomationScript[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.map((item) => normalizeAutomationScript(item as Record<string, unknown>)) : [];
  } catch {
    return [];
  }
}

export function KeyboardMappingPanel({ device, setStatusText }: Props) {
  const [items, setItems] = useState<KeyboardMapping[]>(() => load(device.id));
  const [scripts, setScripts] = useState<AutomationScript[]>(loadScripts);
  const [appPackage, setAppPackage] = useState("");

  useEffect(() => {
    setItems(load(device.id));
    setScripts(loadScripts());
  }, [device.id]);

  useEffect(() => {
    const refreshScripts = () => setScripts(loadScripts());
    window.addEventListener("storage", refreshScripts);
    return () => window.removeEventListener("storage", refreshScripts);
  }, []);

  const save = () => {
    const invalid = items.map(mappingError).find(Boolean);
    if (invalid) { setStatusText(invalid); return; }
    try {
      const raw = JSON.parse(localStorage.getItem(KEYBOARD_MAPPING_STORAGE_KEY) || "[]") as unknown;
      const other = Array.isArray(raw) ? raw.filter((item) => (item as KeyboardMapping)?.deviceId !== device.id) : [];
      localStorage.setItem(KEYBOARD_MAPPING_STORAGE_KEY, JSON.stringify([...other, ...items]));
      setStatusText("键盘映射已保存");
    } catch { setStatusText("键盘映射保存失败"); }
  };

  const exportScheme = async () => {
    try {
      const content = JSON.stringify({ version: 1, deviceId: device.id, mappings: items }, null, 2);
      if (!("__TAURI_INTERNALS__" in window)) {
        const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${device.name || device.id}-keyboard-mapping.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setStatusText("键盘映射方案已下载");
        return;
      }
      const path = await saveFile({ defaultPath: `${device.name || device.id}-keyboard-mapping.json`, filters: [{ name: "键盘映射", extensions: ["json"] }] });
      if (!path) return;
      await DeviceService.writeConfigFile(path, content);
      setStatusText(`键盘映射方案已导出：${path}`);
    } catch (error) {
      setStatusText(`键盘映射导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const importScheme = async () => {
    try {
      let raw = "";
      if (!("__TAURI_INTERNALS__" in window)) {
        raw = await new Promise<string>((resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".json,application/json";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return reject(new Error("未选择文件"));
            void file.text().then(resolve).catch(reject);
          };
          input.click();
        });
      } else {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "键盘映射", extensions: ["json"] }] });
        if (typeof path !== "string" || !path) return;
        raw = await DeviceService.readConfigFile(path);
      }
      const parsed = JSON.parse(raw) as unknown;
      const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { mappings?: unknown }).mappings) ? (parsed as { mappings: unknown[] }).mappings : [];
      if (!values.length) throw new Error("文件中没有映射方案");
      const imported = values.map((item) => normalizeMapping(item as Partial<KeyboardMapping>)).filter((item) => !item.deviceId || item.deviceId === device.id);
      setItems(imported);
      setStatusText(`已导入 ${imported.length} 条键盘映射，请点击保存`);
    } catch (error) {
      setStatusText(`键盘映射导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const update = (id: string, patch: Partial<KeyboardMapping>) => setItems((current) => current.map((item) => item.id === id ? normalizeMapping({ ...item, ...patch }) : item));

  return (
    <Card className="keyboard-mapping-panel" title="键盘映射" action={<div className="row"><Button size="sm" icon={<Plus size={13} />} onClick={() => setItems((current) => [...current, normalizeMapping({ id: `mapping-${Date.now()}`, trigger: "Q", deviceId: device.id, appPackage })])}>新增</Button><Button size="sm" variant="ghost" onClick={() => void importScheme()}>导入方案</Button><Button size="sm" variant="ghost" onClick={() => void exportScheme()}>导出方案</Button><Button size="sm" variant="primary" icon={<Save size={13} />} onClick={save}>保存</Button></div>}>
      <div className="muted mapping-hint"><Keyboard size={13} /> 把按键映射到点击、滑动、摇杆、滚轮、Android KeyEvent 或自动化脚本；摇杆按住移动、松开回中。</div>
      <div className="mapping-list">
        {items.map((item) => (
          <div className="mapping-row" key={item.id}>
            <input value={item.trigger} onChange={(e) => update(item.id, { trigger: e.target.value })} placeholder="W / Space" aria-label="触发按键" />
            <select value={item.action} onChange={(e) => update(item.id, { action: e.target.value as MappingAction })} aria-label="映射动作"><option value="tap">点击</option><option value="long-press">长按</option><option value="swipe">滑动</option><option value="joystick">摇杆</option><option value="scroll">滚轮</option><option value="keyevent">KeyEvent</option><option value="automation">自动化</option></select>
            <input type="number" value={item.x} onChange={(e) => update(item.id, { x: Number(e.target.value) })} aria-label="X" />
            <input type="number" value={item.y} onChange={(e) => update(item.id, { y: Number(e.target.value) })} aria-label="Y" />
            {(item.action === "swipe" || item.action === "joystick") && <><input type="number" value={item.x2} onChange={(e) => update(item.id, { x2: Number(e.target.value) })} aria-label="终点 X" /><input type="number" value={item.y2} onChange={(e) => update(item.id, { y2: Number(e.target.value) })} aria-label="终点 Y" /></>}
            {item.action === "keyevent" && <input type="number" value={item.keyCode} onChange={(e) => update(item.id, { keyCode: Number(e.target.value) })} aria-label="KeyEvent" />}
            {item.action === "automation" && <select value={item.automationId} onChange={(e) => update(item.id, { automationId: e.target.value })} aria-label="自动化脚本"><option value="">选择脚本</option>{scripts.map((script) => <option value={script.id} key={script.id}>{script.name || script.id}</option>)}</select>}
            <input value={item.appPackage} onChange={(e) => update(item.id, { appPackage: e.target.value })} placeholder="应用包名（可选）" aria-label="应用包名" />
            <input type="checkbox" checked={item.enabled} onChange={(e) => update(item.id, { enabled: e.target.checked })} aria-label="启用映射" />
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} aria-label="删除映射" />
          </div>
        ))}
      </div>
      <div className="row mapping-footer"><input value={appPackage} onChange={(e) => setAppPackage(e.target.value)} placeholder="新增映射默认应用包名（可选）" /><span className="muted">坐标按设备分辨率填写，运行中只作用于当前设备。</span></div>
    </Card>
  );
}
