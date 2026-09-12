export type AutomationStepKind = "tap" | "long-press" | "swipe" | "scroll" | "text" | "keyevent" | "wait" | "launch-app" | "install-apk" | "screenshot" | "recording-start" | "recording-stop" | "shell" | "condition" | "repeat" | "image-match";

export interface AutomationStep {
  id: string;
  kind: AutomationStepKind;
  label: string;
  x: number;
  y: number;
  x2: number;
  y2: number;
  randomOffsetX: number;
  randomOffsetY: number;
  duration: number;
  keyCode: number;
  text: string;
  packageName: string;
  apkPath: string;
  command: string;
  seconds: number;
  count: number;
  children: AutomationStep[];
  templateData: string;
  threshold: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

export interface AutomationScript {
  id: string;
  name: string;
  steps: AutomationStep[];
  variables: Record<string, string>;
  updatedAt: string;
}

export const AUTOMATION_STORAGE_KEY = "rdc.automation-scripts.v1";

export const AUTOMATION_STEP_KINDS: Array<{ value: AutomationStepKind; label: string }> = [
  { value: "tap", label: "点击" },
  { value: "long-press", label: "长按" },
  { value: "swipe", label: "滑动" },
  { value: "scroll", label: "滚轮" },
  { value: "text", label: "输入文字" },
  { value: "keyevent", label: "KeyEvent" },
  { value: "wait", label: "等待" },
  { value: "launch-app", label: "启动应用" },
  { value: "install-apk", label: "安装 APK" },
  { value: "screenshot", label: "截图" },
  { value: "recording-start", label: "开始录制" },
  { value: "recording-stop", label: "停止录制" },
  { value: "shell", label: "设备 Shell" },
  { value: "condition", label: "条件 Shell" },
  { value: "repeat", label: "循环" },
  { value: "image-match", label: "图片匹配" },
];

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(min, Math.min(max, Math.round(next))) : fallback;
}

export function normalizeAutomationStep(value: Partial<AutomationStep>): AutomationStep {
  const kinds = new Set(AUTOMATION_STEP_KINDS.map((item) => item.value));
  const kind = kinds.has(value.kind as AutomationStepKind) ? value.kind as AutomationStepKind : "tap";
  return {
    id: typeof value.id === "string" && value.id ? value.id : `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    label: typeof value.label === "string" ? value.label : "",
    x: numberValue(value.x, 500, 0, 8192),
    y: numberValue(value.y, 500, 0, 8192),
    x2: numberValue(value.x2, 700, 0, 8192),
    y2: numberValue(value.y2, 500, 0, 8192),
    randomOffsetX: numberValue(value.randomOffsetX, 0, 0, 8192),
    randomOffsetY: numberValue(value.randomOffsetY, 0, 0, 8192),
    duration: numberValue(value.duration, 300, 10, 60_000),
    keyCode: numberValue(value.keyCode, 3, 1, 300),
    text: typeof value.text === "string" ? value.text : "",
    packageName: typeof value.packageName === "string" ? value.packageName : "",
    apkPath: typeof value.apkPath === "string" ? value.apkPath : "",
    command: typeof value.command === "string" ? value.command : "",
    seconds: numberValue(value.seconds, 1, 0, 86_400),
    count: numberValue(value.count, 2, 1, 1000),
    children: Array.isArray(value.children) ? value.children.map((item) => normalizeAutomationStep(item)) : [],
    templateData: typeof value.templateData === "string" ? value.templateData : "",
    threshold: Number.isFinite(Number(value.threshold)) ? Math.max(0.01, Math.min(1, Number(value.threshold))) : 0.18,
    cropX: numberValue(value.cropX, 0, 0, 8192),
    cropY: numberValue(value.cropY, 0, 0, 8192),
    cropWidth: numberValue(value.cropWidth, 0, 0, 8192),
    cropHeight: numberValue(value.cropHeight, 0, 0, 8192),
  };
}

export function createAutomationScript(name = "未命名脚本"): AutomationScript {
  return { id: `script-${Date.now()}`, name, steps: [], variables: {}, updatedAt: new Date().toISOString() };
}

export function normalizeAutomationScript(value: (Partial<AutomationScript> & { variables?: unknown; steps?: unknown }) | Record<string, unknown> = {}): AutomationScript {
  const raw = value as Partial<AutomationScript> & { variables?: unknown; steps?: unknown };
  const variables: Record<string, string> = {};
  if (raw.variables && typeof raw.variables === "object" && !Array.isArray(raw.variables)) {
    for (const [key, item] of Object.entries(raw.variables)) {
      if (/^[\w.-]+$/.test(key) && typeof item === "string") variables[key] = item;
    }
  }
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((item) => normalizeAutomationStep(item && typeof item === "object" ? item as Partial<AutomationStep> : {}))
    : [];
  return {
    ...createAutomationScript(typeof raw.name === "string" ? raw.name : "未命名脚本"),
    id: typeof raw.id === "string" && raw.id ? raw.id : `script-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    steps,
    variables,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  };
}

export function validateAutomationScript(script: AutomationScript): string[] {
  const errors: string[] = [];
  const visit = (step: AutomationStep, index: string) => {
    if (step.kind === "text" && !step.text.trim()) errors.push(`第 ${index} 步请输入文字`);
    if ((step.kind === "shell" || step.kind === "condition") && !step.command.trim()) errors.push(`第 ${index} 步请输入 Shell 命令`);
    if ((step.kind === "launch-app" || step.kind === "install-apk") && !step.packageName.trim() && step.kind === "launch-app") errors.push(`第 ${index} 步请输入应用包名`);
    if (step.kind === "install-apk" && !step.apkPath.trim()) errors.push(`第 ${index} 步请选择 APK`);
    if (step.kind === "repeat" && !step.children.length) errors.push(`第 ${index} 步循环至少需要一个子步骤`);
    if (step.kind === "image-match" && !step.templateData) errors.push(`第 ${index} 步请选择图片模板`);
    if (step.kind === "image-match" && ((step.cropWidth > 0 && step.cropHeight <= 0) || (step.cropHeight > 0 && step.cropWidth <= 0))) errors.push(`第 ${index} 步图片裁剪区域需要同时填写宽和高`);
    step.children.forEach((child, childIndex) => visit(child, `${index}.${childIndex + 1}`));
  };
  script.steps.forEach((step, index) => visit(step, String(index + 1)));
  return errors;
}

export function interpolate(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => variables[key] ?? "");
}

export function updateAutomationStepTree(
  steps: AutomationStep[],
  id: string,
  patch: Partial<AutomationStep>,
): AutomationStep[] {
  return steps.map((step) => {
    const children = updateAutomationStepTree(step.children, id, patch);
    if (step.id === id) return normalizeAutomationStep({ ...step, ...patch, children });
    return children === step.children ? step : { ...step, children };
  });
}

export function appendAutomationStep(
  steps: AutomationStep[],
  parentId: string,
  child: AutomationStep,
): AutomationStep[] {
  return steps.map((step) => {
    if (step.id === parentId) return { ...step, children: [...step.children, child] };
    const children = appendAutomationStep(step.children, parentId, child);
    return children === step.children ? step : { ...step, children };
  });
}

export function removeAutomationStepTree(steps: AutomationStep[], id: string): AutomationStep[] {
  const filtered = steps.filter((step) => step.id !== id);
  return filtered.map((step) => {
    const children = removeAutomationStepTree(step.children, id);
    return children === step.children ? step : { ...step, children };
  });
}

export function moveAutomationStepTree(
  steps: AutomationStep[],
  id: string,
  direction: -1 | 1,
): AutomationStep[] {
  const index = steps.findIndex((step) => step.id === id);
  if (index >= 0) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return steps;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  return steps.map((step) => {
    const children = moveAutomationStepTree(step.children, id, direction);
    return children === step.children ? step : { ...step, children };
  });
}
