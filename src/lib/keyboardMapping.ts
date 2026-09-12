export type MappingAction = "tap" | "long-press" | "swipe" | "joystick" | "keyevent" | "scroll" | "automation";

export interface KeyboardMapping {
  id: string;
  trigger: string;
  action: MappingAction;
  x: number;
  y: number;
  x2: number;
  y2: number;
  duration: number;
  keyCode: number;
  automationId: string;
  deviceId: string;
  appPackage: string;
  enabled: boolean;
}

export const KEYBOARD_MAPPING_STORAGE_KEY = "rdc.keyboard-mappings.v1";

export function normalizeMapping(mapping: Partial<KeyboardMapping>): KeyboardMapping {
  const action = ["tap", "long-press", "swipe", "joystick", "keyevent", "scroll", "automation"].includes(String(mapping.action))
    ? mapping.action as MappingAction
    : "tap";
  return {
    id: typeof mapping.id === "string" && mapping.id ? mapping.id : `mapping-${Date.now()}`,
    trigger: typeof mapping.trigger === "string" ? mapping.trigger.trim() : "",
    action,
    x: clamp(mapping.x, 0, 8192),
    y: clamp(mapping.y, 0, 8192),
    x2: clamp(mapping.x2, 0, 8192),
    y2: clamp(mapping.y2, 0, 8192),
    duration: clamp(mapping.duration, 10, 60_000, 300),
    keyCode: clamp(mapping.keyCode, 1, 300, 3),
    automationId: typeof mapping.automationId === "string" ? mapping.automationId.trim() : "",
    deviceId: typeof mapping.deviceId === "string" ? mapping.deviceId : "",
    appPackage: typeof mapping.appPackage === "string" ? mapping.appPackage.trim() : "",
    enabled: mapping.enabled !== false,
  };
}

function clamp(value: number | undefined, min: number, max: number, fallback = min) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(min, Math.min(max, Math.round(next))) : fallback;
}

export function matchingMapping(mappings: KeyboardMapping[], trigger: string, deviceId = "", appPackage = "") {
  const key = trigger.trim().toLowerCase();
  return mappings.find((mapping) => mapping.enabled && mapping.trigger.toLowerCase() === key && (!mapping.deviceId || mapping.deviceId === deviceId) && (!mapping.appPackage || mapping.appPackage === appPackage));
}

export function parseForegroundPackage(output: string): string {
  const match = output.match(/\bu\d+\s+([A-Za-z0-9_][A-Za-z0-9_.]*)(?:\/|\s)/);
  return match?.[1] || "";
}

export function mappingError(mapping: KeyboardMapping): string | null {
  if (!mapping.trigger) return "请填写触发按键";
  if ((mapping.action === "swipe" || mapping.action === "joystick") && mapping.x === mapping.x2 && mapping.y === mapping.y2) return `${mapping.action === "joystick" ? "摇杆" : "滑动"}映射需要不同的起点和终点`;
  if (mapping.action === "automation" && !mapping.automationId) return "自动化映射需要选择自动化脚本";
  return null;
}
