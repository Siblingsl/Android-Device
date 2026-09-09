// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS, type ShortcutBindings } from "./shortcuts";
import {
  notifyGlobalShortcutsChanged,
  persistGlobalShortcutStatus,
  readGlobalShortcutStatus,
  registerGlobalShortcuts,
  toTauriShortcut,
  unregisterGlobalShortcuts,
} from "./globalShortcuts";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(),
  unregisterAll: vi.fn(),
}));

const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS };

describe("native global shortcuts", () => {
  beforeEach(() => {
    vi.mocked(register).mockReset().mockResolvedValue(undefined);
    vi.mocked(unregisterAll).mockReset().mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("converts the app shortcut format to Tauri CommandOrControl format", () => {
    expect(toTauriShortcut("Ctrl+Shift+P")).toBe("CommandOrControl+Shift+P");
    expect(toTauriShortcut("Alt+D")).toBe("Alt+D");
    expect(toTauriShortcut("Meta+,")).toBe("CommandOrControl+,");
  });

  it("keeps other shortcuts registering when one native registration fails", async () => {
    vi.mocked(register).mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error("already registered")))
      .mockImplementation(() => Promise.resolve());

    const result = await registerGlobalShortcuts(bindings, true, vi.fn());

    expect(result.registered).toEqual([
      "openDashboard",
      "openTerminal",
      "refreshWorkspace",
      "openSettings",
    ]);
    expect(result.failed.openDevices).toBe("occupied");
  });

  it("maps pressed native events back to the configured action", async () => {
    const onAction = vi.fn();
    await registerGlobalShortcuts(bindings, true, onAction);
    const handler = vi.mocked(register).mock.calls[0]?.[1] as ((event: { state: string }) => void);

    handler({ state: "Pressed" });
    handler({ state: "Released" });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("openDashboard");
  });

  it("does not register shortcuts when system shortcuts are disabled", async () => {
    const result = await registerGlobalShortcuts(bindings, false, vi.fn());

    expect(result.enabled).toBe(false);
    expect(result.registered).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  });

  it("unregisters all shortcuts through the native plugin", async () => {
    await unregisterGlobalShortcuts();

    expect(unregisterAll).toHaveBeenCalledTimes(1);
  });

  it("persists status and emits a configuration change event", () => {
    const status = {
      available: true,
      enabled: false,
      registered: [],
      failed: {},
    } as const;
    const listener = vi.fn();
    window.addEventListener("rdc:global-shortcuts-changed", listener);

    persistGlobalShortcutStatus(status);
    notifyGlobalShortcutsChanged();

    expect(readGlobalShortcutStatus()).toEqual(status);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("rdc:global-shortcuts-changed", listener);
  });
});
