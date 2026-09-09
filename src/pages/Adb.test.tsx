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
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
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
});
