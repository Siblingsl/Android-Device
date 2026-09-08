// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Devices } from "./Devices";
import type { DeviceInfo, ShellResult } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn(),
    connect: vi.fn(),
    restart: vi.fn(),
    refreshDevices: vi.fn(),
  },
}));
const storeState = vi.hoisted(() => ({
  setSelectedDeviceId: vi.fn(),
  setStatusText: vi.fn(),
  refreshDevices: vi.fn(async () => undefined),
}));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      devices: [],
      settings: { screenshotPath: "" },
      setSelectedDeviceId: storeState.setSelectedDeviceId,
      setStatusText: storeState.setStatusText,
      refreshDevices: storeState.refreshDevices,
    }),
}));

const { DeviceService } = await import("../services/deviceService");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const device = (id: string): DeviceInfo => ({
  id,
  name: `设备 ${id}`,
  serial: `${id}-serial`,
  androidVersion: "13",
  online: false,
  cpu: "2",
  ram: "2g",
  fps: 60,
  adbStatus: "offline",
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

describe("Devices batch controls", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(DeviceService.listDevices).mockReset();
    vi.mocked(DeviceService.connect).mockReset();
    vi.mocked(DeviceService.restart).mockReset();
    storeState.setSelectedDeviceId.mockReset();
    storeState.setStatusText.mockReset();
    vi.mocked(DeviceService.listDevices).mockResolvedValue([device("one"), device("two")]);
    vi.mocked(DeviceService.connect).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.restart).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("stops before the next device and reports the skipped item", async () => {
    const first = deferred<ShellResult>();
    vi.mocked(DeviceService.connect).mockReturnValueOnce(first.promise);
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));
    await screen.findByRole("button", { name: "停止后续" });

    expect(screen.getByRole("status").textContent).toContain("（1/2）设备 one");
    expect(screen.getByRole("status").textContent).toContain("已处理 1/2");
    expect(screen.getAllByRole("button", { name: "ADB 连接" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    const stopButton = screen.getByRole("button", { name: "停止后续" });
    fireEvent.click(stopButton);
    expect(screen.getByRole("button", { name: "正在停止" })).toBeTruthy();

    await act(async () => {
      first.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await first.promise;
    });

    expect(DeviceService.connect).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/未执行/)).toBeTruthy();
    expect(await screen.findByText(/批量 ADB 连接 已停止 · 1\/2 成功/)).toBeTruthy();
  }, 15_000);

  it("keeps processing every device when the batch is not stopped", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    expect(await screen.findByText(/批量 ADB 连接 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/未执行/)).toBeNull();
  }, 15_000);

  it("shows the backend error when restarting one device fails", async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    vi.mocked(DeviceService.restart).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "restart unavailable",
      exitCode: 1,
    });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "restart" } });

    await waitFor(() => expect(DeviceService.restart).toHaveBeenCalledWith("one"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("restart unavailable"));
    expect(storeState.setStatusText).toHaveBeenCalledWith("restart unavailable");
    expect(storeState.setStatusText).not.toHaveBeenCalledWith("就绪");
  });
});
