// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, themePrefOf } from "./appStore";
import type { AppSettings } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(async (s: AppSettings) => s),
    getSystemStatus: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    listDevicesUnified: vi.fn(async () => []),
  },
}));

const { DeviceService } = await import("../services/deviceService");

const settingsWith = (theme: string | null): AppSettings => ({
  theme,
  language: "zh-CN",
  autoUpdate: true,
  logPath: "",
  screenshotPath: "",
  apkPath: "",
  proxy: "",
  dockerPath: "docker",
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  recordingPath: "",
  closeToTray: false,
  launchAtLogin: false,
  resourceAlertThreshold: 80,
  deviceRefreshIntervalSecs: 10,
  deviceMonitorRules: {},
});

describe("tri-state theme preference", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    useAppStore.setState({ theme: "light", themePref: "light", settings: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-theme");
  });

  it("maps stored settings values onto the tri-state preference", () => {
    expect(themePrefOf("dark")).toBe("dark");
    expect(themePrefOf("light")).toBe("light");
    expect(themePrefOf(null)).toBe("system");
    expect(themePrefOf(undefined)).toBe("system");
    expect(themePrefOf("nonsense")).toBe("system");
  });

  it("applies an explicit preference to the document element", () => {
    useAppStore.getState().setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(useAppStore.getState().themePref).toBe("dark");
    expect(useAppStore.getState().theme).toBe("dark");

    useAppStore.getState().setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("resolves the system preference through matchMedia and tracks changes", () => {
    const listeners = new Set<() => void>();
    const mql = {
      matches: true,
      addEventListener: vi.fn((_k: string, fn: () => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_k: string, fn: () => void) => listeners.delete(fn)),
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql as unknown as MediaQueryList));

    useAppStore.getState().setTheme("system");
    expect(useAppStore.getState().themePref).toBe("system");
    expect(useAppStore.getState().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(mql.addEventListener).toHaveBeenCalled();

    // The OS flips to light mode → the resolved theme follows.
    mql.matches = false;
    listeners.forEach((fn) => fn());
    expect(useAppStore.getState().theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // An explicit preference detaches the system listener.
    useAppStore.getState().setTheme("light");
    expect(mql.removeEventListener).toHaveBeenCalled();
  });

  it("derives the preference from loaded settings (null = follow system)", async () => {
    vi.mocked(DeviceService.getSettings).mockResolvedValue(settingsWith(null));
    await useAppStore.getState().loadSettings();
    expect(useAppStore.getState().themePref).toBe("system");
    expect(useAppStore.getState().settings?.theme).toBeNull();
  });

  it("keeps an explicit dark preference after saving settings", async () => {
    vi.mocked(DeviceService.getSettings).mockResolvedValue(settingsWith("dark"));
    await useAppStore.getState().loadSettings();
    expect(useAppStore.getState().themePref).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
