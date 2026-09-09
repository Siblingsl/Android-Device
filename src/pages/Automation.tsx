import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Download,
  GripVertical,
  Image,
  MousePointer2,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import {
  createAutomationScript,
  defaultAutomationScript,
  readAutomationScripts,
  writeAutomationScripts,
} from "../lib/automation";
import { runAutomationScript } from "../lib/automationRunner";
import { createDeviceAutomationRuntime } from "../services/automationService";
import { useAppStore } from "../stores/appStore";
import type { AutomationRunResult, AutomationScript, AutomationStep, AutomationStepKind, AutomationStepValue } from "../types";

const STEP_KINDS: AutomationStepKind[] = [
  "wait", "screenshot", "tap", "swipe", "text", "key", "shell", "record", "launch", "install", "imageMatch", "if", "loop",
];

function iconForStep(kind: AutomationStepKind) {
  if (kind === "wait") return Clock3;
  if (kind === "screenshot" || kind === "imageMatch") return Image;
  return MousePointer2;
}

function makeStep(kind: AutomationStepKind, index: number, t: (key: string) => string): AutomationStep {
  const params: Record<AutomationStepKind, Record<string, AutomationStepValue>> = {
    wait: { milliseconds: 500 }, screenshot: { outputPath: "${screenshotDir}" }, tap: { x: 0, y: 0 },
    swipe: { x1: 0, y1: 0, x2: 0, y2: 0, duration: 300 }, text: { text: "" }, key: { keycode: 3 },
    shell: { command: "" }, record: { outputPath: "", durationSeconds: 0 }, launch: { packageName: "" },
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
  const [targetSerial, setTargetSerial] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<AutomationRunResult | null>(null);
  const runController = useRef<AbortController | null>(null);

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
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await runAutomationScript(selected, targetSerial.trim(), createDeviceAutomationRuntime(), { signal: controller.signal });
      setRunResult(result);
      setStatusText(`${t("automation.run")}：${result.status}`);
    } finally {
      runController.current = null;
      setRunning(false);
    }
  };

  const cancelRun = () => runController.current?.abort();

  const exportScript = () => {
    if (!selected) return;
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
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
                  <Button variant="secondary" icon={running ? <Square size={14} /> : <Play size={14} />} onClick={running ? cancelRun : () => void run()} disabled={!targetSerial.trim()}>{running ? "停止运行" : t("automation.run")}</Button>
                  <Button variant="primary" icon={<Save size={14} />} onClick={save}>{t("automation.save")}</Button>
                </div>
              </div>
              <div className="automation-meta-form">
                <label><span>{t("automation.name")}</span><input aria-label={t("automation.name")} value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
                <label className="wide"><span>{t("automation.description")}</span><input value={selected.description} onChange={(event) => updateSelected({ description: event.target.value })} /></label>
                <label><span>执行设备</span><input aria-label="执行设备" placeholder="设备 Serial" value={targetSerial} onChange={(event) => setTargetSerial(event.target.value)} /></label>
                <label className="switch-row"><input type="checkbox" checked={selected.enabled} onChange={(event) => updateSelected({ enabled: event.target.checked })} /><span>{t("automation.enabled")}</span></label>
              </div>
              <div className="automation-body">
                <section className="automation-steps-panel">
                  <div className="automation-panel-head"><strong>{t("automation.steps")}</strong><div className="automation-step-add"><Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => addStep("tap")}>{t("automation.addStep")}</Button></div></div>
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
                  {selectedStep ? <>
                    <h3>{selectedStep.label}</h3>
                    <label><span>{t("automation.stepType")}</span><select value={selectedStep.kind} onChange={(event) => updateSelectedStep({ kind: event.target.value as AutomationStepKind, label: t(`automation.step.${event.target.value}`) })}>{STEP_KINDS.map((kind) => <option key={kind} value={kind}>{t(`automation.step.${kind}`)}</option>)}</select></label>
                    <label><span>{t("automation.stepDetails")}</span><textarea value={JSON.stringify(selectedStep.params, null, 2)} onChange={(event) => { try { updateSelectedStep({ params: JSON.parse(event.target.value) }); } catch { /* keep editing until valid JSON */ } }} /></label>
                    <label className="switch-row"><input type="checkbox" checked={selectedStep.enabled} onChange={(event) => updateSelectedStep({ enabled: event.target.checked })} /><span>{t("automation.stepEnabled")}</span></label>
                    <label className="switch-row"><input type="checkbox" checked={selectedStep.continueOnError ?? false} onChange={(event) => updateSelectedStep({ continueOnError: event.target.checked })} /><span>{t("automation.continueOnError")}</span></label>
                    <div className="automation-variable-hint">{t("automation.variableHint")}</div>
                  </> : <div className="empty-state">{t("automation.noStep")}</div>}
                </section>
              </div>
            </>
          ) : <div className="empty-state">{t("automation.noScripts")}</div>}
        </Card>
      </div>
    </div>
  );
}
