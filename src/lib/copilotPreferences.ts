export const COPILOT_PREFERENCES_STORAGE_KEY = "rdc.copilot.preferences";

export interface CopilotPreferences {
  endpoint: string;
  model: string;
  targetSerial: string;
  maxTokens: number;
  timeoutMs: number;
  maxSteps: number;
  totalTimeoutMs: number;
}

export const DEFAULT_COPILOT_PREFERENCES: CopilotPreferences = {
  endpoint: "http://127.0.0.1:11434/v1",
  model: "qwen2.5",
  targetSerial: "",
  maxTokens: 1200,
  timeoutMs: 60_000,
  maxSteps: 8,
  totalTimeoutMs: 120_000,
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

export function readCopilotPreferences(): CopilotPreferences {
  try {
    const raw = localStorage.getItem(COPILOT_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COPILOT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<CopilotPreferences>;
    return {
      endpoint: typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint.trim() : DEFAULT_COPILOT_PREFERENCES.endpoint,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_COPILOT_PREFERENCES.model,
      targetSerial: typeof parsed.targetSerial === "string" ? parsed.targetSerial.trim() : DEFAULT_COPILOT_PREFERENCES.targetSerial,
      maxTokens: boundedNumber(parsed.maxTokens, DEFAULT_COPILOT_PREFERENCES.maxTokens, 128, 16_384),
      timeoutMs: boundedNumber(parsed.timeoutMs, DEFAULT_COPILOT_PREFERENCES.timeoutMs, 1_000, 120_000),
      maxSteps: boundedNumber(parsed.maxSteps, DEFAULT_COPILOT_PREFERENCES.maxSteps, 1, 32),
      totalTimeoutMs: boundedNumber(parsed.totalTimeoutMs, DEFAULT_COPILOT_PREFERENCES.totalTimeoutMs, 1_000, 600_000),
    };
  } catch {
    return { ...DEFAULT_COPILOT_PREFERENCES };
  }
}

export function writeCopilotPreferences(preferences: CopilotPreferences): void {
  try {
    localStorage.setItem(COPILOT_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...preferences,
      endpoint: preferences.endpoint.trim(),
      model: preferences.model.trim(),
      targetSerial: preferences.targetSerial.trim(),
    }));
  } catch {
    /* preferences are best effort and never block device work */
  }
}
