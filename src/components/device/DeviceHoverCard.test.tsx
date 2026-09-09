// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { DeviceInfo } from "../../types";
import { DeviceHoverCard } from "./DeviceHoverCard";

vi.mock("../../services/deviceService", () => ({
  DeviceService: {
    getDevice: vi.fn(),
    screenshot: vi.fn(),
  },
}));

const { DeviceService } = await import("../../services/deviceService");

const device: DeviceInfo = {
  id: "pixel-7",
  name: "Pixel 7",
  serial: "127.0.0.1:5555",
  androidVersion: "14",
  online: true,
  cpu: "4",
  ram: "4g",
  cpuUsage: 22,
  memoryUsage: 38,
  fps: 60,
  adbStatus: "device",
  scrcpyStatus: "stopped",
  dockerStatus: "running",
  ip: "127.0.0.1",
  mac: "",
  resolution: "1080x1920",
  dpi: "420",
  containerId: "container-pixel-7",
  image: "redroid:14",
  startedAt: "",
  uptime: "12m",
  adbPort: 5555,
  scrcpyPort: 5556,
};

describe("DeviceHoverCard", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(DeviceService.getDevice).mockResolvedValue({
      ...device,
      batteryLevel: 78,
      batteryCharging: true,
      batteryTemperatureC: 31.5,
      batteryVoltageV: 4.21,
      batteryPowerSource: "USB",
    });
    vi.mocked(DeviceService.screenshot).mockResolvedValue({
      success: true,
      path: "shot.png",
      base64: "c2NyZWVu",
    });
  });

  afterEach(() => cleanup());

  it("loads real battery telemetry and a screenshot for an online device", async () => {
    render(
      <I18nProvider>
        <DeviceHoverCard device={device} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("78% · 充电中")).toBeTruthy());
    expect(screen.getByText("31.5 °C · 4.21 V")).toBeTruthy();
    expect(screen.getByText("USB")).toBeTruthy();
    expect(screen.getByRole("img", { name: "设备悬浮截图" }).getAttribute("src")).toBe("data:image/png;base64,c2NyZWVu");
    expect(DeviceService.getDevice).toHaveBeenCalledWith("pixel-7");
    expect(DeviceService.screenshot).toHaveBeenCalledWith("127.0.0.1:5555");
  });
});
