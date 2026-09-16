// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    nextFreeAdbPort: vi.fn(),
    pathExists: vi.fn(),
    listSpoofProfiles: vi.fn(),
    spoofProfileUsage: vi.fn(),
    createInstance: vi.fn(),
    getCreateStage: vi.fn(),
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
    // The panel also publishes a read-only source snapshot for the merged
    // page's badges (P5); this standalone page test stubs the whole store.
    setDockerSource: () => void;
    settings: null;
    saveSettings: () => Promise<void>;
  }) => unknown) =>
    selector({
      setSelectedDeviceId: () => {},
      setStatusText: () => {},
      setDockerSource: () => {},
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

const spoofProfilesFixture = [
  {
    id: "redmi-k40-alioth",
    brand: "Xiaomi",
    manufacturer: "Xiaomi",
    model: "2210132C",
    marketName: "Redmi K40",
    androidVersion: "13",
    securityPatch: "2023-11-01",
    fingerprint: "Xiaomi/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys",
    notes: "默认档案，字段来自真机实测（Redmi K40 / alioth，Android 13）。",
  },
  {
    id: "xiaomi-13",
    brand: "Xiaomi",
    manufacturer: "Xiaomi",
    model: "2211133C",
    marketName: "Xiaomi 13",
    androidVersion: "13",
    securityPatch: "2023-12-01",
    fingerprint: "Xiaomi/fuxi/fuxi:13/TKQ1.220905.001/V14.0.30.0.TMCCNXM:user/release-keys",
    notes: "指纹为合理构造，强对抗场景请自行核对真机。",
  },
  {
    id: "samsung-galaxy-s23",
    brand: "samsung",
    manufacturer: "samsung",
    model: "SM-S9110",
    marketName: "Galaxy S23",
    androidVersion: "14",
    securityPatch: "2023-12-01",
    fingerprint: "samsung/dm1qzc/dm1qzc:14/UP1A.231005.007/S9110ZCU1BWL1:user/release-keys",
    notes: "指纹参考公开渠道（Galaxy S23 / SM-S9110）；强对抗场景请自行核对真机。",
  },
];

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
    vi.mocked(DeviceService.nextFreeAdbPort).mockResolvedValue(5555);
    vi.mocked(DeviceService.pathExists).mockResolvedValue(false);
    vi.mocked(DeviceService.listSpoofProfiles).mockResolvedValue(spoofProfilesFixture);
    vi.mocked(DeviceService.spoofProfileUsage).mockResolvedValue([]);
    vi.mocked(DeviceService.createInstance).mockResolvedValue({
      success: true,
      stdout: "container created",
      stderr: "",
      exitCode: 0,
    });
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

describe("DockerPage spoof create form", () => {
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
    vi.mocked(DeviceService.nextFreeAdbPort).mockResolvedValue(5555);
    vi.mocked(DeviceService.pathExists).mockResolvedValue(false);
    vi.mocked(DeviceService.listSpoofProfiles).mockResolvedValue(spoofProfilesFixture);
    vi.mocked(DeviceService.refreshDockerInfo).mockResolvedValue(dockerInfo("Docker"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function renderForm() {
    render(
      <MemoryRouter>
        <DockerPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "创建实例" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /预装 Magisk/ }));
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("renders the spoof profile picker with the default profile preview", async () => {
    await renderForm();
    expect(screen.getByLabelText("品牌")).toBeTruthy();
    expect(screen.getByLabelText("型号（该品牌下档案）")).toBeTruthy();
    expect(screen.getByText("Redmi K40")).toBeTruthy();
  });

  it("links model options to the selected brand", async () => {
    await renderForm();
    const brandSelect = screen.getByLabelText("品牌") as HTMLSelectElement;
    fireEvent.change(brandSelect, { target: { value: "samsung" } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Galaxy S23")).toBeTruthy();
    const modelSelect = screen.getByLabelText("型号（该品牌下档案）") as HTMLSelectElement;
    expect(modelSelect.value).toBe("samsung-galaxy-s23");
  });

  it("renders the trace-cleansing checkbox checked by default", async () => {
    await renderForm();
    const box = screen.getByLabelText(/容器痕迹清理/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    // Hint explains what gets faked and what needs the Zygisk module.
    expect(screen.getByText(/按所选档案 SoC 生成 ARM 风格假 \/proc\/cpuinfo/)).toBeTruthy();
  });

  it("sends cleanTraces=false in the create request when unticked", async () => {
    vi.useRealTimers();
    // Make the submit button enabled: Magisk assets probe must report ready.
    vi.mocked(DeviceService.getMagiskAssets).mockResolvedValue({
      magiskDir: "C:/magisk",
      magiskOk: true,
      lsposedOk: true,
      shamikoOk: true,
    });
    await renderForm();
    // GApps would block submission (no zip path in the mocked settings).
    fireEvent.click(screen.getByRole("checkbox", { name: /预装到本实例/ }));
    const box = screen.getByLabelText(/容器痕迹清理/) as HTMLInputElement;
    fireEvent.click(box); // untick
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));
    await waitFor(() => expect(DeviceService.createInstance).toHaveBeenCalled());
    expect(DeviceService.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ cleanTraces: false }),
    );
    vi.useFakeTimers();
  });

  it("renders the GPU passthrough checkbox unchecked by default with the WSL2 hint", async () => {
    await renderForm();
    const box = screen.getByLabelText(/GPU 透传/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(
      screen.getByText(/GL 渲染器将从 SwiftShader 软渲染变为宿主 GPU/),
    ).toBeTruthy();
    expect(screen.getByText(/Windows\+WSL2 下视内核而定/)).toBeTruthy();
  });

  it("sends gpuPassthrough=true in the create request when ticked", async () => {
    vi.useRealTimers();
    vi.mocked(DeviceService.getMagiskAssets).mockResolvedValue({
      magiskDir: "C:/magisk",
      magiskOk: true,
      lsposedOk: true,
      shamikoOk: true,
    });
    await renderForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /预装到本实例/ }));
    fireEvent.click(screen.getByLabelText(/GPU 透传/));
    fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));
    await waitFor(() => expect(DeviceService.createInstance).toHaveBeenCalled());
    expect(DeviceService.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ gpuPassthrough: true }),
    );
    vi.useFakeTimers();
  });
});
