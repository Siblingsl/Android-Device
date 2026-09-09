export const SHORTCUTS_STORAGE_KEY = "rdc.shortcuts";
export const GLOBAL_SHORTCUTS_ENABLED_KEY = "rdc.shortcuts.enabled";

export const SHORTCUT_ACTIONS = [
  "openDashboard",
  "openDevices",
  "openTerminal",
  "refreshWorkspace",
  "openSettings",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type ShortcutBindings = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  openDashboard: "Ctrl+1",
  openDevices: "Ctrl+2",
  openTerminal: "Ctrl+3",
  refreshWorkspace: "Ctrl+R",
  openSettings: "Ctrl+,",
};

const modifierKeys = new Set(["Control", "Ctrl", "Alt", "Shift", "Meta", "Command"]);
const blockedTargetTags = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

function tokenForKey(key: string): string | null {
  if (!key || modifierKeys.has(key)) return null;
  const aliases: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    "?": "Question",
  };
  return aliases[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatShortcut(event: KeyboardEvent): string | null {
  if (event.isComposing) return null;
  const key = tokenForKey(event.key);
  if (!key) return null;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.isContentEditable ||
      (element?.tagName && blockedTargetTags.has(element.tagName.toUpperCase())),
  );
}

export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (["Control", "Ctrl", "Meta", "Command"].includes(part)) return "Ctrl";
      if (part.toLowerCase() === "alt") return "Alt";
      if (part.toLowerCase() === "shift") return "Shift";
      return tokenForKey(part) ?? part;
    })
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (isEditableTarget(event.target)) return false;
  const pressed = formatShortcut(event);
  return Boolean(pressed && normalizeShortcut(pressed) === normalizeShortcut(shortcut));
}

export function findShortcutConflict(
  bindings: ShortcutBindings,
  shortcut: string,
  excludedAction?: ShortcutAction,
): ShortcutAction | null {
  const normalized = normalizeShortcut(shortcut);
  return (
    SHORTCUT_ACTIONS.find(
      (action) => action !== excludedAction && normalizeShortcut(bindings[action]) === normalized,
    ) ?? null
  );
}

export function readShortcuts(): ShortcutBindings {
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<ShortcutBindings>;
    const next = { ...DEFAULT_SHORTCUTS };
    for (const action of SHORTCUT_ACTIONS) {
      if (typeof parsed[action] === "string" && normalizeShortcut(parsed[action])) {
        next[action] = normalizeShortcut(parsed[action]);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function persistShortcuts(bindings: ShortcutBindings): void {
  try {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          SHORTCUT_ACTIONS.map((action) => [action, normalizeShortcut(bindings[action])]),
        ),
      ),
    );
  } catch {
    /* local persistence is best effort */
  }
}

export function readGlobalShortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(GLOBAL_SHORTCUTS_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistGlobalShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(GLOBAL_SHORTCUTS_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* local persistence is best effort */
  }
}

export function shortcutActionForEvent(
  event: KeyboardEvent,
  bindings: ShortcutBindings = readShortcuts(),
): ShortcutAction | null {
  return (
    SHORTCUT_ACTIONS.find((action) => matchesShortcut(event, bindings[action])) ?? null
  );
}
