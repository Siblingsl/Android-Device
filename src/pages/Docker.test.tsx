// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DockerPage } from "./Docker";
import type { DockerInfo } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    refreshDockerInfo: vi.fn(),
    getWslKernelStatus: vi.fn(),
    getMagiskAssets: vi.fn(),
    getLocalGappsPath: vi.fn(),
    checkInstanceName: vi.fn(),
    checkAdbPort: vi.fn(),
    pathExists: vi.fn(),
  },
}));
vi.mock("../hooks/useToolProbe", () => ({
  probeTool: vi.fn(),
}));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../lib/dialogs", () => ({ askConfirm: vi.fn() }));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: {
    setSelectedDeviceId: () => void;
    setStatusText: () => void;
    settings: null;
    saveSettings: () => Promise<void>;
  }) => unknown) =>
    selector({
      setSelectedDeviceId: () => {},
      setStatusText: () => {},
      settings: null,
      saveSettings: async () => {},
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

const dockerInfo = (version: string): DockerInfo => ({
  running: true,
  version,
  images: [],
  containers: [],
  cpuUsage: 10,
  memoryUsage: 20,
});

describe("DockerPage refresh ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(probeTool).mockResolvedValue({ ok: true, text: "available" });
    vi.mocked(DeviceService.getWslKernelStatus).mockRejectedValue(new Error("unavailable"));
    vi.mocked(DeviceService.getMagiskAssets).mockResolvedValue({
      magiskDir: "",
      magiskOk: false,
      lsposedOk: false,
      shamikoOk: false,
    });
    vi.mocked(DeviceService.getLocalGappsPath).mockResolvedValue("");
    vi.mocked(DeviceService.checkInstanceName).mockResolvedValue(false);
    vi.mocked(DeviceService.checkAdbPort).mockResolvedValue(false);
    vi.mocked(DeviceService.pathExists).mockResolvedValue(false);
    vi.mocked(DeviceService.refreshDockerInfo).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the newest Docker status when an earlier refresh resolves later", async () => {
    const initial = deferred<DockerInfo>();
    const refreshed = deferred<DockerInfo>();
    vi.mocked(DeviceService.refreshDockerInfo)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);

    render(
      <MemoryRouter>
        <DockerPage />
      </MemoryRouter>,
    );
    expect(document.querySelector(".docker-workbench")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.refreshDockerInfo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.refreshDockerInfo).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve(dockerInfo("Docker 新版"));
      await refreshed.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Docker 新版")).toBeTruthy();

    await act(async () => {
      initial.resolve(dockerInfo("Docker 旧版"));
      await initial.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("Docker 旧版")).toBeNull();
    expect(screen.getByText("Docker 新版")).toBeTruthy();
  });
});
