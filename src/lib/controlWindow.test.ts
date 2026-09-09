// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_WINDOW_LABEL,
  CONTROL_WINDOW_PREFERENCES_KEY,
  DEFAULT_CONTROL_WINDOW_PREFERENCES,
  openControlWindow,
  persistControlWindowPreferences,
  readControlWindowPreferences,
} from "./controlWindow";

const windowState = vi.hoisted(() => ({
  instances: [] as Array<{
    label: string;
    options: Record<string, unknown>;
    show: ReturnType<typeof vi.fn>;
    setFocus: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>;
    emitTo: ReturnType<typeof vi.fn>;
  }>,
  getByLabel: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  class FakeWebviewWindow {
    label: string;
    options: Record<string, unknown>;
    show = vi.fn(async () => {});
    setFocus = vi.fn(async () => {});
    setAlwaysOnTop = vi.fn(async () => {});
    emitTo = vi.fn(async () => {});

    static getByLabel = windowState.getByLabel;

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      windowState.instances.push(this);
    }
  }

  return { WebviewWindow: FakeWebviewWindow };
});

describe("control window", () => {
  beforeEach(() => {
    localStorage.clear();
    windowState.instances.length = 0;
    windowState.getByLabel.mockReset();
    windowState.getByLabel.mockResolvedValue(null);
  });

  it("persists safe always-on-top and auto-hide preferences", () => {
    expect(readControlWindowPreferences()).toEqual(DEFAULT_CONTROL_WINDOW_PREFERENCES);

    persistControlWindowPreferences({ alwaysOnTop: true, autoHide: true });

    expect(localStorage.getItem(CONTROL_WINDOW_PREFERENCES_KEY)).toBe(
      JSON.stringify({ alwaysOnTop: true, autoHide: true }),
    );
    expect(readControlWindowPreferences()).toEqual({ alwaysOnTop: true, autoHide: true });
  });

  it("opens a compact dedicated control window for the selected device", async () => {
    await openControlWindow("device-1");

    expect(windowState.instances).toHaveLength(1);
    expect(windowState.instances[0].label).toBe(CONTROL_WINDOW_LABEL);
    expect(windowState.instances[0].options).toMatchObject({
      width: 380,
      height: 620,
      minWidth: 340,
      minHeight: 480,
      alwaysOnTop: false,
    });
    expect(windowState.instances[0].options.url).toContain("#/control?device=device-1");
    expect(windowState.instances[0].show).toHaveBeenCalledTimes(1);
    expect(windowState.instances[0].setFocus).toHaveBeenCalledTimes(1);
  });

  it("reuses the window and sends a device change instead of opening another one", async () => {
    const existing = {
      label: CONTROL_WINDOW_LABEL,
      show: vi.fn(async () => {}),
      setFocus: vi.fn(async () => {}),
      setAlwaysOnTop: vi.fn(async () => {}),
      emitTo: vi.fn(async () => {}),
    };
    windowState.getByLabel.mockResolvedValue(existing);

    await openControlWindow("device-2");

    expect(windowState.instances).toHaveLength(0);
    expect(existing.emitTo).toHaveBeenCalledWith(
      CONTROL_WINDOW_LABEL,
      "control-device-change",
      { deviceId: "device-2" },
    );
    expect(existing.show).toHaveBeenCalledTimes(1);
    expect(existing.setFocus).toHaveBeenCalledTimes(1);
  });
});
