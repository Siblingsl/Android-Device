import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import {
  normalizeShortcut,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutBindings,
} from "./shortcuts";

export const GLOBAL_SHORTCUT_STATUS_KEY = "rdc.shortcuts.status";
export const GLOBAL_SHORTCUTS_CHANGED_EVENT = "rdc:global-shortcuts-changed";
export const GLOBAL_SHORTCUT_STATUS_CHANGED_EVENT = "rdc:global-shortcut-status-changed";

export type GlobalShortcutFailure = "occupied" | "invalid" | "unavailable";

export interface GlobalShortcutStatus {
  available: boolean;
  enabled: boolean;
  registered: ShortcutAction[];
  failed: Partial<Record<ShortcutAction, GlobalShortcutFailure>>;
}

export function toTauriShortcut(shortcut: string): string {
  return normalizeShortcut(shortcut)
    .split("+")
    .map((part) => (part === "Ctrl" || part === "Meta" ? "CommandOrControl" : part))
    .join("+");
}

function unavailableStatus(enabled: boolean): GlobalShortcutStatus {
  return {
    available: false,
    enabled,
    registered: [],
    failed: Object.fromEntries(
      SHORTCUT_ACTIONS.map((action) => [action, "unavailable"]),
    ) as Partial<Record<ShortcutAction, GlobalShortcutFailure>>,
  };
}

export function persistGlobalShortcutStatus(status: GlobalShortcutStatus): void {
  try {
    localStorage.setItem(GLOBAL_SHORTCUT_STATUS_KEY, JSON.stringify(status));
  } catch {
    /* local persistence is best effort */
  }
}

function publishStatus(status: GlobalShortcutStatus): void {
  persistGlobalShortcutStatus(status);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GLOBAL_SHORTCUT_STATUS_CHANGED_EVENT));
  }
}

export function readGlobalShortcutStatus(): GlobalShortcutStatus | null {
  try {
    const raw = localStorage.getItem(GLOBAL_SHORTCUT_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GlobalShortcutStatus;
    if (
      typeof parsed.available !== "boolean" ||
      typeof parsed.enabled !== "boolean" ||
      !Array.isArray(parsed.registered) ||
      typeof parsed.failed !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function notifyGlobalShortcutsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GLOBAL_SHORTCUTS_CHANGED_EVENT));
  }
}

export async function unregisterGlobalShortcuts(): Promise<void> {
  try {
    await unregisterAll();
  } catch {
    /* Web preview or an already-closed native runtime */
  }
}

export async function registerGlobalShortcuts(
  bindings: ShortcutBindings,
  enabled: boolean,
  onAction: (action: ShortcutAction) => void,
): Promise<GlobalShortcutStatus> {
  try {
    await unregisterAll();
  } catch {
    const status = unavailableStatus(enabled);
    publishStatus(status);
    return status;
  }

  if (!enabled) {
    const status: GlobalShortcutStatus = {
      available: true,
      enabled: false,
      registered: [],
      failed: {},
    };
    publishStatus(status);
    return status;
  }

  const registered: ShortcutAction[] = [];
  const failed: Partial<Record<ShortcutAction, GlobalShortcutFailure>> = {};

  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = toTauriShortcut(bindings[action]);
    if (!shortcut) {
      failed[action] = "invalid";
      continue;
    }
    try {
      await register(shortcut, (event: { state: string }) => {
        if (event.state === "Pressed") onAction(action);
      });
      registered.push(action);
    } catch {
      failed[action] = "occupied";
    }
  }

  const status: GlobalShortcutStatus = {
    available: true,
    enabled: true,
    registered,
    failed,
  };
  publishStatus(status);
  return status;
}
