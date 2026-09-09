// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AdbPage } from "./Adb";
import type { AdbInfo } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getAdbInfo: vi.fn(),
    getLocalSubnet: vi.fn(),
    adbConnect: vi.fn(),
    adbPair: vi.fn(),
    adbMdnsServices: vi.fn(),
    adbTcpip: vi.fn(),
  },
}));
vi.mock("../lib/dialogs", () => ({
  askConfirm: vi.fn(),
}));
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,qr"),
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
const { askConfirm } = await import("../lib/dialogs");

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
    localStorage.clear();
    vi.mocked(probeTool).mockResolvedValue({ ok: true, text: "available" });
    vi.mocked(DeviceService.getLocalSubnet).mockResolvedValue("192.168.1.0/24");
    vi.mocked(DeviceService.getAdbInfo).mockReset();
    vi.mocked(DeviceService.adbConnect).mockReset();
    vi.mocked(DeviceService.adbPair).mockReset();
    vi.mocked(DeviceService.adbMdnsServices).mockReset();
    vi.mocked(DeviceService.adbMdnsServices).mockResolvedValue([]);
    vi.mocked(DeviceService.adbTcpip).mockReset();
    vi.mocked(DeviceService.adbPair).mockResolvedValue({ success: true, stdout: "Successfully paired", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.adbConnect).mockResolvedValue({ success: true, stdout: "connected to device", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.adbTcpip).mockResolvedValue({ success: true, stdout: "restarting in TCP mode port: 5555", stderr: "", exitCode: 0 });
    vi.mocked(askConfirm).mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("presents wireless debugging as a connected workbench while keeping every workflow surface", () => {
    vi.mocked(DeviceService.getAdbInfo).mockResolvedValueOnce(adbInfo("ADB 1.0"));

    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );

    expect(container.querySelector(".adb-workbench")).toBeTruthy();
    expect(container.querySelector(".adb-health-rail .grid-stats")).toBeTruthy();
    expect(container.querySelector(".adb-connection-workspace .wireless-debug-grid")).toBeTruthy();
    expect(container.querySelector(".adb-discovery-surface .card")).toBeTruthy();
    expect(container.querySelector(".adb-results-surface .grid-2")).toBeTruthy();
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

  it("pairs manually and refreshes the ADB device list", async () => {
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText("配对服务地址"), { target: { value: "192.168.1.20:37145" } });
    fireEvent.change(screen.getByLabelText("配对码 / QR 密钥"), { target: { value: "515109" } });
    fireEvent.click(screen.getByRole("button", { name: "开始配对" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.adbPair).toHaveBeenCalledWith("192.168.1.20:37145", "515109");
  });

  it("generates a QR payload and renders the scannable code", async () => {
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "生成二维码" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByAltText("ADB 无线调试二维码")).toBeTruthy();
    expect(screen.getByText("服务名")).toBeTruthy();
  });

  it("offers image import and camera scanning for phone QR pairing", async () => {
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "选择二维码图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "摄像头扫码" })).toBeTruthy();
  });

  it("imports an Android QR payload and pairs the matching mDNS service", async () => {
    vi.mocked(DeviceService.adbMdnsServices).mockResolvedValue([
      { instanceName: "phone-pair", serviceType: "_adb-tls-pairing._tcp", address: "192.168.1.20:37145" },
      { instanceName: "phone-pair", serviceType: "_adb-tls-connect._tcp", address: "192.168.1.20:41123" },
    ]);
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText("导入 QR 内容"), {
      target: { value: "WIFI:T:ADB;S:phone-pair;P:515109;;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入 QR 并配对" }));
    await waitFor(() => expect(DeviceService.adbPair).toHaveBeenCalledWith("192.168.1.20:37145", "515109"));
    expect(screen.getByLabelText("配对码 / QR 密钥")).toHaveProperty("value", "515109");
    expect(screen.getByLabelText("配对服务地址")).toHaveProperty("value", "192.168.1.20:37145");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")[0].address).toBe("192.168.1.20:41123"));
  });

  it("connects discovered mDNS services and saves the address", async () => {
    vi.mocked(DeviceService.adbMdnsServices).mockResolvedValue([
      { instanceName: "adb-device", serviceType: "_adb-tls-connect._tcp", address: "192.168.1.20:41123" },
    ]);
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "连接此服务" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.adbConnect).toHaveBeenCalledWith("192.168.1.20:41123");
    expect(screen.getByText("192.168.1.20:41123")).toBeTruthy();
  });

  it("uses the saved concurrency and retries only failed wireless addresses", async () => {
    const failedAddress = "192.168.1.20:5555";
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: failedAddress, label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    const attempts = new Map<string, number>();
    vi.mocked(DeviceService.adbConnect).mockImplementation(async (target) => {
      const attempt = (attempts.get(target) || 0) + 1;
      attempts.set(target, attempt);
      if (target === failedAddress && attempt === 1) {
        return { success: false, stdout: "", stderr: "timeout", exitCode: 1 };
      }
      return { success: true, stdout: "connected", stderr: "", exitCode: 0 };
    });

    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "重连并发数" }), { target: { value: "2" } });
    expect(localStorage.getItem("rdc.adb.savedWirelessConcurrency")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "批量重连" }));
    await waitFor(() => expect(screen.getByText((content) => content.includes("timeout"))).toBeTruthy());
    expect(screen.getByRole("button", { name: "重试失败" })).toBeTruthy();

    const callsBeforeRetry = vi.mocked(DeviceService.adbConnect).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试失败" }));
    await waitFor(() => expect(attempts.get(failedAddress)).toBe(2));
    expect(vi.mocked(DeviceService.adbConnect).mock.calls.length).toBe(callsBeforeRetry + 1);
    const calls = vi.mocked(DeviceService.adbConnect).mock.calls;
    expect(calls[calls.length - 1]).toEqual([failedAddress]);
  });

  it("shows live address status and edits only the selected saved label", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    vi.mocked(DeviceService.getAdbInfo).mockResolvedValue({
      version: "ADB",
      serverRunning: true,
      devices: [{ serial: "192.168.1.20:5555", state: "device", product: "", model: "", device: "", transportId: "" }],
    });
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("在线")).toBeTruthy());
    expect(screen.getByText("离线")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "编辑备注 Phone A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "设备备注" }), { target: { value: "主手机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    const saved = JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]");
    expect(saved).toEqual([
      { address: "192.168.1.20:5555", label: "主手机", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]);
  });

  it("supports select-all and reconnects only the selected set", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "全选" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选择 2 项")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(screen.queryByText("已选择 2 项")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Phone A" }));
    fireEvent.click(screen.getByRole("button", { name: "批量连接" }));
    await waitFor(() => expect(DeviceService.adbConnect).toHaveBeenCalledTimes(1));
    expect(DeviceService.adbConnect).toHaveBeenCalledWith("192.168.1.20:5555");
    expect(DeviceService.adbConnect).not.toHaveBeenCalledWith("192.168.1.21:5555");
  });

  it("deletes only the selected saved addresses after confirmation", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "选择 Phone A" })).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Phone A" }));
    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));
    await waitFor(() => expect(screen.queryByText("Phone A")).toBeNull());
    expect(screen.getByText("Phone B")).toBeTruthy();
    expect(askConfirm).toHaveBeenCalled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")).toEqual([
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
  });

  it("reorders saved addresses with keyboard controls and persists manual order", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("combobox", { name: "无线地址排序" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "下移 Phone A" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]").map((entry: { label: string }) => entry.label)).toEqual([
      "Phone B",
      "Phone A",
    ]));
    const labels = [...container.querySelectorAll(".wireless-saved-label span")].map((node) => node.textContent);
    expect(labels).toEqual(["Phone B", "Phone A"]);
  });

  it("exposes drag handles and disables manual dragging in recent mode", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "2026-09-01T00:00:00.000Z" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "2026-09-02T00:00:00.000Z" },
    ]));
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Phone A")).toBeTruthy());
    const handles = screen.getAllByRole("button", { name: "拖拽调整顺序" });
    expect(handles).toHaveLength(2);
    expect(handles[0].getAttribute("draggable")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: "无线地址排序" }), { target: { value: "recent" } });
    expect((handles[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows saved addresses by most recent connection when selected", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "2026-09-01T00:00:00.000Z" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "2026-09-02T00:00:00.000Z" },
    ]));
    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("combobox", { name: "无线地址排序" })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "无线地址排序" }), { target: { value: "recent" } });
    const labels = [...container.querySelectorAll(".wireless-saved-label span")].map((node) => node.textContent);
    expect(labels).toEqual(["Phone B", "Phone A"]);
  });

  it("keeps legacy saved addresses compatible and toggles favorites", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "" },
      { address: "192.168.1.21:5555", label: "Phone B", lastConnectedAt: "" },
    ]));
    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "收藏 Phone A" })).toBeTruthy());
    expect(container.querySelectorAll(".wireless-saved-group-input")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "收藏 Phone A" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")[0]).toMatchObject({
      address: "192.168.1.20:5555",
      favorite: true,
    }));
    fireEvent.click(screen.getByRole("button", { name: "仅看收藏" }));
    expect(screen.getByText("Phone A")).toBeTruthy();
    expect(screen.queryByText("Phone B")).toBeNull();
  });

  it("filters saved addresses by search and live status", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "主手机", lastConnectedAt: "", favorite: true, group: "工作" },
      { address: "192.168.1.21:5555", label: "测试机", lastConnectedAt: "", favorite: false, group: "测试" },
    ]));
    vi.mocked(DeviceService.getAdbInfo).mockResolvedValue({
      version: "ADB",
      serverRunning: true,
      devices: [{ serial: "192.168.1.20:5555", state: "device", product: "", model: "", device: "", transportId: "" }],
    });
    render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("在线")).toBeTruthy());
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索保存地址" }), { target: { value: "测试" } });
    expect(screen.getByText("测试机")).toBeTruthy();
    expect(screen.queryByText("主手机")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索保存地址" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "仅看在线" }));
    expect(screen.getByText("主手机")).toBeTruthy();
    expect(screen.queryByText("测试机")).toBeNull();
  });

  it("edits a saved address group and persists the group label", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "", group: "工作" },
    ]));
    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector(".wireless-saved-group-input")).toBeTruthy());
    const groupInput = container.querySelector(".wireless-saved-group-input") as HTMLInputElement;
    fireEvent.change(groupInput, { target: { value: "测试" } });
    fireEvent.keyDown(groupInput, { key: "Enter" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")[0].group).toBe("测试"));
    expect(screen.getByText("测试")).toBeTruthy();
  });

  it("preserves favorite and group metadata after reconnecting", async () => {
    localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify([
      { address: "192.168.1.20:5555", label: "Phone A", lastConnectedAt: "", favorite: true, group: "工作" },
    ]));
    const { container } = render(
      <MemoryRouter>
        <AdbPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector(".wireless-saved-row .btn")).toBeTruthy());
    const reconnectButton = [...container.querySelectorAll(".wireless-saved-row .btn")]
      .find((button) => button.textContent?.trim() === "连接");
    expect(reconnectButton).toBeTruthy();
    fireEvent.click(reconnectButton!);
    await waitFor(() => expect(DeviceService.adbConnect).toHaveBeenCalledWith("192.168.1.20:5555"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")[0].lastConnectedAt).not.toBe(""));
    expect(JSON.parse(localStorage.getItem("rdc.adb.savedWirelessAddresses") || "[]")[0]).toMatchObject({
      favorite: true,
      group: "工作",
    });
  });
});
