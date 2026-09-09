// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAppLauncher } from "./QuickAppLauncher";
import type { AppInfo, DeviceInfo } from "../../types";

vi.mock("../../services/deviceService", () => ({
  DeviceService: {
    listApps: vi.fn(),
    startApp: vi.fn(),
    startAppOnDisplay: vi.fn(),
  },
}));

const { DeviceService } = await import("../../services/deviceService");

const device = (id: string, online = true): DeviceInfo => ({
  id,
  name: `设备 ${id}`,
  serial: `${id}-serial`,
  androidVersion: "13",
  online,
  cpu: "2",
  ram: "2g",
  fps: 60,
  adbStatus: online ? "device" : "offline",
  scrcpyStatus: "stopped",
  dockerStatus: "running",
  ip: "",
  mac: "",
  resolution: "1080x1920",
  dpi: "320",
  containerId: `container-${id}`,
  image: "redroid:13",
  startedAt: "",
  uptime: "",
  adbPort: 5555,
  scrcpyPort: 5556,
});

const app = (packageName: string): AppInfo => ({
  packageName,
  label: "演示应用",
  versionName: "1.0",
  versionCode: "1",
  systemApp: false,
  enabled: true,
  apkPath: "/data/app/demo.apk",
  firstInstallTime: "",
  lastUpdateTime: "",
  size: "",
});

describe("QuickAppLauncher", () => {
  beforeEach(() => {
    vi.mocked(DeviceService.listApps).mockReset();
    vi.mocked(DeviceService.startApp).mockReset();
    vi.mocked(DeviceService.startAppOnDisplay).mockReset();
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("com.demo.app")]);
    vi.mocked(DeviceService.startApp).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.startAppOnDisplay).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => cleanup());

  it("loads apps for the selected device and launches the chosen app directly", async () => {
    const setStatus = vi.fn();
    render(<QuickAppLauncher devices={[device("one"), device("two")]} selectedDevices={[device("two")]} setStatusText={setStatus} />);

    fireEvent.click(screen.getByRole("button", { name: "快速启动应用" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.listApps).toHaveBeenCalledWith("two-serial", false);
    fireEvent.change(screen.getByLabelText("应用"), { target: { value: "com.demo.app" } });
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.startApp).toHaveBeenCalledWith("two-serial", "com.demo.app");
    expect(setStatus).toHaveBeenCalled();
  });

  it("launches the selected online devices on the chosen display", async () => {
    const setStatus = vi.fn();
    const selected = [device("one"), device("two")];
    render(<QuickAppLauncher devices={selected} selectedDevices={selected} setStatusText={setStatus} />);

    fireEvent.click(screen.getByRole("button", { name: "快速启动应用" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText("应用"), { target: { value: "com.demo.app" } });
    fireEvent.change(screen.getByLabelText("启动方式"), { target: { value: "display" } });
    fireEvent.change(screen.getByLabelText("显示屏编号"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.startAppOnDisplay).toHaveBeenNthCalledWith(1, "one-serial", "com.demo.app", 2);
    expect(DeviceService.startAppOnDisplay).toHaveBeenNthCalledWith(2, "two-serial", "com.demo.app", 2);
    expect(setStatus).toHaveBeenCalledWith("已启动 2 台设备");
  });

  it("keeps the launcher unavailable when no online device exists", () => {
    render(<QuickAppLauncher devices={[device("offline", false)]} selectedDevices={[]} setStatusText={vi.fn()} />);

    expect((screen.getByRole("button", { name: "快速启动应用" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
