// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "./Settings";
import { DEFAULT_SHORTCUTS } from "../lib/shortcuts";
import type { AppSettings } from "../types";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.1.0") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    updateSettings: vi.fn().mockResolvedValue(undefined),
    revealInFolder: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../hooks/useToolProbe", () => ({
  useToolProbe: () => ({ tools: {}, busy: null, probe: vi.fn(), probeMany: vi.fn().mockResolvedValue({ ok: 0, total: 0 }) }),
}));

const settings: AppSettings = {
  theme: "light",
  language: "zh-CN",
  autoUpdate: true,
  logPath: "",
  screenshotPath: "",
  apkPath: "",
  proxy: "",
  dockerPath: "docker",
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  gappsZipPath: "",
  installGapps: true,
  autoStartDeviceIds: [],
  createAutoStart: false,
  createStayOnForm: false,
  createWaitAdb: true,
  resourceAlertThreshold: 80,
  deviceRefreshIntervalSecs: 10,
  deviceMonitorRules: {},
};

const storeState = {
  settings,
  devices: [],
  loadSettings: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  setStatusText: vi.fn(),
  setTheme: vi.fn(),
};

vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

describe("Settings shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    storeState.setStatusText.mockReset();
  });

  afterEach(() => cleanup());

  it("records a shortcut from the keyboard and persists it", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const capture = screen.getByRole("button", { name: "录入 打开设备中心快捷键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: "d", altKey: true });

    expect(screen.getByText("Alt+D")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("rdc.shortcuts") ?? "{}")).toMatchObject({
      ...DEFAULT_SHORTCUTS,
      openDevices: "Alt+D",
    });
  });

  it("rejects a duplicate shortcut and offers a reset to defaults", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const capture = screen.getByRole("button", { name: "录入 打开仪表盘快捷键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: "2", ctrlKey: true });

    expect(screen.getByRole("alert").textContent).toContain("设备中心");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认快捷键" }));
    expect(screen.getByRole("button", { name: "录入 打开仪表盘快捷键" }).textContent).toBe("Ctrl+1");
  });

  it("shows system shortcut registration as enabled by default", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect((screen.getByRole("checkbox", { name: "启用系统级快捷键" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/系统快捷键已启用/)).toBeTruthy();
  });

  it("persists disabling system shortcuts and requests re-registration", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "启用系统级快捷键" }));

    expect(localStorage.getItem("rdc.shortcuts.enabled")).toBe("0");
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rdc:global-shortcuts-changed" }),
    );
    dispatchSpy.mockRestore();
  });

  it("renders the registered count and an occupied shortcut state", () => {
    localStorage.setItem(
      "rdc.shortcuts.status",
      JSON.stringify({
        available: true,
        enabled: true,
        registered: ["openDashboard"],
        failed: { openDevices: "occupied" },
      }),
    );

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/1\/5 已注册/)).toBeTruthy();
    expect(screen.getByText("被占用")).toBeTruthy();
  });
});
