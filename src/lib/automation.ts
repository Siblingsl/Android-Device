import type { AutomationScript, AutomationStep, AutomationStepKind, AutomationStepValue } from "../types";

export const AUTOMATION_STORAGE_KEY = "rdc.automation.scripts";

const STEP_KINDS: AutomationStepKind[] = [
  "tap",
  "swipe",
  "longPress",
  "text",
  "key",
  "shell",
  "wait",
  "screenshot",
  "record",
  "launch",
  "install",
  "imageMatch",
  "if",
  "loop",
];

const DEFAULT_STEP_PARAMS: Record<AutomationStepKind, Record<string, AutomationStepValue>> = {
  tap: { x: 0, y: 0 },
  swipe: { x1: 0, y1: 0, x2: 0, y2: 0, duration: 300 },
  longPress: { x: 0, y: 0, duration: 800 },
  text: { text: "" },
  key: { keycode: 3 },
  shell: { command: "" },
  wait: { milliseconds: 500 },
  screenshot: { outputPath: "" },
  record: { outputPath: "", durationSeconds: 0 },
  launch: { packageName: "" },
  install: { path: "" },
  imageMatch: { imagePath: "", threshold: 0.85, followMatchPoint: true },
  if: { expression: "" },
  loop: { count: 1 },
};

function now(): string {
  return new Date().toISOString();
}

function isStepKind(value: unknown): value is AutomationStepKind {
  return typeof value === "string" && STEP_KINDS.includes(value as AutomationStepKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeParams(kind: AutomationStepKind, params: unknown): Record<string, AutomationStepValue> {
  const defaults = DEFAULT_STEP_PARAMS[kind];
  if (!isRecord(params)) return { ...defaults };
  const next: Record<string, AutomationStepValue> = { ...defaults };
  for (const [key, value] of Object.entries(params)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    ) {
      next[key] = value as AutomationStepValue;
    }
  }
  return next;
}

function normalizeStep(raw: unknown, index: number): AutomationStep {
  const source = isRecord(raw) ? raw : {};
  const kind = isStepKind(source.kind) ? source.kind : "wait";
  return {
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : `step-${index + 1}`,
    kind,
    label: typeof source.label === "string" && source.label.trim() ? source.label.trim() : kind,
    enabled: source.enabled !== false,
    ...(typeof source.continueOnError === "boolean" ? { continueOnError: source.continueOnError } : {}),
    beforeDelayMs: typeof source.beforeDelayMs === "number" && source.beforeDelayMs >= 0 ? source.beforeDelayMs : 0,
    afterDelayMs: typeof source.afterDelayMs === "number" && source.afterDelayMs >= 0 ? source.afterDelayMs : 0,
    params: normalizeParams(kind, source.params),
  };
}

export function createAutomationScript(input: Partial<AutomationScript> & Pick<AutomationScript, "id" | "name">): AutomationScript {
  const timestamp = now();
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const usedIds = new Set<string>();
  const steps = rawSteps.map((raw, index) => {
    const step = normalizeStep(raw, index);
    let id = step.id;
    if (usedIds.has(id)) id = `step-${index + 1}`;
    while (usedIds.has(id)) id = `step-${usedIds.size + 1}`;
    usedIds.add(id);
    return { ...step, id };
  });
  return {
    id: input.id,
    name: input.name.trim() || "未命名脚本",
    description: input.description?.trim() ?? "",
    version: typeof input.version === "number" && input.version > 0 ? input.version : 1,
    enabled: input.enabled !== false,
    tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [],
    variables: isRecord(input.variables)
      ? Object.fromEntries(Object.entries(input.variables).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
    steps,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    ...(input.lastRunAt ? { lastRunAt: input.lastRunAt } : {}),
  };
}

export function defaultAutomationScript(): AutomationScript {
  return createAutomationScript({
    id: `script-${Date.now()}`,
    name: "设备巡检示例",
    description: "截取设备当前画面，作为后续自动化流程的起点。",
    tags: ["示例", "巡检"],
    steps: [
      { id: "step-1", kind: "wait", label: "等待设备稳定", enabled: true, params: { milliseconds: 500 } },
      { id: "step-2", kind: "screenshot", label: "保存当前截图", enabled: true, params: { outputPath: "${screenshotDir}" } },
    ],
  });
}

export function readAutomationScripts(): AutomationScript[] {
  try {
    const raw = localStorage.getItem(AUTOMATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string")
      .map((entry) => createAutomationScript({ ...(entry as Partial<AutomationScript>), id: entry.id as string, name: entry.name as string }));
  } catch {
    return [];
  }
}

export function writeAutomationScripts(scripts: AutomationScript[]): void {
  try {
    localStorage.setItem(AUTOMATION_STORAGE_KEY, JSON.stringify(scripts.map((script) => createAutomationScript(script))));
  } catch {
    /* local persistence is best effort */
  }
}
