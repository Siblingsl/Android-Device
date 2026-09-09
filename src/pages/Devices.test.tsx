// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
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
    scrcpyStart: vi.fn(),
    scrcpyStartLayout: vi.fn(),
    text: vi.fn(),
    keyevent: vi.fn(),
    installApk: vi.fn(),
    uploadFile: vi.fn(),
    refreshDevices: vi.fn(),
    exportLogs: vi.fn(),
    revealInFolder: vi.fn(),
    getDevice: vi.fn(),
    screenshot: vi.fn(),
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

const historyEntry = (id: string, title: string, createdAt = Date.now()) => ({
  id,
  title,
  kind: "connect",
  createdAt,
  items: [{ id: `device-${id}`, name: `设备 ${id}`, ok: true, detail: "成功" }],
});

describe("Devices batch controls", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.mocked(DeviceService.listDevices).mockReset();
    vi.mocked(DeviceService.connect).mockReset();
    vi.mocked(DeviceService.disconnect).mockReset();
    vi.mocked(DeviceService.restart).mockReset();
    vi.mocked(DeviceService.stop).mockReset();
    vi.mocked(DeviceService.scrcpyStart).mockReset();
    vi.mocked(DeviceService.scrcpyStartLayout).mockReset();
    vi.mocked(DeviceService.text).mockReset();
    vi.mocked(DeviceService.keyevent).mockReset();
    vi.mocked(DeviceService.installApk).mockReset();
    vi.mocked(DeviceService.uploadFile).mockReset();
    vi.mocked(open).mockReset();
    vi.mocked(DeviceService.exportLogs).mockReset();
    vi.mocked(DeviceService.revealInFolder).mockReset();
    vi.mocked(DeviceService.getDevice).mockReset();
    vi.mocked(DeviceService.screenshot).mockReset();
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
    vi.mocked(DeviceService.scrcpyStart).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.scrcpyStartLayout).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.text).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.keyevent).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.installApk).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.uploadFile).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(DeviceService.exportLogs).mockResolvedValue("C:\\exports\\batch.csv");
    vi.mocked(DeviceService.revealInFolder).mockResolvedValue(undefined);
    vi.mocked(DeviceService.getDevice).mockResolvedValue(null);
    vi.mocked(DeviceService.screenshot).mockResolvedValue({ success: false, path: "", base64: "", error: "" });
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
    expect(await screen.findByText("未执行（用户停止）")).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 two 失败 未执行（用户停止） 用户停止/ })).toBeTruthy();
    expect(await screen.findByText(/批量 ADB 连接 已停止 · 1\/2 成功/)).toBeTruthy();
  }, 15_000);

  it("organizes the device toolbar into view, batch, and advanced groups", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const search = await screen.findByPlaceholderText("搜索名称 / Serial / 镜像");
    expect(search.closest(".devices-toolbar-view")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量连接" }).closest(".devices-toolbar-batch")).toBeTruthy();
    expect(screen.getByText("窗口布局").closest(".devices-toolbar-advanced")).toBeTruthy();
    expect(screen.getByRole("button", { name: "广播文本" }).closest(".devices-toolbar-batch")).toBeTruthy();
  }, 15_000);

  it("prioritizes batch actions into primary, supporting, and utility groups", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const batchToolbar = await screen.findByRole("button", { name: "批量投屏" });
    expect(batchToolbar.closest(".devices-toolbar-batch-primary")).toBeTruthy();
    expect(batchToolbar.classList.contains("primary")).toBe(true);
    expect(screen.getByRole("button", { name: "批量连接" }).closest(".devices-toolbar-batch-primary")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量推送" }).closest(".devices-toolbar-batch-supporting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量安装 APK" }).closest(".devices-toolbar-batch-supporting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批量截图" }).closest(".devices-toolbar-batch-utility")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制已选 Serial" }).closest(".devices-toolbar-batch-utility")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "更多操作" }).closest(".devices-toolbar-batch-utility")).toBeTruthy();
  }, 15_000);

  it("shows devices in a compact table with row-level actions by default", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "设备" })).toBeTruthy();
    const onlineRow = screen.getByRole("row", { name: /设备 one/ });
    expect(within(onlineRow).getByRole("button", { name: "投屏" })).toBeTruthy();
    expect(within(onlineRow).getByRole("button", { name: "详情" })).toBeTruthy();
    expect(within(onlineRow).getByRole("combobox")).toBeTruthy();
  }, 15_000);

  it("separates primary identity from supporting device details without dropping table data", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device", dataVolume: "data-one" },
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const row = await screen.findByRole("row", { name: /设备 one/ });
    expect(within(row).getByText("设备 one").parentElement?.classList.contains("devices-table-primary")).toBe(true);
    expect(within(row).getByText(/one-serial/).parentElement?.classList.contains("devices-table-secondary")).toBe(true);
    expect(within(row).getByText("Android 13 · 2 CPU · 2g RAM")).toBeTruthy();
    expect(within(row).getByText(/data-one/)).toBeTruthy();
    expect(row.querySelector('[data-service="scrcpy"]')?.textContent).toContain("scrcpy");
    expect(row.querySelector('[data-service="scrcpy"]')?.textContent).toContain("stopped");
    expect(within(row).getByText("1080x1920")).toBeTruthy();
  }, 15_000);

  it("groups status, services, and runtime details while preserving their values", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      {
        ...device("one"),
        online: true,
        adbStatus: "device",
        scrcpyStatus: "running",
        dockerStatus: "running",
        ip: "192.168.1.20",
        uptime: "18m",
      },
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const row = await screen.findByRole("row", { name: /设备 one/ });
    expect(row.querySelector('[data-device-status="online"]')).toBeTruthy();
    expect(row.querySelector('[data-service="scrcpy"] .devices-table-service-name')?.textContent).toBe("scrcpy");
    expect(row.querySelector('[data-service="docker"] .devices-table-service-name')?.textContent).toBe("Docker");
    expect(row.querySelector(".devices-table-runtime-main")?.textContent).toBe("192.168.1.20");
    expect(row.querySelector(".devices-table-runtime-secondary")?.textContent).toContain("1080x1920");
    expect(row.querySelector(".devices-table-runtime-secondary")?.textContent).toContain("18m");
  }, 15_000);

  it("keeps the table shell responsive and repositions the hover card near viewport edges", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("devices-table-hover-anchor")) {
        return {
          top: 560,
          bottom: 590,
          left: 760,
          right: 980,
          width: 220,
          height: 30,
          x: 760,
          y: 560,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const tableShell = await screen.findByRole("table");
    expect(tableShell.parentElement?.classList.contains("devices-table-responsive")).toBe(true);

    const onlineRow = screen.getByRole("row", { name: /设备 one/ });
    fireEvent.focus(within(onlineRow).getByRole("button", { name: "设备 one" }));

    const anchor = within(onlineRow).getByRole("button", { name: "设备 one" }).closest(".devices-table-hover-anchor");
    expect(anchor?.getAttribute("data-hover-placement")).toBe("top-right");
  }, 15_000);

  it("shows telemetry and a screenshot when focusing a table device", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);
    vi.mocked(DeviceService.getDevice).mockResolvedValue({
      ...device("one"),
      online: true,
      adbStatus: "device",
      batteryLevel: 84,
      batteryCharging: true,
      batteryTemperatureC: 32.4,
      batteryVoltageV: 4.18,
      batteryPowerSource: "USB",
    });
    vi.mocked(DeviceService.screenshot).mockResolvedValue({
      success: true,
      path: "device-one.png",
      base64: "c2NyZWVu",
    });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const onlineRow = await screen.findByRole("row", { name: /设备 one/ });
    fireEvent.focus(within(onlineRow).getByRole("button", { name: "设备 one" }));

    expect(await screen.findByRole("tooltip")).toBeTruthy();
    expect(await screen.findByText("84% · 充电中")).toBeTruthy();
    expect(screen.getByText("32.4 °C · 4.18 V")).toBeTruthy();
    expect(screen.getByText("USB")).toBeTruthy();
    expect(screen.getByRole("img", { name: "设备悬浮截图" })).toBeTruthy();
    expect(DeviceService.getDevice).toHaveBeenCalledWith("one");
    expect(DeviceService.screenshot).toHaveBeenCalledWith("one-serial");
  }, 15_000);

  it("edits and persists a device note inline", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    const row = await screen.findByRole("row", { name: /设备 one/ });
    fireEvent.click(within(row).getByRole("button", { name: "编辑备注 设备 one" }));
    const input = screen.getByRole("textbox", { name: "设备备注 设备 one" });
    fireEvent.change(input, { target: { value: "测试机房" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));

    expect(await screen.findByText("测试机房")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("rdc.devices.notes") ?? "{}")).toEqual({ one: "测试机房" });
  }, 15_000);

  it("shows and manages historical offline devices", async () => {
    localStorage.setItem(
      "rdc.devices.offlineHistory",
      JSON.stringify([
        {
          device: { ...device("ghost"), name: "已离线设备" },
          lastSeenAt: Date.now() - 60 * 60 * 1000,
        },
      ]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "离线记录 1" }));
    expect(screen.getByText("已离线设备")).toBeTruthy();
    expect(screen.getByText(/最后出现/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "移除记录 已离线设备" }));
    expect(screen.queryByText("已离线设备")).toBeNull();
    const storedHistory = JSON.parse(localStorage.getItem("rdc.devices.offlineHistory") ?? "[]") as Array<{ device?: { id?: string } }>;
    expect(storedHistory.some((entry) => entry.device?.id === "ghost")).toBe(false);
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
    expect(loadingButtons).toHaveLength(6);
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

  it("starts an independent scrcpy window for every selected online device", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      { ...device("two"), online: true, adbStatus: "device" },
    ]);
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量投屏" }));

    expect(await screen.findByText(/批量投屏 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.scrcpyStart).toHaveBeenNthCalledWith(1, "one-serial");
    expect(DeviceService.scrcpyStart).toHaveBeenNthCalledWith(2, "two-serial");
  }, 15_000);

  it("arranges selected scrcpy windows using the saved grid layout", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      { ...device("two"), online: true, adbStatus: "device" },
    ]);
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByText("窗口布局"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "列数" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "按布局投屏" }));

    expect(await screen.findByText(/按布局投屏 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.scrcpyStartLayout).toHaveBeenNthCalledWith(
      1,
      "one-serial",
      { x: 0, y: 0, width: 480, height: 800 },
    );
    expect(DeviceService.scrcpyStartLayout).toHaveBeenNthCalledWith(
      2,
      "two-serial",
      { x: 0, y: 816, width: 480, height: 800 },
    );
    expect(localStorage.getItem("rdc.devices.scrcpyLayout")).toContain('"columns":1');
  }, 15_000);

  it("broadcasts the same text and navigation key to selected devices", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      { ...device("two"), online: true, adbStatus: "device" },
    ]);
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByText("广播输入"));
    fireEvent.change(screen.getByRole("textbox", { name: "广播文本" }), {
      target: { value: "shared text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "广播文本" }));

    expect(await screen.findByText(/广播文本 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.text).toHaveBeenNthCalledWith(1, "one-serial", "shared text");
    expect(DeviceService.text).toHaveBeenNthCalledWith(2, "two-serial", "shared text");

    fireEvent.click(screen.getByRole("button", { name: "广播 HOME" }));
    expect(await screen.findByText(/广播按键 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.keyevent).toHaveBeenNthCalledWith(1, "one-serial", 3);
    expect(DeviceService.keyevent).toHaveBeenNthCalledWith(2, "two-serial", 3);
  }, 15_000);

  it("pushes multiple selected files to every selected device", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      { ...device("two"), online: true, adbStatus: "device" },
    ]);
    vi.mocked(open).mockResolvedValue(["C:\\payload\\one.txt", "C:\\payload\\two.txt"]);
    vi.stubGlobal("prompt", vi.fn(() => "/sdcard/Download"));
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量推送" }));

    expect(await screen.findByText(/批量推送 2 个文件 · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.uploadFile).toHaveBeenCalledTimes(4);
    expect(DeviceService.uploadFile).toHaveBeenCalledWith(
      "one-serial",
      "C:\\payload\\one.txt",
      "/sdcard/Download/one.txt",
    );
    expect(DeviceService.uploadFile).toHaveBeenCalledWith(
      "two-serial",
      "C:\\payload\\two.txt",
      "/sdcard/Download/two.txt",
    );
  }, 15_000);

  it("installs every selected APK on every selected device", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      { ...device("two"), online: true, adbStatus: "device" },
    ]);
    vi.mocked(open).mockResolvedValue(["C:\\apk\\one.apk", "C:\\apk\\two.apk"]);
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量安装 APK" }));

    expect(await screen.findByText(/批量安装 2 个 APK · 2\/2 成功/)).toBeTruthy();
    expect(DeviceService.installApk).toHaveBeenCalledTimes(4);
    expect(DeviceService.installApk).toHaveBeenCalledWith("one-serial", "C:\\apk\\one.apk", true);
    expect(DeviceService.installApk).toHaveBeenCalledWith("two-serial", "C:\\apk\\two.apk", true);
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

  it("shows a complete batch summary that is independent from the visible filter", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
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

    await screen.findByText(/批量 ADB 连接 · 1\/2 成功/);
    expect(screen.getByText("共 2 条 · 成功 1 · 失败 1")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "结果筛选" }), {
      target: { value: "failed" },
    });

    expect(screen.getByText("共 2 条 · 成功 1 · 失败 1")).toBeTruthy();
  }, 15_000);

  it("copies only failed batch results", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
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

    await screen.findByText(/批量 ADB 连接 · 1\/2 成功/);
    fireEvent.click(screen.getByRole("button", { name: "复制失败项" }));

    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith("设备\t结果\t说明\n设备 one\t失败\toffline"),
    );
  }, 15_000);

  it("exports only failed batch results as a separate CSV file", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
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

    await screen.findByText(/批量 ADB 连接 · 1\/2 成功/);
    fireEvent.click(screen.getByRole("button", { name: "导出失败项" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        defaultPath: expect.stringMatching(/^redroid-batch-failed-\d{4}-\d{2}-\d{2}\.csv$/),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      }),
    );
    expect(DeviceService.exportLogs).toHaveBeenCalledWith(
      "C:\\exports\\batch.csv",
      '\uFEFF设备,设备 ID,结果,说明\r\n设备 one,one,失败,offline',
    );
    expect(DeviceService.revealInFolder).toHaveBeenCalledWith("C:\\exports\\batch.csv");
  }, 15_000);

  it("hides failed-only result actions when every device succeeds", async () => {
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
    expect(screen.queryByRole("button", { name: "复制失败项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导出失败项" })).toBeNull();
  }, 15_000);

  it("filters visible batch rows without changing the complete report actions", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
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

    await screen.findByText(/批量 ADB 连接 · 1\/2 成功/);
    fireEvent.change(screen.getByRole("combobox", { name: "结果筛选" }), {
      target: { value: "failed" },
    });

    expect(screen.getByText("当前显示 1/2 条")).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 one 失败 offline/ })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /设备 two 成功/ })).toBeNull();
    expect(screen.getByRole("button", { name: "重试失败" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeTruthy();
  }, 15_000);

  it("classifies failed batch results with actionable reason labels", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      device("one"),
      device("two"),
      device("three"),
    ]);
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device offline", exitCode: 1 })
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device unauthorized", exitCode: 1 })
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "command timed out", exitCode: 1 });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    checkboxes.forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    await screen.findByText(/批量 ADB 连接 · 0\/3 成功/);
    expect(screen.getByRole("combobox", { name: "失败原因" })).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 one 失败 device offline 设备离线\/未就绪/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 two 失败 device unauthorized 未授权/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 three 失败 command timed out 超时/ })).toBeTruthy();
  }, 15_000);

  it("combines failure reason and result filters without changing retry scope", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device offline", exitCode: 1 })
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device unauthorized", exitCode: 1 });

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    checkboxes.forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    await screen.findByText(/批量 ADB 连接 · 0\/2 成功/);
    fireEvent.change(screen.getByRole("combobox", { name: "失败原因" }), {
      target: { value: "offline" },
    });

    expect(screen.getByText("当前显示 1/2 条")).toBeTruthy();
    expect(screen.getByRole("row", { name: /设备 one 失败 device offline/ })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /设备 two 失败 device unauthorized/ })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "结果筛选" }), {
      target: { value: "success" },
    });
    expect(screen.getByText("当前筛选下没有结果")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试失败" })).toBeTruthy();
  }, 15_000);

  it("derives failure reasons when opening legacy historical results", async () => {
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([
        {
          id: "legacy-failure",
          title: "历史失败结果",
          kind: "connect",
          createdAt: Date.now(),
          items: [{ id: "device-legacy", name: "历史设备", ok: false, detail: "device unauthorized" }],
        },
      ]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    fireEvent.click(screen.getByRole("button", { name: "查看" }));

    expect(await screen.findByRole("combobox", { name: "失败原因" })).toBeTruthy();
    expect(screen.getByRole("row", { name: /历史设备 失败 device unauthorized 未授权/ })).toBeTruthy();
  });

  it("shows actionable guidance for every failure reason", async () => {
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([
        {
          id: "reason-guidance",
          title: "失败原因建议",
          kind: "connect",
          createdAt: Date.now(),
          items: [
            { id: "offline", name: "离线设备", ok: false, detail: "device offline" },
            { id: "unauthorized", name: "未授权设备", ok: false, detail: "device unauthorized" },
            { id: "timeout", name: "超时设备", ok: false, detail: "command timed out" },
            { id: "skipped", name: "停止设备", ok: false, detail: "未执行（用户停止）" },
            { id: "other", name: "其他设备", ok: false, detail: "unexpected command error" },
          ],
        },
      ]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    fireEvent.click(screen.getByRole("button", { name: "查看" }));

    expect(await screen.findByText(/建议检查设备状态和 ADB 端口映射后重试/)).toBeTruthy();
    expect(screen.getByText(/建议在设备上确认 ADB 授权后重试/)).toBeTruthy();
    expect(screen.getByText(/建议检查设备响应，稍后重试/)).toBeTruthy();
    expect(screen.getByText(/本项未执行，请确认目标后重新执行/)).toBeTruthy();
    expect(screen.getByText(/建议查看说明详情后重试/)).toBeTruthy();
  });

  it("retries only failed devices matching the selected reason", async () => {
    const retry = deferred<ShellResult>();
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device offline", exitCode: 1 })
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "device unauthorized", exitCode: 1 })
      .mockReturnValueOnce(retry.promise);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    checkboxes.forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));

    await screen.findByText(/批量 ADB 连接 · 0\/2 成功/);
    fireEvent.change(screen.getByRole("combobox", { name: "失败原因" }), {
      target: { value: "offline" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重试此原因" }));

    await screen.findByRole("button", { name: "停止后续" });
    expect(screen.getByRole("status").textContent).toContain("（1/1）设备 one");
    await act(async () => {
      retry.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await retry.promise;
    });

    expect(await screen.findByText(/批量 ADB 连接 · 1\/1 成功/)).toBeTruthy();
    expect(DeviceService.connect).toHaveBeenCalledTimes(3);
    expect(DeviceService.connect).toHaveBeenNthCalledWith(3, "one-serial");
  }, 15_000);

  it("selects and deselects visible online devices without clearing other picks", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "全选在线" }));

    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "取消在线" }));

    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
  }, 15_000);

  it("keeps selected devices checked after switching status filters", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    let checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    const deviceFilter = screen.getAllByRole("combobox")[0];
    fireEvent.change(deviceFilter, { target: { value: "offline" } });
    expect(await screen.findAllByRole("checkbox")).toHaveLength(1);

    fireEvent.change(deviceFilter, { target: { value: "all" } });
    checkboxes = await screen.findAllByRole("checkbox");
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  }, 15_000);

  it("shows the current actionable count and disables batch actions for hidden picks", async () => {
    vi.mocked(DeviceService.listDevices).mockResolvedValue([
      { ...device("one"), online: true, adbStatus: "device" },
      device("two"),
    ]);

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "offline" } });

    expect(screen.getByText("已选 1")).toBeTruthy();
    expect(screen.getByText("当前可操作 0")).toBeTruthy();
    expect((screen.getByRole("button", { name: "批量连接" }) as HTMLButtonElement).disabled).toBe(true);
  }, 15_000);

  it("persists completed batch results and restores them without retry controls", async () => {
    vi.mocked(DeviceService.connect)
      .mockResolvedValueOnce({ success: false, stdout: "", stderr: "offline", exitCode: 1 })
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    const firstRender = render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));
    await screen.findByText(/批量 ADB 连接 · 1\/2 成功/);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    const stored = JSON.parse(localStorage.getItem("rdc.devices.batchHistory") ?? "[]") as unknown[];
    expect(stored).toHaveLength(1);

    firstRender.unmount();
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    expect(screen.getByText(/批量 ADB 连接 · 1\/2 成功/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));

    expect(await screen.findByRole("row", { name: /设备 one 失败 offline/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试失败" })).toBeNull();
  }, 15_000);

  it("loads at most ten valid historical batch results", async () => {
    const valid = Array.from({ length: 11 }, (_, index) => ({
      id: `history-${index}`,
      title: `历史结果 ${index}`,
      kind: "connect",
      createdAt: Date.now() - index,
      items: [{ id: `device-${index}`, name: `设备 ${index}`, ok: true, detail: "成功" }],
    }));
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([{ id: "broken", title: "损坏记录", kind: "connect", createdAt: "bad", items: [] }, ...valid]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));

    expect(screen.getAllByRole("button", { name: "查看" })).toHaveLength(10);
    expect(screen.queryByText("损坏记录")).toBeNull();
  });

  it("deletes one historical result after confirmation", async () => {
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([historyEntry("latest", "最新结果"), historyEntry("older", "较早结果")]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);

    await waitFor(() => {
      expect(askConfirm).toHaveBeenCalledWith("删除批量历史“最新结果”？");
      expect(JSON.parse(localStorage.getItem("rdc.devices.batchHistory") ?? "[]")).toHaveLength(1);
    });
    expect(screen.queryByText("最新结果")).toBeNull();
    expect(screen.getByText("较早结果")).toBeTruthy();
  });

  it("keeps all historical results when clearing is cancelled", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([historyEntry("one", "结果一"), historyEntry("two", "结果二")]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    fireEvent.click(screen.getByRole("button", { name: "清空历史" }));

    await waitFor(() => expect(askConfirm).toHaveBeenCalledWith("确定清空全部批量历史记录吗？"));
    expect(JSON.parse(localStorage.getItem("rdc.devices.batchHistory") ?? "[]")).toHaveLength(2);
    expect(screen.getByText("结果一")).toBeTruthy();
    expect(screen.getByText("结果二")).toBeTruthy();
  });

  it("clears historical results after confirmation and closes the history panel", async () => {
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([historyEntry("one", "结果一"), historyEntry("two", "结果二")]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));
    fireEvent.click(screen.getByRole("button", { name: "清空历史" }));

    await waitFor(() => expect(localStorage.getItem("rdc.devices.batchHistory")).toBe("[]"));
    expect(screen.queryByText("结果一")).toBeNull();
    expect(screen.queryByText("结果二")).toBeNull();
    expect(screen.queryByRole("button", { name: "批量历史" })).toBeNull();
  });

  it("removes historical results older than thirty days when loading", async () => {
    const now = Date.now();
    localStorage.setItem(
      "rdc.devices.batchHistory",
      JSON.stringify([
        historyEntry("old", "过期结果", now - 31 * 24 * 60 * 60 * 1000),
        historyEntry("recent", "最近结果", now - 24 * 60 * 60 * 1000),
      ]),
    );

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "批量历史" }));

    expect(screen.getAllByRole("button", { name: "查看" })).toHaveLength(1);
    expect(screen.getByText("最近结果")).toBeTruthy();
    expect(screen.queryByText("过期结果")).toBeNull();
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("rdc.devices.batchHistory") ?? "[]")).toHaveLength(1),
    );
  });

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

  it("keeps table quick actions compact while retaining accessible labels", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const row = await screen.findByRole("row", { name: /设备 one/ });
    expect(within(row).getByRole("cell", { name: /投屏 ADB 连接 详情 更多/ }).querySelector(".devices-table-actions-compact")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "投屏" }).classList.contains("device-row-action")).toBe(true);
    expect(within(row).getByRole("button", { name: "ADB 连接" }).classList.contains("device-row-action")).toBe(true);
    expect(within(row).getByRole("button", { name: "详情" }).classList.contains("device-row-action")).toBe(true);
    expect(within(row).getByRole("combobox", { name: "行内操作" }).classList.contains("device-row-action-more")).toBe(true);
  });

  it("keeps identity flexible while marking supporting columns for responsive sizing", async () => {
    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    const row = await screen.findByRole("row", { name: /设备 one/ });
    const table = row.closest("table");
    expect(table?.querySelector(".devices-table-identity-head")).toBeTruthy();
    expect(table?.querySelector(".devices-table-status-head")).toBeTruthy();
    expect(table?.querySelector(".devices-table-services-head")).toBeTruthy();
    expect(table?.querySelector(".devices-table-runtime-head")).toBeTruthy();
    expect(row.querySelector(".devices-table-identity-cell")).toBeTruthy();
    expect(row.querySelector(".devices-table-status-cell")).toBeTruthy();
    expect(row.querySelector(".devices-table-services-cell")).toBeTruthy();
    expect(row.querySelector(".devices-table-runtime-cell")).toBeTruthy();
    expect(row.querySelector(".devices-table-action-cell")).toBeTruthy();
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
