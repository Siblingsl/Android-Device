import type {
  AutomationRunLog,
  AutomationBatchResult,
  AutomationBatchDeviceResult,
  AutomationRunResult,
  AutomationScript,
  AutomationStep,
  AutomationStepValue,
} from "../types";
import { createAutomationScript } from "./automation";

export interface AutomationRuntime {
  tap: (serial: string, x: number, y: number) => Promise<void>;
  swipe: (serial: string, x1: number, y1: number, x2: number, y2: number, duration: number) => Promise<void>;
  longPress: (serial: string, x: number, y: number, duration: number) => Promise<void>;
  text: (serial: string, value: string) => Promise<void>;
  keyevent: (serial: string, code: number) => Promise<void>;
  shell: (serial: string, command: string) => Promise<void>;
  screenshot: (serial: string, outputPath: string) => Promise<void>;
  launch: (serial: string, packageName: string, displayId?: number) => Promise<void>;
  install: (serial: string, path: string) => Promise<void>;
  record: (serial: string, outputPath: string, durationSeconds: number) => Promise<void>;
  imageMatch?: (serial: string, imagePath: string, threshold: number) => Promise<{ matched: boolean; x?: number; y?: number }>;
}

export interface AutomationRunOptions {
  signal?: AbortSignal;
  variables?: Record<string, string>;
  session?: AutomationRunSession;
}

export interface AutomationBatchOptions extends AutomationRunOptions {
  concurrency?: number;
  onDeviceResult?: (entry: AutomationBatchDeviceResult) => void;
}

export interface AutomationRunSession {
  signal: AbortSignal;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  isPaused: () => boolean;
  waitIfPaused: () => Promise<void>;
}

export function createAutomationRunSession(): AutomationRunSession {
  const controller = new AbortController();
  let paused = false;
  let waiters: Array<() => void> = [];
  return {
    signal: controller.signal,
    pause: () => { paused = true; },
    resume: () => {
      paused = false;
      const current = waiters;
      waiters = [];
      current.forEach((resolve) => resolve());
    },
    cancel: () => controller.abort(),
    isPaused: () => paused,
    waitIfPaused: () => paused ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
  };
}

function now(): string {
  return new Date().toISOString();
}

function valueOf(step: AutomationStep, key: string, fallback: AutomationStepValue): AutomationStepValue {
  return step.params[key] ?? fallback;
}

function asNumber(value: AutomationStepValue, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: AutomationStepValue, fallback = ""): string {
  return typeof value === "string" ? value : String(value ?? fallback);
}

function optionalDisplayId(value: AutomationStepValue): number | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("显示屏编号必须是 0 到 100 的整数");
  }
  return parsed;
}

function expand(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([\w.-]+)\}/g, (_, key: string) => variables[key] ?? `\${${key}}`);
}

function expandParams(step: AutomationStep, variables: Record<string, string>): AutomationStep {
  return {
    ...step,
    params: Object.fromEntries(
      Object.entries(step.params).map(([key, value]) => [key, typeof value === "string" ? expand(value, variables) : value]),
    ),
  };
}

function parseNestedSteps(value: AutomationStepValue): AutomationStep[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const rawSteps = parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  return createAutomationScript({ id: "nested", name: "nested", steps: rawSteps as unknown as AutomationStep[] }).steps;
}

function expressionValue(value: string): string | number | boolean {
  const token = value.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (token === "true") return true;
  if (token === "false") return false;
  const numeric = Number(token);
  return token !== "" && Number.isFinite(numeric) ? numeric : token;
}

function evaluateAtomicExpression(expression: string): boolean {
  const source = expression.trim();
  if (!source) return false;
  if (source.startsWith("!")) return !evaluateAtomicExpression(source.slice(1));
  const comparison = source.match(/^(.*?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.*?)$/);
  if (!comparison) {
    const value = expressionValue(source);
    return typeof value === "boolean" ? value : Boolean(value);
  }
  const left = expressionValue(comparison[1]);
  const right = expressionValue(comparison[3]);
  if (typeof left === "number" && typeof right === "number") {
    switch (comparison[2]) {
      case ">": return left > right;
      case ">=": return left >= right;
      case "<": return left < right;
      case "<=": return left <= right;
    }
  }
  const same = String(left) === String(right);
  return comparison[2] === "==" || comparison[2] === "===" ? same : comparison[2] === "!=" || comparison[2] === "!==" ? !same : false;
}

function evaluateExpression(expression: string): boolean {
  return expression.split("||").some((orPart) => orPart.split("&&").every(evaluateAtomicExpression));
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Automation cancelled", "AbortError");
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  ensureActive(signal);
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Automation cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeNestedSteps(steps: AutomationStep[], serial: string, runtime: AutomationRuntime, variables: Record<string, string>, signal?: AbortSignal): Promise<void> {
  for (const rawStep of steps) {
    ensureActive(signal);
    if (!rawStep.enabled) continue;
    const step = expandParams(rawStep, variables);
    try {
      await wait(Math.max(0, step.beforeDelayMs ?? 0), signal);
      await executeStep(step, serial, runtime, variables, signal);
      await wait(Math.max(0, step.afterDelayMs ?? 0), signal);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      if (!rawStep.continueOnError) throw cause;
    }
  }
}

async function executeStep(step: AutomationStep, serial: string, runtime: AutomationRuntime, variables: Record<string, string>, signal?: AbortSignal): Promise<void> {
  ensureActive(signal);
  switch (step.kind) {
    case "wait":
      await wait(Math.max(0, asNumber(valueOf(step, "milliseconds", 500), 500)), signal);
      return;
    case "tap":
      await runtime.tap(serial, asNumber(valueOf(step, "x", 0), 0), asNumber(valueOf(step, "y", 0), 0));
      return;
    case "swipe":
      await runtime.swipe(serial, asNumber(valueOf(step, "x1", 0), 0), asNumber(valueOf(step, "y1", 0), 0), asNumber(valueOf(step, "x2", 0), 0), asNumber(valueOf(step, "y2", 0), 0), asNumber(valueOf(step, "duration", 300), 300));
      return;
    case "longPress":
      await runtime.longPress(serial, asNumber(valueOf(step, "x", 0), 0), asNumber(valueOf(step, "y", 0), 0), asNumber(valueOf(step, "duration", 800), 800));
      return;
    case "text":
      await runtime.text(serial, asString(valueOf(step, "text", "")));
      return;
    case "key":
      await runtime.keyevent(serial, asNumber(valueOf(step, "keycode", 3), 3));
      return;
    case "shell":
      await runtime.shell(serial, asString(valueOf(step, "command", "")));
      return;
    case "screenshot":
      await runtime.screenshot(serial, asString(valueOf(step, "outputPath", "")));
      return;
    case "launch":
      await runtime.launch(serial, asString(valueOf(step, "packageName", "")), optionalDisplayId(valueOf(step, "displayId", "")));
      return;
    case "install":
      await runtime.install(serial, asString(valueOf(step, "path", "")));
      return;
    case "record":
      await runtime.record(serial, asString(valueOf(step, "outputPath", "")), asNumber(valueOf(step, "durationSeconds", 0), 0));
      return;
    case "imageMatch": {
      if (!runtime.imageMatch) throw new Error("当前运行环境不支持图像匹配");
      const match = await runtime.imageMatch(serial, asString(valueOf(step, "imagePath", "")), Math.min(1, Math.max(0, asNumber(valueOf(step, "threshold", 0.85), 0.85))));
      if (!match.matched) throw new Error("未找到匹配图像");
      if (valueOf(step, "followMatchPoint", true) === true && Number.isFinite(match.x) && Number.isFinite(match.y)) {
        await runtime.tap(serial, match.x as number, match.y as number);
      }
      return;
    }
    case "if": {
      const branch = evaluateExpression(asString(valueOf(step, "expression", ""))) ? "thenSteps" : "elseSteps";
      await executeNestedSteps(parseNestedSteps(valueOf(step, branch, "[]")), serial, runtime, variables, signal);
      return;
    }
    case "loop": {
      const count = Math.min(1000, Math.max(0, Math.floor(asNumber(valueOf(step, "count", 1), 1))));
      const body = parseNestedSteps(valueOf(step, "steps", "[]"));
      for (let index = 0; index < count; index += 1) {
        ensureActive(signal);
        await executeNestedSteps(body, serial, runtime, variables, signal);
      }
      return;
    }
    default:
      return;
  }
}

export async function runAutomationScript(
  script: AutomationScript,
  serial: string,
  runtime: AutomationRuntime,
  options: AutomationRunOptions = {},
): Promise<AutomationRunResult> {
  const variables = { ...script.variables, ...options.variables, deviceSerial: serial };
  const logs: AutomationRunLog[] = [];
  let completedSteps = 0;

  for (const rawStep of script.steps) {
    if (!rawStep.enabled) {
      const timestamp = now();
      logs.push({ stepId: rawStep.id, label: rawStep.label, status: "skipped", startedAt: timestamp, finishedAt: timestamp });
      continue;
    }
    const startedAt = now();
    try {
      await options.session?.waitIfPaused();
      ensureActive(options.signal);
      const activeSignal = options.session?.signal ?? options.signal;
      ensureActive(activeSignal);
      const step = expandParams(rawStep, variables);
      await wait(Math.max(0, step.beforeDelayMs ?? 0), activeSignal);
      await executeStep(step, serial, runtime, variables, activeSignal);
      await wait(Math.max(0, step.afterDelayMs ?? 0), activeSignal);
      completedSteps += 1;
      logs.push({ stepId: rawStep.id, label: rawStep.label, status: "completed", startedAt, finishedAt: now() });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return { status: "cancelled", completedSteps, logs };
      }
      logs.push({ stepId: rawStep.id, label: rawStep.label, status: "failed", message, startedAt: now(), finishedAt: now() });
      if (!rawStep.continueOnError) return { status: "failed", completedSteps, logs };
    }
  }

  return { status: "completed", completedSteps, logs };
}

export async function runAutomationStep(
  script: AutomationScript,
  serial: string,
  stepIndex: number,
  runtime: AutomationRuntime,
  options: AutomationRunOptions = {},
): Promise<AutomationRunResult> {
  const step = script.steps[stepIndex];
  if (!step) {
    return {
      status: "failed",
      completedSteps: 0,
      logs: [{ stepId: `step-${stepIndex + 1}`, label: "未知步骤", status: "failed", message: "步骤不存在", startedAt: now(), finishedAt: now() }],
    };
  }
  return runAutomationScript({ ...script, steps: [step] }, serial, runtime, options);
}

export async function runAutomationBatch(
  script: AutomationScript,
  serials: string[],
  runtimeFactory: (serial: string) => AutomationRuntime,
  options: AutomationBatchOptions = {},
): Promise<AutomationBatchResult> {
  const uniqueSerials = [...new Set(serials.map((serial) => serial.trim()).filter(Boolean))];
  const results: AutomationBatchDeviceResult[] = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 2), uniqueSerials.length || 1));
  const worker = async () => {
    while (cursor < uniqueSerials.length) {
      ensureActive(options.signal);
      const index = cursor;
      cursor += 1;
      const serial = uniqueSerials[index];
      const result = await runAutomationScript(script, serial, runtimeFactory(serial), options);
      const entry = { serial, result };
      results[index] = entry;
      options.onDeviceResult?.(entry);
    }
  };
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { status: "cancelled", results: results.filter(Boolean) };
    }
    throw cause;
  }
  const ordered = results.filter(Boolean);
  const status = ordered.some((entry) => entry.result.status === "failed")
    ? "failed"
    : ordered.some((entry) => entry.result.status === "cancelled")
      ? "cancelled"
      : "completed";
  return { status, results: ordered };
}
