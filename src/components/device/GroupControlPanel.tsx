import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Camera, FolderOpen, Home, Lock, Monitor, PackagePlus, Play, RefreshCw, Send, Square, TerminalSquare, Trash2, Undo2 } from "lucide-react";
import { askConfirm } from "../../lib/dialogs";
import { DeviceService } from "../../services/deviceService";
import { AUTOMATION_STORAGE_KEY, normalizeAutomationScript } from "../../lib/automation";
import { executeAutomationScript } from "../../lib/automationRuntime";
import type { DeviceInfo } from "../../types";
import { Button } from "../ui/Button";

interface Props {
  devices: DeviceInfo[];
  disabled?: boolean;
  onBatch: (
    label: string,
    worker: (device: DeviceInfo) => Promise<unknown>,
    kind?: string,
  ) => Promise<void>;
}

export function GroupControlPanel({ devices, disabled = false, onBatch }: Props) {
  const [text, setText] = useState("");
  const [packageName, setPackageName] = useState("");
  const [shellCommand, setShellCommand] = useState("");
  const [scriptId, setScriptId] = useState("");
  const [pushing, setPushing] = useState(false);
  const [installingApk, setInstallingApk] = useState(false);
  const [keyCode, setKeyCode] = useState(3);
  const [tapX, setTapX] = useState(540);
  const [tapY, setTapY] = useState(960);
  const online = devices.filter((device) => device.online && device.adbStatus === "device");
  const scripts = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((item) => Boolean(item) && typeof item === "object").map((item) => normalizeAutomationScript(item as Record<string, unknown>)) : [];
    } catch { return []; }
  }, []);
  const selectedScript = scripts.find((script) => script.id === scriptId);

  if (!devices.length) return null;

  const runOnline = (label: string, worker: (device: DeviceInfo) => Promise<unknown>) => {
    return onBatch(label, async (device) => {
      if (!(device.online && device.adbStatus === "device")) {
        return { success: false, stderr: "设备未在线" };
      }
      return worker(device);
    });
  };

  const runLifecycle = (label: string, worker: (device: DeviceInfo) => Promise<unknown>) => {
    return onBatch(label, worker);
  };

  const startDevice = (device: DeviceInfo) => {
    if (device.containerId) return DeviceService.startContainer(device.containerId);
    return device.online && device.adbStatus === "device"
      ? Promise.resolve({ success: true, stdout: "设备已在线" })
      : Promise.resolve({ success: false, stderr: "设备没有关联可启动的容器" });
  };

  const push = async () => {
    const picked = await open({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    setPushing(true);
    try {
      await onBatch(
        `推送 ${paths.length} 个文件`,
        async (device) => {
          if (!(device.online && device.adbStatus === "device")) return { success: false, stderr: "设备未在线" };
          const results = await Promise.all(paths.map((local) => {
            const name = local.split(/[/\\]/).pop() || "file";
            return DeviceService.uploadFile(device.serial, local, `/sdcard/${name}`);
          }));
          const failed = results.find((result) => !result.success);
          return failed || { success: true, stdout: `已推送 ${results.length} 个文件` };
        },
        "file-push",
      );
    } finally {
      setPushing(false);
    }
  };

  const pushDirectory = async () => {
    const picked = await open({ multiple: false, directory: true });
    if (typeof picked !== "string" || !picked) return;
    setPushing(true);
    try {
      await onBatch(
        "推送目录",
        async (device) => {
          if (!(device.online && device.adbStatus === "device")) return { success: false, stderr: "设备未在线" };
          const name = picked.split(/[/\\]/).filter(Boolean).pop() || "folder";
          return DeviceService.uploadFile(device.serial, picked, `/sdcard/${name}`);
        },
        "file-push",
      );
    } finally {
      setPushing(false);
    }
  };

  const installApk = async () => {
    const picked = await open({ multiple: true, directory: false, filters: [{ name: "APK", extensions: ["apk"] }] });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    setInstallingApk(true);
    try {
      await onBatch(
        `安装 ${paths.length} 个 APK`,
        async (device) => {
          if (!(device.online && device.adbStatus === "device")) return { success: false, stderr: "设备未在线" };
          const results = await Promise.all(paths.map((path) => DeviceService.installApk(device.serial, path, true)));
          const failed = results.find((result) => !result.success);
          return failed || { success: true, stdout: `已安装 ${results.length} 个 APK` };
        },
        "apk-install",
      );
    } finally {
      setInstallingApk(false);
    }
  };

  return (
    <section className="module group-control-panel">
      <div className="module-head">
        <div className="row"><Send size={14} /><div className="module-title">群控工作台</div><span className="badge info">已选 {devices.length} · 在线 {online.length}</span></div>
        <span className="muted">操作只发送给当前选中设备</span>
      </div>
      <div className="group-control-body">
        <div className="group-control-actions">
          <Button size="sm" disabled={disabled} onClick={() => runOnline("同步 Home", (device) => DeviceService.home(device.serial))}><Home size={13} />同步 Home</Button>
          <Button size="sm" disabled={disabled} onClick={() => runOnline("同步返回", (device) => DeviceService.back(device.serial))}><Undo2 size={13} />同步返回</Button>
          <Button size="sm" disabled={disabled} onClick={() => runOnline("同步锁屏", (device) => DeviceService.lock(device.serial))}><Lock size={13} />同步锁屏</Button>
          <Button size="sm" disabled={disabled} onClick={() => runLifecycle("批量启动", startDevice)}><Play size={13} />批量启动</Button>
          <Button size="sm" variant="primary" disabled={disabled || !online.length} onClick={() => runOnline("批量投屏", (device) => DeviceService.scrcpyStart(device.serial))}><Monitor size={13} />批量投屏</Button>
          <Button size="sm" disabled={disabled || pushing || installingApk} loading={pushing} onClick={() => void push()}><PackagePlus size={13} />推送文件</Button>
          <Button size="sm" disabled={disabled || pushing || installingApk} loading={pushing} onClick={() => void pushDirectory()}><FolderOpen size={13} />推送目录</Button>
          <Button size="sm" variant="secondary" disabled={disabled || pushing || installingApk} loading={installingApk} onClick={() => void installApk()}><PackagePlus size={13} />批量安装 APK</Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => runOnline("批量截图", (device) => DeviceService.screenshot(device.serial))}><Camera size={13} />批量截图</Button>
          <Button size="sm" disabled={disabled} onClick={async () => { if (await askConfirm(`确定重启已选 ${devices.length} 台设备吗？`)) runLifecycle("批量重启", (device) => DeviceService.restart(device.id)); }}><RefreshCw size={13} />批量重启</Button>
          <Button size="sm" variant="danger" disabled={disabled} onClick={async () => { if (await askConfirm(`确定停止已选 ${devices.length} 台设备吗？`)) runLifecycle("批量停止", (device) => DeviceService.stop(device.id)); }}><Square size={13} />批量停止</Button>
        </div>
        <div className="row group-control-input">
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="输入文字并同步发送到在线设备" aria-label="群控输入文字" />
          <Button size="sm" variant="secondary" disabled={disabled || !text.trim() || !online.length} onClick={() => { const next = text; setText(""); void runOnline("同步输入", (device) => DeviceService.text(device.serial, next)); }}><Send size={13} />发送文字</Button>
        </div>
        <div className="row group-control-input group-control-input-compact">
          <label>KeyEvent <input type="number" min={0} max={300} value={keyCode} onChange={(event) => setKeyCode(Math.max(0, Math.min(300, Number(event.target.value) || 0)))} aria-label="群控 KeyEvent" /></label>
          <Button size="sm" disabled={disabled || !online.length} onClick={() => void runOnline(`广播 KeyEvent ${keyCode}`, (device) => DeviceService.keyevent(device.serial, keyCode))}>广播按键</Button>
          <label>点击 X <input type="number" min={0} value={tapX} onChange={(event) => setTapX(Math.max(0, Number(event.target.value) || 0))} aria-label="群控点击 X" /></label>
          <label>Y <input type="number" min={0} value={tapY} onChange={(event) => setTapY(Math.max(0, Number(event.target.value) || 0))} aria-label="群控点击 Y" /></label>
          <Button size="sm" disabled={disabled || !online.length} onClick={() => void runOnline(`广播点击 ${tapX},${tapY}`, (device) => DeviceService.tap(device.serial, tapX, tapY))}>广播点击</Button>
        </div>
        <div className="row group-control-input">
          <input value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="应用包名，例如 com.example.app" aria-label="群控应用包名" />
          <Button size="sm" disabled={disabled || !packageName.trim() || !online.length} onClick={() => runOnline("批量启动应用", (device) => DeviceService.startApp(device.serial, packageName.trim()))}><Play size={13} />启动应用</Button>
          <Button size="sm" disabled={disabled || !packageName.trim() || !online.length} onClick={() => runOnline("批量停止应用", (device) => DeviceService.stopApp(device.serial, packageName.trim()))}><Square size={13} />停止应用</Button>
          <Button size="sm" variant="danger" disabled={disabled || !packageName.trim() || !online.length} onClick={() => {
            if (!confirm(`确定清理 ${packageName.trim()} 在选中设备上的数据吗？`)) return;
            runOnline("批量清理应用数据", (device) => DeviceService.clearAppData(device.serial, packageName.trim()));
          }}><Trash2 size={13} />清理数据</Button>
        </div>
        <div className="row group-control-input">
          <input value={shellCommand} onChange={(event) => setShellCommand(event.target.value)} placeholder="设备 Shell 命令" aria-label="群控 Shell 命令" />
          <Button size="sm" variant="secondary" disabled={disabled || !shellCommand.trim() || !online.length} onClick={() => runOnline("批量 Shell", (device) => DeviceService.shell(device.serial, shellCommand.trim()))}><TerminalSquare size={13} />执行 Shell</Button>
        </div>
        <div className="row group-control-input">
          <select value={scriptId} onChange={(event) => setScriptId(event.target.value)} aria-label="群控自动化脚本"><option value="">选择自动化脚本</option>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select>
          <Button size="sm" variant="secondary" disabled={disabled || !selectedScript || !online.length} onClick={() => runOnline("批量执行脚本", (device) => executeAutomationScript(selectedScript!, { serial: device.serial, id: device.id, name: device.name }).then(() => ({ success: true, stdout: `脚本完成：${selectedScript!.name}` })))}><Play size={13} />执行脚本</Button>
        </div>
      </div>
    </section>
  );
}
