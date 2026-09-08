// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { Devices } from "./Devices";
import type { DeviceInfo, ShellResult } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/dialogs", () => ({ askConfirm: vi.fn() }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    refreshDevices: vi.fn(),
    exportLogs: vi.fn(),
    revealInFolder: vi.fn(),
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
const { askConfirm } = await import("../lib/dialogs");
const { copyText } = await import("../lib/clipboard");

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
    vi.mocked(DeviceService.disconnect).mockReset();
    vi.mocked(DeviceService.restart).mockReset();
    vi.mocked(DeviceService.stop).mockReset();
    vi.mocked(DeviceService.exportLogs).mockReset();
    vi.mocked(DeviceService.revealInFolder).mockReset();
    vi.mocked(save).mockReset();
    vi.mocked(askConfirm).mockReset();
    vi.mocked(copyText).mockReset();
    storeState.setSelectedDeviceId.mockReset();
    storeState.setStatusText.mockReset();
    vi.mocked(DeviceService.listDevices).mockResolvedValue([device("one"), device("two")]);
    vi.mocked(DeviceService.connect).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.disconnect).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.restart).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.stop).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.exportLogs).mockResolvedValue("C:\\exports\\batch.csv");
    vi.mocked(DeviceService.revealInFolder).mockResolvedValue(undefined);
    vi.mocked(save).mockResolvedValue("C:\\exports\\batch.csv");
    vi.mocked(askConfirm).mockResolvedValue(true);
    vi.mocked(copyText).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("shows loading feedback on batch action buttons while processing", async () => {
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
    const loadingButtons = screen.getAllByRole("button", { name: "..." });
    expect(loadingButtons).toHaveLength(3);
    expect(loadingButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("批量 ADB 连接");

    await act(async () => {
      first.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await first.promise;
    });

    expect(await screen.findByRole("button", { name: "批量连接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量安装 APK" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量截图" })).toBeTruthy();
  }, 15_000);

  it("retries only failed devices from the last batch", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
      .mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    expect(await screen.findByText(/批量 ADB 连接 · 1\/2 成功/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试失败" }));

    expect(await screen.findByText(/批量 ADB 连接 · 1\/1 成功/)).toBeTruthy();
    expect(DeviceService.connect).toHaveBeenNthCalledWith(1, "one-serial");
    expect(DeviceService.connect).toHaveBeenNthCalledWith(2, "two-serial");
    expect(DeviceService.connect).toHaveBeenNthCalledWith(3, "one-serial");
  }, 15_000);

  it("exports batch results as an escaped UTF-8 CSV file", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({
        success: false,
        stdout: "",
        stderr: 'offline, "retry"\nagain',
        exitCode: 1,
      })
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    expect(await screen.findByText(/批量 ADB 连接 · 1\/2 成功/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        defaultPath: expect.stringMatching(/^redroid-batch-results-\d{4}-\d{2}-\d{2}\.csv$/),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      }),
    );
    expect(DeviceService.exportLogs).toHaveBeenCalledWith(
      "C:\\exports\\batch.csv",
      '\uFEFF设备,设备 ID,结果,说明\r\n设备 one,one,失败,"offline, ""retry""\nagain"\r\n设备 two,two,成功,成功',
    );
    expect(DeviceService.revealInFolder).toHaveBeenCalledWith("C:\\exports\\batch.csv");
  }, 15_000);

  it("copies batch results with a readable text header", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    await screen.findByText(/批量 ADB 连接 · 2\/2 成功/);
    fireEvent.click(screen.getByRole("button", { name: "复制结果" }));

    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(
        "设备\t结果\t说明\n设备 one\t成功\t成功\n设备 two\t成功\t成功",
      ),
    );
  }, 15_000);

  it("disables the refresh button while the device list is loading", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const refresh = deferred<DeviceInfo[]>();
    vi.mocked(DeviceService.listDevices).mockReturnValueOnce(refresh.promise);
    const refreshButton = screen.getByRole("button", { name: "刷新" });

    fireEvent.click(refreshButton);

    await waitFor(() => expect(DeviceService.listDevices).toHaveBeenCalledTimes(2));
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    expect(refreshButton.textContent).toBe("...");

    await act(async () => {
      refresh.resolve([device("one"), device("two")]);
      await refresh.promise;
    });

    await waitFor(() => expect((refreshButton as HTMLButtonElement).disabled).toBe(false));
    expect(refreshButton.textContent).toBe("刷新");
  });

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

  it("does not stop one device when the confirmation is cancelled", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "stop" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("停止设备 设备 one？"));
    expect(DeviceService.stop).not.toHaveBeenCalled();
    expect(storeState.setStatusText).not.toHaveBeenCalledWith("停止 设备 one");
  });

  it("stops one device only after the confirmation is accepted", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "stop" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("停止设备 设备 one？"));
    await waitFor(() => expect(DeviceService.stop).toHaveBeenCalledWith("one"));
  });

  it("does not restart one device when the confirmation is cancelled", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "restart" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("重启设备 设备 one？"));
    expect(DeviceService.restart).not.toHaveBeenCalled();
  });

  it("restarts one device only after the confirmation is accepted", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "restart" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("重启设备 设备 one？"));
    await waitFor(() => expect(DeviceService.restart).toHaveBeenCalledWith("one"));
  });

  it("does not disconnect one device when the confirmation is cancelled", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "disconnect" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("断开设备 设备 one？"));
    expect(DeviceService.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects one device only after the confirmation is accepted", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "disconnect" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("断开设备 设备 one？"));
    await waitFor(() => expect(DeviceService.disconnect).toHaveBeenCalledWith("one-serial"));
  });

  it("locks one device card while waiting for an action confirmation", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(askConfirm).mockReturnValueOnce(confirmation.promise);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "restart" } });

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("重启设备 设备 one？"));
    expect((cardActions[0] as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("操作进行中…")).toBeTruthy();
    expect(DeviceService.restart).not.toHaveBeenCalled();

    await act(async () => {
      confirmation.resolve(false);
      await confirmation.promise;
    });

    await waitFor(() => expect((cardActions[0] as HTMLSelectElement).disabled).toBe(false));
    expect(screen.queryByText("操作进行中…")).toBeNull();
  });

  it("keeps one device card locked until the action finishes", async () => {
    const action = deferred<ShellResult>();
    vi.mocked(DeviceService.restart).mockReturnValueOnce(action.promise);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "restart" } });

    await waitFor(() => expect(DeviceService.restart).toHaveBeenCalledWith("one"));
    expect((cardActions[0] as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("操作进行中…")).toBeTruthy();

    await act(async () => {
      action.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await action.promise;
    });

    await waitFor(() => expect((cardActions[0] as HTMLSelectElement).disabled).toBe(false));
    expect(screen.queryByText("操作进行中…")).toBeNull();
  });

  it("reports a successful single-device serial copy in the status bar", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "copy" } });

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("one-serial"));
    expect(storeState.setStatusText).toHaveBeenCalledWith("已复制 one-serial");
  });

  it("keeps the single-device serial copy failure in the status bar and alert", async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard unavailable"));

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    const cardActions = screen.getAllByRole("combobox").slice(2);
    fireEvent.change(cardActions[0], { target: { value: "copy" } });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("复制失败"));
    expect(storeState.setStatusText).toHaveBeenCalledWith("复制失败");
  });
});
