import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const CONTROL_WINDOW_LABEL = "device-control";
export const CONTROL_WINDOW_PREFERENCES_KEY = "rdc.controlWindow.preferences";

export interface ControlWindowPreferences {
  alwaysOnTop: boolean;
  autoHide: boolean;
}

export const DEFAULT_CONTROL_WINDOW_PREFERENCES: ControlWindowPreferences = {
  alwaysOnTop: false,
  autoHide: false,
};

const pendingWindow: { current: Promise<WebviewWindow> | null } = { current: null };

export function readControlWindowPreferences(): ControlWindowPreferences {
  try {
    const raw = localStorage.getItem(CONTROL_WINDOW_PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_CONTROL_WINDOW_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<ControlWindowPreferences>;
    return {
      alwaysOnTop: parsed.alwaysOnTop === true,
      autoHide: parsed.autoHide === true,
    };
  } catch {
    return { ...DEFAULT_CONTROL_WINDOW_PREFERENCES };
  }
}

export function persistControlWindowPreferences(preferences: ControlWindowPreferences): void {
  try {
    localStorage.setItem(
      CONTROL_WINDOW_PREFERENCES_KEY,
      JSON.stringify({
        alwaysOnTop: preferences.alwaysOnTop === true,
        autoHide: preferences.autoHide === true,
      }),
    );
  } catch {
    /* local persistence is best effort */
  }
}

function controlWindowUrl(deviceId?: string): string {
  const query = deviceId ? `?device=${encodeURIComponent(deviceId)}` : "";
  return `index.html#/control${query}`;
}

async function applyPreferences(window: WebviewWindow, preferences: ControlWindowPreferences) {
  try {
    await window.setAlwaysOnTop(preferences.alwaysOnTop);
  } catch {
    /* Web preview and older native windows may not support this call */
  }
}

export async function openControlWindow(
  deviceId?: string,
  options: { title?: string } = {},
): Promise<WebviewWindow> {
  if (pendingWindow.current) return pendingWindow.current;

  const preferences = readControlWindowPreferences();
  const opening = (async () => {
    const existing = await WebviewWindow.getByLabel(CONTROL_WINDOW_LABEL);
    const controlWindow = existing ?? new WebviewWindow(CONTROL_WINDOW_LABEL, {
      url: controlWindowUrl(deviceId),
      title: options.title ?? "浮动控制",
      width: 380,
      height: 620,
      minWidth: 340,
      minHeight: 480,
      resizable: true,
      center: true,
      focus: true,
      alwaysOnTop: preferences.alwaysOnTop,
      skipTaskbar: true,
    });

    await applyPreferences(controlWindow, preferences);
    if (existing && deviceId) {
      await controlWindow.emitTo(CONTROL_WINDOW_LABEL, "control-device-change", { deviceId });
    }
    await controlWindow.show();
    await controlWindow.setFocus();
    return controlWindow;
  })();

  pendingWindow.current = opening;
  try {
    return await opening;
  } finally {
    if (pendingWindow.current === opening) pendingWindow.current = null;
  }
}
