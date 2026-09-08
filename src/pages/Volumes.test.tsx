// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { VolumesPage } from "./Volumes";
import type { DockerVolume } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    listVolumes: vi.fn(),
  },
}));
vi.mock("../hooks/useToolProbe", () => ({
  probeTool: vi.fn(),
}));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: { setSelectedDeviceId: () => void; setStatusText: () => void; settings: null }) => unknown) =>
    selector({ setSelectedDeviceId: () => {}, setStatusText: () => {}, settings: null }),
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

const volume = (name: string): DockerVolume => ({
  name,
  driver: "local",
  mountpoint: `C:/volumes/${name}`,
  size: "1 GB",
  inUse: false,
  isRdc: true,
});

describe("VolumesPage refresh ordering", () => {
  beforeEach(() => {
    vi.mocked(probeTool).mockResolvedValue({ ok: true, text: "Docker available" });
    vi.mocked(DeviceService.listVolumes).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the newest volume list when an earlier refresh resolves later", async () => {
    const initial = deferred<DockerVolume[]>();
    const refreshed = deferred<DockerVolume[]>();
    vi.mocked(DeviceService.listVolumes)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);

    render(
      <MemoryRouter>
        <VolumesPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.listVolumes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.listVolumes).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve([volume("new-volume")]);
      await refreshed.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("new-volume")).toBeTruthy();

    await act(async () => {
      initial.resolve([volume("old-volume")]);
      await initial.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("old-volume")).toBeNull();
    expect(screen.getByText("new-volume")).toBeTruthy();
  });
});
