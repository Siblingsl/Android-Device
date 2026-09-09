// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../i18n";
import type { DeviceInfo } from "../../types";
import { DeviceStatusBoard } from "./DeviceStatusBoard";

vi.mock("../../services/deviceService", () => ({
  DeviceService: {
    scrcpyStart: vi.fn(),
    connect: vi.fn(),
  },
}));

const { DeviceService } = await import("../../services/deviceService");

const onlineDevice: DeviceInfo = {
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

function renderBoard() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <DeviceStatusBoard devices={[onlineDevice]} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("DeviceStatusBoard", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    vi.mocked(DeviceService.scrcpyStart).mockReset();
    vi.mocked(DeviceService.connect).mockReset();
  });

  afterEach(() => cleanup());

  it("starts the independent scrcpy command from the card and exposes failure text", async () => {
    vi.mocked(DeviceService.scrcpyStart).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "scrcpy missing",
      exitCode: 1,
    });

    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "打开镜像" }));

    expect(await screen.findByText("scrcpy missing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试镜像" })).toBeTruthy();
    expect(DeviceService.scrcpyStart).toHaveBeenCalledWith("127.0.0.1:5555");
  });
});
