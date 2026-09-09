// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { FloatingControlPage } from "./FloatingControl";
import type { DeviceInfo } from "../types";

const windowState = vi.hoisted(() => ({
  listen: vi.fn(),
  hide: vi.fn(),
  setAlwaysOnTop: vi.fn(),
}));

const devices: DeviceInfo[] = [
  {
    id: "one",
    name: "Pixel One",
    serial: "one-serial",
    androidVersion: "13",
    online: true,
    cpu: "2",
    ram: "2G",
    fps: 60,
    adbStatus: "device",
    scrcpyStatus: "stopped",
    dockerStatus: "running",
    ip: "127.0.0.1",
    mac: "",
    resolution: "1080x1920",
    dpi: "420",
    containerId: "container-one",
    image: "redroid",
    startedAt: "",
    uptime: "",
    adbPort: 5555,
    scrcpyPort: 5556,
  },
  {
    id: "two",
    name: "Pixel Two",
    serial: "two-serial",
    androidVersion: "14",
    online: true,
    cpu: "2",
    ram: "2G",
    fps: 60,
    adbStatus: "device",
    scrcpyStatus: "stopped",
    dockerStatus: "running",
    ip: "127.0.0.1",
    mac: "",
    resolution: "1080x1920",
    dpi: "420",
    containerId: "container-two",
    image: "redroid",
    startedAt: "",
    uptime: "",
    adbPort: 5557,
    scrcpyPort: 5558,
  },
];

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => windowState),
}));

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn(),
    home: vi.fn(),
    back: vi.fn(),
    recent: vi.fn(),
    volumeUp: vi.fn(),
    volumeDown: vi.fn(),
    volumeMute: vi.fn(),
    lock: vi.fn(),
    wake: vi.fn(),
    power: vi.fn(),
    setRotationMode: vi.fn(),
    screenOff: vi.fn(),
  },
}));

const { DeviceService } = await import("../services/deviceService");

describe("FloatingControlPage", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(DeviceService.listDevices).mockResolvedValue(devices);
    for (const method of [
      DeviceService.home,
      DeviceService.back,
      DeviceService.recent,
      DeviceService.volumeUp,
      DeviceService.volumeDown,
      DeviceService.volumeMute,
      DeviceService.lock,
      DeviceService.wake,
      DeviceService.power,
      DeviceService.setRotationMode,
      DeviceService.screenOff,
    ]) {
      vi.mocked(method).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    }
    windowState.listen.mockReset();
    windowState.listen.mockResolvedValue(vi.fn());
    windowState.hide.mockReset();
    windowState.setAlwaysOnTop.mockReset();
    windowState.setAlwaysOnTop.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("loads the requested device, switches devices, and sends navigation commands", async () => {
    render(
      <MemoryRouter initialEntries={["/control?device=two"]}>
        <FloatingControlPage />
      </MemoryRouter>,
    );

    expect(document.querySelector(".control-window-workbench")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("option", { name: /Pixel One/ })).toBeTruthy());

    const selector = screen.getByRole("combobox", { name: "设备" });
    expect((selector as HTMLSelectElement).value).toBe("two");
    fireEvent.change(selector, { target: { value: "one" } });
    fireEvent.click(screen.getByRole("button", { name: "HOME" }));

    expect((selector as HTMLSelectElement).value).toBe("one");
    expect(DeviceService.home).toHaveBeenCalledWith("one-serial");
    expect(localStorage.getItem("rdc.controlWindow.deviceId")).toBe("one");
  });

  it("persists window preferences and applies always-on-top immediately", async () => {
    render(
      <MemoryRouter>
        <FloatingControlPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("option", { name: /Pixel One/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox", { name: "窗口置顶" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "失焦自动隐藏" }));

    expect(localStorage.getItem("rdc.controlWindow.preferences")).toBe(
      JSON.stringify({ alwaysOnTop: true, autoHide: true }),
    );
    expect(windowState.setAlwaysOnTop).toHaveBeenCalledWith(true);
  });

  it("still renders a usable control window shell without the Tauri backend", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValueOnce([]);
    const getCurrentWindow = (await import("@tauri-apps/api/window")).getCurrentWindow as ReturnType<typeof vi.fn>;
    getCurrentWindow.mockImplementationOnce(() => {
      throw new Error("Tauri window API is unavailable in browser preview");
    });

    render(
      <MemoryRouter>
        <I18nProvider>
          <FloatingControlPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "浮动控制" })).toBeTruthy();
    expect(await screen.findByText("暂无设备")).toBeTruthy();
  });
});
