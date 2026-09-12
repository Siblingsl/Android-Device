export type ShortcutAction =
  | "screenshot"
  | "home"
  | "back"
  | "recent"
  | "lock"
  | "wake"
  | "recording"
  | "terminal"
  | "files"
  | "automation"
  | "gnirehtet"
  | "toggle-stream"
  | "toggle-window";

export interface ShortcutBinding {
  id: string;
  key: string;
  action: ShortcutAction;
  deviceId: string;
  enabled: boolean;
}

export const SHORTCUT_STORAGE_KEY = "rdc-shortcuts-v1";

export const SHORTCUT_ACTIONS: Array<{ value: ShortcutAction; label: string; needsDevice: boolean }> = [
  { value: "screenshot", label: "截图", needsDevice: true },
  { value: "home", label: "主页键", needsDevice: true },
  { value: "back", label: "返回键", needsDevice: true },
  { value: "recent", label: "最近任务", needsDevice: true },
  { value: "lock", label: "锁定设备", needsDevice: true },
  { value: "wake", label: "唤醒设备", needsDevice: true },
  { value: "recording", label: "开始 / 停止录制", needsDevice: true },
  { value: "terminal", label: "打开交互终端", needsDevice: true },
  { value: "files", label: "打开文件管理", needsDevice: true },
  { value: "automation", label: "打开自动化工作台", needsDevice: true },
  { value: "gnirehtet", label: "切换网络供网", needsDevice: true },
  { value: "toggle-stream", label: "切换内嵌投屏", needsDevice: true },
  { value: "toggle-window", label: "显示 / 隐藏主窗口", needsDevice: false },
];

const MODIFIER_ORDER = ["CommandOrControl", "Control", "Alt", "Shift", "Super"];
const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "CommandOrControl",
  command: "CommandOrControl",
  ctrl: "CommandOrControl",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  win: "Super",
  windows: "Super",
  super: "Super",
};

/** Convert common desktop notation into the format accepted by Tauri. */
export function normalizeShortcutKey(value: string): string {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const alias = MODIFIER_ALIASES[part.toLowerCase()];
      return alias ?? (part.length === 1 ? part.toUpperCase() : part);
    });
  const unique = [...new Set(parts)];
  const modifiers = unique
    .filter((part) => MODIFIER_ORDER.includes(part))
    .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const keys = unique.filter((part) => !MODIFIER_ORDER.includes(part));
  return [...modifiers, ...keys].join("+");
}

export function shortcutKeyError(value: string): string | null {
  const normalized = normalizeShortcutKey(value);
  if (!normalized) return "快捷键不能为空";
  const parts = normalized.split("+");
  if (parts.some((part) => !/^[A-Za-z0-9]+$/.test(part))) {
    return "快捷键只能使用字母、数字、功能键和修饰键";
  }
  if (parts.filter((part) => MODIFIER_ORDER.includes(part)).length === parts.length) {
    return "快捷键还需要一个实际按键";
  }
  return null;
}

export function findShortcutConflicts(bindings: ShortcutBinding[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding.enabled) continue;
    const key = normalizeShortcutKey(binding.key);
    if (!key) continue;
    const ids = groups.get(key) ?? [];
    ids.push(binding.id);
    groups.set(key, ids);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

export function createShortcutId(): string {
  return `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { id: "shortcut-screenshot", key: "CommandOrControl+Shift+S", action: "screenshot", deviceId: "", enabled: false },
  { id: "shortcut-home", key: "CommandOrControl+Shift+H", action: "home", deviceId: "", enabled: false },
  { id: "shortcut-toggle-window", key: "CommandOrControl+Shift+Space", action: "toggle-window", deviceId: "", enabled: false },
];
