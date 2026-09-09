import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Download,
  GripVertical,
  Image,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import {
  createAutomationScript,
  defaultAutomationScript,
  parseAutomationScript,
  readAutomationScripts,
  serializeAutomationScript,
  writeAutomationScripts,
} from "../lib/automation";
import { createAutomationRunSession, runAutomationBatch, runAutomationScript, runAutomationStep, type AutomationRunSession } from "../lib/automationRunner";
import { createDeviceAutomationRuntime } from "../services/automationService";
import { useAppStore } from "../stores/appStore";
import type { AutomationBatchResult, AutomationRunLog, AutomationRunResult, AutomationScript, AutomationStep, AutomationStepKind, AutomationStepValue } from "../types";

const STEP_KINDS: AutomationStepKind[] = [
  "wait", "screenshot", "tap", "swipe", "longPress", "text", "key", "shell", "record", "launch", "install", "imageMatch", "if", "loop",
];

function iconForStep(kind: AutomationStepKind) {
  if (kind === "wait") return Clock3;
  if (kind === "screenshot" || kind === "imageMatch") return Image;
  return MousePointer2;
}

function makeStep(kind: AutomationStepKind, index: number, t: (key: string) => string): AutomationStep {
  const params: Record<AutomationStepKind, Record<string, AutomationStepValue>> = {
    wait: { milliseconds: 500 }, screenshot: { outputPath: "${screenshotDir}" }, tap: { x: 0, y: 0 },
    swipe: { x1: 0, y1: 0, x2: 0, y2: 0, duration: 300 }, longPress: { x: 0, y: 0, duration: 800 }, text: { text: "" }, key: { keycode: 3 },
    shell: { command: "" }, record: { outputPath: "", durationSeconds: 0 }, launch: { packageName: "", displayId: "" },
    install: { path: "" }, imageMatch: { imagePath: "", threshold: 0.85, followMatchPoint: true },
    if: { expression: "" }, loop: { count: 1 },
  };
  return { id: `step-${Date.now()}-${index}`, kind, label: t(`automation.step.${kind}`), enabled: true, params: params[kind] };
}

export function AutomationPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const devices = useAppStore((s) => s.devices);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const [scripts, setScripts] = useState<AutomationScript[]>(() => {
    const saved = readAutomationScripts();
    return saved.length ? saved : [defaultAutomationScript()];
  });
  const [selectedId, setSelectedId] = useState(() => readAutomationScripts()[0]?.id ?? "");
  const [selectedStepId, setSelectedStepId] = useState("");
  const [newStepKind, setNewStepKind] = useState<AutomationStepKind>("tap");
  const [targetSerial, setTargetSerial] = useState("");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [runResult, setRunResult] = useState<AutomationRunResult | null>(null);
  const [batchResult, setBatchResult] = useState<AutomationBatchResult | null>(null);
  const [runLogs, setRunLogs] = useState<AutomationRunLog[]>([]);
  const runController = useRef<AutomationRunSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => scripts.find((script) => script.id === selectedId) ?? scripts[0] ?? null,
    [scripts, selectedId],
  );
  const selectedStep = selected?.steps.find((step) => step.id === selectedStepId) ?? selected?.steps[0] ?? null;

  useEffect(() => {
    if (!selectedId && scripts[0]) setSelectedId(scripts[0].id);
    if (selected && selectedStep && selectedStepId !== selectedStep.id) setSelectedStepId(selectedStep.id);
  }, [scripts, selected, selectedId, selectedStep, selectedStepId]);

  useEffect(() => {
    if (targetSerial) return;
    const preferred = devices.find((device) => device.id === selectedDeviceId && device.online)?.serial;
    setTargetSerial(preferred ?? devices.find((device) => device.online)?.serial ?? "");
  }, [devices, selectedDeviceId, targetSerial]);

  const updateSelected = (patch: Partial<AutomationScript>) => {
    if (!selected) return;
    setScripts((current) => current.map((script) => script.id === selected.id ? createAutomationScript({ ...script, ...patch, updatedAt: undefined, id: script.id, name: patch.name ?? script.name }) : script));
  };

  const updateSelectedStep = (patch: Partial<AutomationStep>) => {
    if (!selected || !selectedStep) return;
    updateSelected({ steps: selected.steps.map((step) => step.id === selectedStep.id ? { ...step, ...patch } : step) });
  };

  const save = () => {
    writeAutomationScripts(scripts);
    setStatusText(t("automation.saved"));
  };

  const create = () => {
    const script = createAutomationScript({ id: `script-${Date.now()}`, name: "未命名脚本", steps: [makeStep("wait", 0, t)] });
    setScripts((current) => [...current, script]);
    setSelectedId(script.id);
    setSelectedStepId(script.steps[0].id);
  };

  const remove = () => {
    if (!selected) return;
    const next = scripts.filter((script) => script.id !== selected.id);
    setScripts(next);
    setSelectedId(next[0]?.id ?? "");
    setSelectedStepId(next[0]?.steps[0]?.id ?? "");
    writeAutomationScripts(next);
  };

  const addStep = (kind: AutomationStepKind) => {
    if (!selected) return;
    const step = makeStep(kind, selected.steps.length, t);
    updateSelected({ steps: [...selected.steps, step] });
    setSelectedStepId(step.id);
  };

  const run = async () => {
    if (!selected || !targetSerial.trim() || running) return;
    const serials = [...new Set(targetSerial.split(/[\s,;]+/).map((serial) => serial.trim()).filter(Boolean))];
    const session = createAutomationRunSession();
    runController.current = session;
    setRunning(true);
    setPaused(false);
    setRunResult(null);
    setBatchResult(null);
    setRunLogs([]);
    try {
      if (serials.length === 1) {
        const result = await runAutomationScript(selected, serials[0], createDeviceAutomationRuntime(), { session });
        setRunResult(result);
        setRunLogs(result.logs);
        setStatusText(`${t("automation.run")}：${result.status}`);
      } else {
        const result = await runAutomationBatch(selected, serials, () => createDeviceAutomationRuntime(), { session, concurrency: 2 });
        setBatchResult(result);
        setRunLogs(result.results.flatMap((entry) => entry.result.logs.map((log) => ({ ...log, label: `${entry.serial} · ${log.label}` }))));
        setStatusText(`${t("automation.run")}：${result.status}`);
      }
    } finally {
      runController.current = null;
      setRunning(false);
      setPaused(false);
    }
  };

  const cancelRun = () => runController.current?.cancel();
  const togglePause = () => {
    if (!runController.current) return;
    if (paused) {
      runController.current.resume();
      setPaused(false);
    } else {
      runController.current.pause();
      setPaused(true);
    }
  };

  const runSingleStep = async () => {
    if (!selected || !selectedStep || !targetSerial.trim() || running) return;
    const stepIndex = selected.steps.findIndex((step) => step.id === selectedStep.id);
    if (stepIndex < 0) return;
    const session = createAutomationRunSession();
    setRunning(true);
    setRunResult(null);
    setBatchResult(null);
    setRunLogs([]);
    try {
      const result = await runAutomationStep(selected, targetSerial.split(/[\s,;]+/).filter(Boolean)[0], stepIndex, createDeviceAutomationRuntime(), { session });
      setRunResult(result);
      setRunLogs(result.logs);
      setStatusText(`${t("automation.singleStep")}：${result.status}`);
    } finally {
      setRunning(false);
    }
  };

  const importScript = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const imported = parseAutomationScript(await file.text());
    if (!imported) {
      setStatusText(t("automation.importFailed"));
      return;
    }
    setScripts((current) => [...current.filter((script) => script.id !== imported.id), imported]);
    setSelectedId(imported.id);
    setSelectedStepId(imported.steps[0]?.id ?? "");
    setStatusText(t("automation.imported"));
  };

  const exportScript = () => {
    if (!selected) return;
    const blob = new Blob([serializeAutomationScript(selected)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.name || "automation"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="automation-workbench">
      <div className="page-header automation-header-rail">
        <div>
          <h1 className="page-title">{t("automation.title")}</h1>
          <div className="page-subtitle">{t("automation.subtitle")}</div>
        </div>
        <div className="row">
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void importScript(event)} />
          <Button variant="secondary" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>{t("automation.import")}</Button>
          <Button variant="secondary" icon={<Download size={14} />} onClick={exportScript} disabled={!selected}>{t("automation.export")}</Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={create}>{t("automation.new")}</Button>
        </div>
      </div>

      <div className="automation-layout">
        <Card className="automation-script-rail" title={t("automation.scriptList")} action={<Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={create}>{t("automation.new")}</Button>}>
          {scripts.length === 0 && <div className="empty-state">{t("automation.noScripts")}</div>}
          <div className="automation-script-list">
            {scripts.map((script) => (
              <button key={script.id} type="button" className={`automation-script-item${selected?.id === script.id ? " active" : ""}`} onClick={() => setSelectedId(script.id)}>
                <span className="automation-script-dot" />
                <span className="automation-script-copy"><strong>{script.name}</strong><small>{script.steps.length} {t("automation.steps")}</small></span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="automation-editor" padding={false}>
          {selected ? (
            <>
              <div className="automation-editor-head">
                <div>
                  <span className="section-kicker">WORKFLOW / {selected.version.toString().padStart(2, "0")}</span>
                  <h2>{selected.name}</h2>
                </div>
                <div className="row">
                  <Button variant="secondary" icon={<Trash2 size={14} />} onClick={remove}>{t("automation.delete")}</Button>
                  <Button variant="secondary" icon={<Play size={14} />} onClick={() => void runSingleStep()} disabled={!targetSerial.trim() || running}>{t("automation.singleStep")}</Button>
                  {running && <Button variant="secondary" icon={paused ? <Play size={14} /> : <Pause size={14} />} onClick={togglePause}>{paused ? t("automation.resume") : t("automation.pause")}</Button>}
                  <Button variant="secondary" icon={running ? <Square size={14} /> : <Play size={14} />} onClick={running ? cancelRun : () => void run()} disabled={!targetSerial.trim()}>{running ? t("automation.stop") : t("automation.run")}</Button>
                  <Button variant="primary" icon={<Save size={14} />} onClick={save}>{t("automation.save")}</Button>
                </div>
              </div>
              <div className="automation-meta-form">
                <label><span>{t("automation.name")}</span><input aria-label={t("automation.name")} value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
                <label className="wide"><span>{t("automation.description")}</span><input value={selected.description} onChange={(event) => updateSelected({ description: event.target.value })} /></label>
                <label><span>{t("automation.targets")}</span><input aria-label="执行设备" placeholder="设备 Serial" value={targetSerial} onChange={(event) => setTargetSerial(event.target.value)} /></label>
                <label className="switch-row"><input type="checkbox" checked={selected.enabled} onChange={(event) => updateSelected({ enabled: event.target.checked })} /><span>{t("automation.enabled")}</span></label>
              </div>
              <div className="automation-body">
                <section className="automation-steps-panel">
                  <div className="automation-panel-head"><strong>{t("automation.steps")}</strong><div className="automation-step-add"><select aria-label={t("automation.addStepType")} value={newStepKind} onChange={(event) => setNewStepKind(event.target.value as AutomationStepKind)}>{STEP_KINDS.map((kind) => <option key={kind} value={kind}>{t(`automation.step.${kind}`)}</option>)}</select><Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => addStep(newStepKind)}>{t("automation.addStep")}</Button></div></div>
                  <div className="automation-step-list">
                    {selected.steps.map((step, index) => {
                      const Icon = iconForStep(step.kind);
                      return <button key={step.id} type="button" className={`automation-step-item${selectedStep?.id === step.id ? " active" : ""}`} onClick={() => setSelectedStepId(step.id)}>
                        <GripVertical size={14} className="automation-drag-icon" />
                        <span className="automation-step-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="automation-step-icon"><Icon size={14} /></span>
                        <span className="automation-step-copy"><strong>{step.label}</strong><small>{t(`automation.step.${step.kind}`)}</small></span>
                      </button>;
                    })}
                  </div>
                </section>
                <section className="automation-detail-panel">
                  <div className="automation-panel-head"><strong>{t("automation.stepDetails")}</strong><span className="muted">{selectedStep ? selectedStep.id : "—"}</span></div>
                  {runResult && <div className={`automation-run-result ${runResult.status}`}><strong>{runResult.status === "completed" ? "执行完成" : runResult.status === "cancelled" ? "已取消" : "执行失败"}</strong><span>{runResult.completedSteps}/{selected.steps.length} 步</span></div>}
                  {batchResult && <div className={`automation-run-result ${batchResult.status}`}><strong>批量{batchResult.status === "completed" ? "完成" : batchResult.status === "cancelled" ? "已取消" : "部分失败"}</strong><span>{batchResult.results.filter((entry) => entry.result.status === "completed").length}/{batchResult.results.length} 台完成</span></div>}
                  {selectedStep ? <>
                    <h3>{selectedStep.label}</h3>
                    <label><span>{t("automation.stepType")}</span><select value={selectedStep.kind} onChange={(event) => updateSelectedStep({ kind: event.target.value as AutomationStepKind, label: t(`automation.step.${event.target.value}`) })}>{STEP_KINDS.map((kind) => <option key={kind} value={kind}>{t(`automation.step.${kind}`)}</option>)}</select></label>
                    {selectedStep.kind === "launch" && <div className="automation-launch-fields">
                      <label><span>{t("automation.launch.packageName")}</span><input aria-label={t("automation.launch.packageName")} value={String(selectedStep.params.packageName ?? "")} onChange={(event) => updateSelectedStep({ params: { ...selectedStep.params, packageName: event.target.value } })} /></label>
                      <label><span>{t("automation.launch.displayId")}</span><input aria-label={t("automation.launch.displayId")} type="number" min={0} max={100} placeholder={t("automation.launch.displayHint")} value={String(selectedStep.params.displayId ?? "")} onChange={(event) => updateSelectedStep({ params: { ...selectedStep.params, displayId: event.target.value } })} /></label>
                    </div>}
                    <label><span>{t("automation.stepDetails")}</span><textarea value={JSON.stringify(selectedStep.params, null, 2)} onChange={(event) => { try { updateSelectedStep({ params: JSON.parse(event.target.value) }); } catch { /* keep editing until valid JSON */ } }} /></label>
                    <label className="switch-row"><input type="checkbox" checked={selectedStep.enabled} onChange={(event) => updateSelectedStep({ enabled: event.target.checked })} /><span>{t("automation.stepEnabled")}</span></label>
                    <label className="switch-row"><input type="checkbox" checked={selectedStep.continueOnError ?? false} onChange={(event) => updateSelectedStep({ continueOnError: event.target.checked })} /><span>{t("automation.continueOnError")}</span></label>
                    <div className="automation-variable-hint">{t("automation.variableHint")}</div>
                  </> : <div className="empty-state">{t("automation.noStep")}</div>}
                </section>
                <section className="automation-log-panel">
                  <div className="automation-panel-head"><strong>执行日志</strong><span className="muted">{runLogs.length} 条</span></div>
                  {runLogs.length === 0 ? <div className="empty-state">运行脚本后显示步骤结果</div> : <div className="automation-log-list">{runLogs.map((log, index) => <div key={`${log.stepId}-${index}`} className={`automation-log-row ${log.status}`}><span className="automation-log-dot" /><span className="automation-log-label">{log.label}</span><span className="automation-log-status">{log.status}</span>{log.message && <span className="automation-log-message">{log.message}</span>}</div>)}</div>}
                </section>
              </div>
            </>
          ) : <div className="empty-state">{t("automation.noScripts")}</div>}
        </Card>
      </div>
    </div>
  );
}
