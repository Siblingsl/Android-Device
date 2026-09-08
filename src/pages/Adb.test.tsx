// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AdbPage } from "./Adb";
import type { AdbInfo } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getAdbInfo: vi.fn(),
    getLocalSubnet: vi.fn(),
  },
}));
vi.mock("../hooks/useToolProbe", () => ({
  probeTool: vi.fn(),
}));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: {
    setSelectedDeviceId: () => void;
    setStatusText: () => void;
    settings: { adbPath: string; dockerPath: string };
  }) => unknown) =>
    selector({
      setSelectedDeviceId: () => {},
      setStatusText: () => {},
      settings: { adbPath: "adb", dockerPath: "docker" },
    }),
}));

const { DeviceService } = await import("../services/deviceService");
const { probeTool } = await import("../hooks/useToolProbe");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const adbInfo = (version: string): AdbInfo => ({
  version,
  serverRunning: true,
  devices: [],
});

describe("AdbPage refresh ordering", () => {
  beforeEach(() => {
    vi.mocked(probeTool).mockResolvedValue({ ok: true, text: "available" });
    vi.mocked(DeviceService.getLocalSubnet).mockResolvedValue("192.168.1.0/24");
    vi.mocked(DeviceService.getAdbInfo).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the newest ADB information when an earlier refresh resolves later", async () => {
    const initial = deferred<AdbInfo>();
    const refreshed = deferred<AdbInfo>();
    vi.mocked(DeviceService.getAdbInfo)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);

    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.getAdbInfo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "扫描设备" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.getAdbInfo).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve(adbInfo("新 ADB"));
      await refreshed.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("新 ADB")).toBeTruthy();

    await act(async () => {
      initial.resolve(adbInfo("旧 ADB"));
      await initial.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("旧 ADB")).toBeNull();
    expect(screen.getByText("新 ADB")).toBeTruthy();
  });
});
