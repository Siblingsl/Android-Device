import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, FolderOpen, Play, Plus, Save, Square, Trash2 } from "lucide-react";
import { open, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { DeviceService } from "../../services/deviceService";
import { appendAutomationStep, AUTOMATION_STEP_KINDS, AUTOMATION_STORAGE_KEY, createAutomationScript, moveAutomationStepTree, normalizeAutomationScript, normalizeAutomationStep, removeAutomationStepTree, updateAutomationStepTree, validateAutomationScript, type AutomationScript, type AutomationStep, type AutomationStepKind } from "../../lib/automation";
import type { DeviceInfo } from "../../types";
import { executeAutomationScript } from "../../lib/automationRuntime";

interface Props { device: DeviceInfo; setStatusText: (text: string) => void; }

function imageSource(value: string) {
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}

function ImageCropSelector({ step, onChange }: { step: AutomationStep; onChange: (patch: Partial<AutomationStep>) => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const current = {
    x: step.cropX,
    y: step.cropY,
    width: step.cropWidth,
    height: step.cropHeight,
  };
  const display = selection || current;
  const toImagePoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || !natural.width || !natural.height) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(natural.width, Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * natural.width))),
      y: Math.max(0, Math.min(natural.height, Math.round((event.clientY - rect.top) / Math.max(1, rect.height) * natural.height))),
    };
  };
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!natural.width || !natural.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toImagePoint(event);
    setDrag(point);
    setSelection({ ...point, width: 0, height: 0 });
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const point = toImagePoint(event);
    setSelection({
      x: Math.min(drag.x, point.x),
      y: Math.min(drag.y, point.y),
      width: Math.abs(point.x - drag.x),
      height: Math.abs(point.y - drag.y),
    });
  };
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const point = toImagePoint(event);
    const next = {
      x: Math.min(drag.x, point.x),
      y: Math.min(drag.y, point.y),
      width: Math.abs(point.x - drag.x),
      height: Math.abs(point.y - drag.y),
    };
    setDrag(null);
    setSelection(null);
    if (next.width > 1 && next.height > 1) onChange({ cropX: next.x, cropY: next.y, cropWidth: next.width, cropHeight: next.height });
  };

  return (
    <div className="automation-image-editor">
      <label className="automation-file-label">{step.templateData ? "替换图片模板" : "选择图片模板"}
        <input type="file" accept="image/*" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => onChange({ templateData: String(reader.result || ""), cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0 });
          reader.readAsDataURL(file);
        }} />
      </label>
      {step.templateData && <>
        <div className="automation-crop-picker" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { setDrag(null); setSelection(null); }}>
          <img ref={imageRef} src={imageSource(step.templateData)} alt="图片匹配模板" draggable={false} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {natural.width > 0 && display.width > 1 && display.height > 1 && <span className="automation-crop-selection" style={{ left: `${display.x / natural.width * 100}%`, top: `${display.y / natural.height * 100}%`, width: `${display.width / natural.width * 100}%`, height: `${display.height / natural.height * 100}%` }} />}
        </div>
        <span className="muted automation-crop-hint">在模板上拖拽框选匹配区域；不框选则匹配整张图。</span>
      </>}
      <input type="number" min={0.01} max={1} step={0.01} value={step.threshold} onChange={(event) => onChange({ threshold: Number(event.target.value) })} placeholder="阈值" aria-label="图片匹配阈值" />
      <span className="muted mono automation-crop-values">裁剪 {step.cropWidth > 0 && step.cropHeight > 0 ? `${step.cropX},${step.cropY} · ${step.cropWidth}×${step.cropHeight}` : "整图"}</span>
    </div>
  );
}

function loadScripts(): AutomationScript[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTOMATION_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object").map((item) => normalizeAutomationScript(item as Record<string, unknown>)) : [];
  } catch { return []; }
}

function newEditorStep(kind: AutomationStepKind) {
  return normalizeAutomationStep({
    kind,
    label: AUTOMATION_STEP_KINDS.find((item) => item.value === kind)?.label,
    children: kind === "repeat" ? [normalizeAutomationStep({ kind: "tap", label: "循环点击" })] : [],
  });
}

interface AutomationStepEditorProps {
  step: AutomationStep;
  index: number;
  total: number;
  depth: number;
  onChange: (id: string, patch: Partial<AutomationStep>) => void;
  onAddChild: (parentId: string, kind: AutomationStepKind) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}

function AutomationStepEditor({ step, index, total, depth, onChange, onAddChild, onMove, onRemove }: AutomationStepEditorProps) {
  const update = (patch: Partial<AutomationStep>) => onChange(step.id, patch);
  return (
    <div className={`automation-step-tree-node depth-${Math.min(depth, 4)}`}>
      <div className="automation-step-row">
        <span className="automation-index">{index + 1}</span>
        <input className="automation-label" value={step.label} onChange={(event) => update({ label: event.target.value })} placeholder={AUTOMATION_STEP_KINDS.find((item) => item.value === step.kind)?.label} aria-label="步骤名称" />
        <select value={step.kind} onChange={(event) => update({ kind: event.target.value as AutomationStepKind })} aria-label="步骤类型">
          {AUTOMATION_STEP_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        {["tap", "long-press", "swipe", "scroll"].includes(step.kind) && <>
          <input type="number" min={0} value={step.x} onChange={(event) => update({ x: Number(event.target.value) })} aria-label="X" />
          <input type="number" min={0} value={step.y} onChange={(event) => update({ y: Number(event.target.value) })} aria-label="Y" />
          <input type="number" min={0} value={step.randomOffsetX} onChange={(event) => update({ randomOffsetX: Number(event.target.value) })} aria-label="随机 X 偏移" placeholder="随机X" />
          <input type="number" min={0} value={step.randomOffsetY} onChange={(event) => update({ randomOffsetY: Number(event.target.value) })} aria-label="随机 Y 偏移" placeholder="随机Y" />
        </>}
        {step.kind === "swipe" && <>
          <input type="number" min={0} value={step.x2} onChange={(event) => update({ x2: Number(event.target.value) })} aria-label="终点 X" />
          <input type="number" min={0} value={step.y2} onChange={(event) => update({ y2: Number(event.target.value) })} aria-label="终点 Y" />
          <input type="number" min={10} value={step.duration} onChange={(event) => update({ duration: Number(event.target.value) })} aria-label="滑动时长毫秒" placeholder="毫秒" />
        </>}
        {step.kind === "long-press" && <input type="number" min={10} value={step.duration} onChange={(event) => update({ duration: Number(event.target.value) })} aria-label="长按时长毫秒" placeholder="毫秒" />}
        {step.kind === "scroll" && <input type="number" min={10} value={step.duration} onChange={(event) => update({ duration: Number(event.target.value) })} aria-label="滚动距离" placeholder="距离" />}
        {step.kind === "text" && <input value={step.text} onChange={(event) => update({ text: event.target.value })} placeholder="文字或 {{serial}}" aria-label="输入文字" />}
        {step.kind === "keyevent" && <input type="number" min={1} max={300} value={step.keyCode} onChange={(event) => update({ keyCode: Number(event.target.value) })} placeholder="KeyEvent" aria-label="KeyEvent" />}
        {step.kind === "wait" && <input type="number" min={0} value={step.seconds} onChange={(event) => update({ seconds: Number(event.target.value) })} placeholder="秒" aria-label="等待秒数" />}
        {step.kind === "launch-app" && <input value={step.packageName} onChange={(event) => update({ packageName: event.target.value })} placeholder="应用包名" aria-label="应用包名" />}
        {step.kind === "install-apk" && <div className="row automation-step-file"><input value={step.apkPath} onChange={(event) => update({ apkPath: event.target.value })} placeholder="APK 路径" aria-label="APK 路径" /><Button size="sm" variant="ghost" onClick={async () => { const path = await open({ multiple: false, directory: false, filters: [{ name: "APK", extensions: ["apk"] }] }); if (typeof path === "string") update({ apkPath: path }); }}>选择</Button></div>}
        {step.kind === "image-match" && <div className="row automation-step-file"><label className="automation-file-label">{step.templateData ? "替换模板" : "选择模板"}<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => update({ templateData: String(reader.result || ""), cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0 }); reader.readAsDataURL(file); }} /></label><input type="number" min={0.01} max={1} step={0.01} value={step.threshold} onChange={(event) => update({ threshold: Number(event.target.value) })} placeholder="阈值" aria-label="图片匹配阈值" /></div>}
        {["shell", "condition"].includes(step.kind) && <input className="automation-wide-input" value={step.command} onChange={(event) => update({ command: event.target.value })} placeholder={step.kind === "condition" ? "成功才继续，例如 test -e /sdcard" : "设备 Shell 命令"} aria-label={step.kind === "condition" ? "条件 Shell" : "设备 Shell"} />}
        {step.kind === "repeat" && <input type="number" min={1} max={1000} value={step.count} onChange={(event) => update({ count: Number(event.target.value) })} placeholder="次数" aria-label="循环次数" />}
        <Button size="sm" variant="ghost" icon={<ChevronUp size={13} />} disabled={index <= 0} onClick={() => onMove(step.id, -1)} aria-label="上移步骤" />
        <Button size="sm" variant="ghost" icon={<ChevronDown size={13} />} disabled={index >= total - 1} onClick={() => onMove(step.id, 1)} aria-label="下移步骤" />
        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => onRemove(step.id)} aria-label="删除步骤" />
      </div>
      {step.kind === "repeat" && <div className="automation-repeat-children">
        <div className="automation-repeat-head">
          <span className="muted">循环内部步骤 · {step.children.length}</span>
          <select defaultValue="" onChange={(event) => { if (event.target.value) onAddChild(step.id, event.target.value as AutomationStepKind); event.currentTarget.value = ""; }} aria-label="添加循环子步骤">
            <option value="" disabled>添加子步骤…</option>
            {AUTOMATION_STEP_KINDS.filter((item) => depth < 4 || item.value !== "repeat").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        {step.children.length ? step.children.map((child, childIndex) => <AutomationStepEditor key={child.id} step={child} index={childIndex} total={step.children.length} depth={depth + 1} onChange={onChange} onAddChild={onAddChild} onMove={onMove} onRemove={onRemove} />) : <div className="empty-state automation-repeat-empty">循环为空，请添加至少一个子步骤</div>}
      </div>}
    </div>
  );
}

function flattenAutomationSteps(steps: AutomationStep[], prefix = ""): Array<{ step: AutomationStep; path: string }> {
  return steps.flatMap((step, index) => {
    const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    return [{ step, path }, ...flattenAutomationSteps(step.children, path)];
  });
}

export function AutomationPanel({ device, setStatusText }: Props) {
  const [scripts, setScripts] = useState<AutomationScript[]>(loadScripts);
  const [selectedId, setSelectedId] = useState(() => loadScripts()[0]?.id || "");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [singleStepId, setSingleStepId] = useState("");
  const stopRef = useRef(false);
  const pauseRef = useRef(false);
  const current = useMemo(() => scripts.find((script) => script.id === selectedId) || scripts[0], [scripts, selectedId]);
  const stepEntries = useMemo(() => flattenAutomationSteps(current?.steps || []), [current]);
  const singleStepEntry = stepEntries.find((entry) => entry.step.id === singleStepId) || stepEntries[0];
  const singleStep = singleStepEntry?.step;

  const setCurrent = (updater: (script: AutomationScript) => AutomationScript) => {
    if (!current) return;
    setScripts((all) => all.map((script) => script.id === current.id ? updater(script) : script));
  };
  const updateStep = (id: string, patch: Partial<AutomationStep>) => setCurrent((script) => ({ ...script, steps: updateAutomationStepTree(script.steps, id, patch) }));
  const addStep = (kind: AutomationStepKind) => setCurrent((script) => ({ ...script, steps: [...script.steps, newEditorStep(kind)] }));
  const addChildStep = (parentId: string, kind: AutomationStepKind) => setCurrent((script) => ({ ...script, steps: appendAutomationStep(script.steps, parentId, newEditorStep(kind)) }));
  const moveStep = (id: string, direction: -1 | 1) => setCurrent((script) => ({ ...script, steps: moveAutomationStepTree(script.steps, id, direction) }));
  const removeStep = (id: string) => setCurrent((script) => ({ ...script, steps: removeAutomationStepTree(script.steps, id) }));

  const appendRunLog = (message: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    setRunLog((all) => [...all.slice(-99), line]);
    setStatusText(message);
  };

  const persist = () => {
    try { localStorage.setItem(AUTOMATION_STORAGE_KEY, JSON.stringify(scripts.map((script) => script.id === current?.id ? { ...script, updatedAt: new Date().toISOString() } : script))); setStatusText("自动化脚本已保存"); } catch { setStatusText("自动化脚本保存失败"); }
  };

  const exportScript = async () => {
    if (!current) return;
    try {
      const path = await saveFile({ defaultPath: `${current.name || "automation"}.json`, filters: [{ name: "自动化脚本", extensions: ["json"] }] });
      if (!path) return;
      await DeviceService.writeConfigFile(path, JSON.stringify(current, null, 2));
      setStatusText(`脚本已导出：${path}`);
    } catch (error) { setStatusText(`脚本导出失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const importScript = async () => {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: "自动化脚本", extensions: ["json"] }] });
      if (typeof path !== "string" || !path) return;
      const parsed = JSON.parse(await DeviceService.readConfigFile(path)) as Partial<AutomationScript>;
      if (!Array.isArray(parsed.steps)) throw new Error("脚本缺少步骤");
      const imported = normalizeAutomationScript({ ...parsed, id: "script-" + Date.now(), name: typeof parsed.name === "string" ? parsed.name : "导入脚本" });
      setScripts((all) => [...all, imported]);
      setSelectedId(imported.id);
      setStatusText("脚本已导入");
    } catch (error) { setStatusText(`脚本导入失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const run = async () => {
    if (!current || running) return;
    const errors = validateAutomationScript(current);
    if (errors.length) { setStatusText(errors[0]); return; }
    stopRef.current = false; pauseRef.current = false; setPaused(false); setRunning(true); setRunLog([]); appendRunLog(`开始执行脚本：${current.name}`);
    try {
      await executeAutomationScript(current, { serial: device.serial, id: device.id, name: device.name }, {
        shouldPause: () => pauseRef.current,
        shouldStop: () => stopRef.current,
        onStep: (index, total, step, path) => appendRunLog(`脚本执行中：第 ${path || index + 1} 步 · ${step.label || step.kind}（${index + 1}/${total}）`),
      });
      appendRunLog("自动化脚本执行完成");
    } catch (error) { appendRunLog(`脚本执行失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setRunning(false); setPaused(false); pauseRef.current = false; }
  };

  const runSingleStep = async (step: AutomationStep, label: string) => {
    if (running || !current) return;
    const script = { ...current, steps: [step] };
    const errors = validateAutomationScript(script);
    if (errors.length) { setStatusText(errors[0]); return; }
    stopRef.current = false; pauseRef.current = false; setPaused(false); setRunning(true); setRunLog([]);
    appendRunLog(`正在单步执行：第 ${label} 步`);
    try {
      await executeAutomationScript(script, { serial: device.serial, id: device.id, name: device.name }, {
        shouldPause: () => pauseRef.current,
        shouldStop: () => stopRef.current,
        onStep: () => appendRunLog(`正在单步执行：第 ${label} 步`),
      });
      appendRunLog(`第 ${label} 步执行完成`);
    } catch (error) { appendRunLog(`单步执行失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setRunning(false); setPaused(false); pauseRef.current = false; }
  };

  const updateVariable = (oldKey: string, nextKey: string, value: string) => setCurrent((script) => {
    const key = nextKey.replace(/[^\w.-]/g, "");
    if (!key) return script;
    const variables = { ...script.variables };
    if (oldKey !== key) delete variables[oldKey];
    variables[key] = value;
    return { ...script, variables };
  });

  const addVariable = () => setCurrent((script) => {
    let key = "value";
    let index = 2;
    while (Object.prototype.hasOwnProperty.call(script.variables, key)) key = `value${index++}`;
    return { ...script, variables: { ...script.variables, [key]: "" } };
  });

  if (!current) {
    return <Card className="automation-panel" title="可视化自动化"><div className="empty-state"><Button size="sm" icon={<Plus size={13} />} onClick={() => { const next = createAutomationScript(); setScripts([next]); setSelectedId(next.id); }}>新建脚本</Button></div></Card>;
  }

  return (
    <Card className="automation-panel" title="可视化自动化" action={<div className="row"><select value={current.id} onChange={(e) => setSelectedId(e.target.value)}>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select><Button size="sm" icon={<Plus size={13} />} onClick={() => { const next = createAutomationScript(`脚本 ${scripts.length + 1}`); setScripts((all) => [...all, next]); setSelectedId(next.id); }}>新建</Button><Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void importScript()}>导入</Button><Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void exportScript()}>导出</Button><Button size="sm" icon={<Save size={13} />} onClick={persist}>保存</Button></div>}>
      <div className="automation-name-row"><input value={current.name} onChange={(e) => setCurrent((script) => ({ ...script, name: e.target.value }))} /><div className="row"><select onChange={(e) => { if (e.target.value) addStep(e.target.value as AutomationStepKind); e.currentTarget.value = ""; }} defaultValue=""><option value="" disabled>添加步骤…</option>{AUTOMATION_STEP_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><Button size="sm" variant={running ? "danger" : "primary"} icon={running ? <Square size={13} /> : <Play size={13} />} onClick={() => { if (running) { stopRef.current = true; pauseRef.current = false; setPaused(false); } else void run(); }}>{running ? "停止" : "运行"}</Button>{running && <Button size="sm" variant="ghost" onClick={() => { pauseRef.current = !pauseRef.current; setPaused(pauseRef.current); }}>{paused ? "继续" : "暂停"}</Button>}<select value={singleStepEntry?.step.id || ""} onChange={(e) => setSingleStepId(e.target.value)} aria-label="选择单步"><option value="" disabled>选择单步</option>{stepEntries.map(({ step, path }) => <option key={step.id} value={step.id}>{path}. {step.label || step.kind}</option>)}</select><Button size="sm" variant="ghost" disabled={running || !singleStep} icon={<Play size={13} />} onClick={() => singleStep && void runSingleStep(singleStep, singleStepEntry?.path || "1")}>单步</Button></div></div>
      <details className="automation-variables">
        <summary>变量（{Object.keys(current.variables).length}）</summary>
        <div className="automation-variable-list">
          {Object.entries(current.variables).map(([key, value]) => (
            <div className="row" key={key}>
              <input value={key} onChange={(e) => updateVariable(key, e.target.value, value)} aria-label="变量名" />
              <input value={value} onChange={(e) => updateVariable(key, key, e.target.value)} aria-label="变量值" />
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setCurrent((script) => {
                const variables = { ...script.variables };
                delete variables[key];
                return { ...script, variables };
              })} aria-label="删除变量" />
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={addVariable}>新增变量</Button>
        <div className="muted automation-hint">步骤中可使用双大括号变量；serial、deviceId、deviceName 由当前设备自动注入。</div>
      </details>
      <div className="automation-step-list">
        {current.steps.length ? current.steps.map((step, index) => <AutomationStepEditor key={step.id} step={step} index={index} total={current.steps.length} depth={0} onChange={updateStep} onAddChild={addChildStep} onMove={moveStep} onRemove={removeStep} />) : <div className="empty-state">还没有步骤，请从上方添加</div>}
      </div>
      {stepEntries.some(({ step }) => step.kind === "image-match") && <details className="automation-crop-editor"><summary>图片模板裁剪（支持拖拽框选）</summary>{stepEntries.filter(({ step }) => step.kind === "image-match").map(({ step, path }) => <div className="automation-crop-entry" key={step.id}><span className="muted">第 {path} 步</span><ImageCropSelector step={step} onChange={(patch) => updateStep(step.id, patch)} /></div>)}</details>}
      <details className="automation-run-log" open={runLog.length > 0}>
        <summary>执行日志（{runLog.length}）</summary>
        <div className="automation-run-log-list">{runLog.length ? runLog.map((line, index) => <div className="mono" key={`${line}-${index}`}>{line}</div>) : <span className="muted">运行脚本后显示步骤状态和错误原因</span>}</div>
      </details>
      <div className="muted automation-hint">脚本按当前设备串行执行；暂停会阻止下一步发送，停止会释放运行状态。安装 APK、Shell 和录制等副作用操作只在点击运行后执行。</div>
    </Card>
  );
}
