import type {
  AutomationRunLog,
  AutomationRunResult,
  AutomationScript,
  AutomationStep,
  AutomationStepValue,
} from "../types";

export interface AutomationRuntime {
  tap: (serial: string, x: number, y: number) => Promise<void>;
  swipe: (serial: string, x1: number, y1: number, x2: number, y2: number, duration: number) => Promise<void>;
  text: (serial: string, value: string) => Promise<void>;
  keyevent: (serial: string, code: number) => Promise<void>;
  shell: (serial: string, command: string) => Promise<void>;
  screenshot: (serial: string, outputPath: string) => Promise<void>;
  launch: (serial: string, packageName: string) => Promise<void>;
  install: (serial: string, path: string) => Promise<void>;
  record: (serial: string, outputPath: string, durationSeconds: number) => Promise<void>;
}

export interface AutomationRunOptions {
  signal?: AbortSignal;
  variables?: Record<string, string>;
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

async function executeStep(step: AutomationStep, serial: string, runtime: AutomationRuntime, signal?: AbortSignal): Promise<void> {
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
      await runtime.launch(serial, asString(valueOf(step, "packageName", "")));
      return;
    case "install":
      await runtime.install(serial, asString(valueOf(step, "path", "")));
      return;
    case "record":
      await runtime.record(serial, asString(valueOf(step, "outputPath", "")), asNumber(valueOf(step, "durationSeconds", 0), 0));
      return;
    case "imageMatch":
    case "if":
    case "loop":
      throw new Error(`暂不支持步骤类型：${step.kind}`);
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
    try {
      ensureActive(options.signal);
      const startedAt = now();
      await executeStep(expandParams(rawStep, variables), serial, runtime, options.signal);
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
