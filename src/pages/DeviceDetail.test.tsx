// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { DeviceDetail } from "./DeviceDetail";
import type {
  AppInfo,
  DeviceInfo,
  FileEntry,
  FileTransferProgress,
  RootStatus,
  ShellResult,
  ScreenshotResult,
} from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const transferEventState = vi.hoisted(() => ({
  handler: null as ((event: { payload: FileTransferProgress }) => void) | null,
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: FileTransferProgress }) => void) => {
    transferEventState.handler = handler;
    return transferEventState.unlisten;
  }),
}));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getDevice: vi.fn(),
    listDevices: vi.fn(),
    startContainer: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    mkdir: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    downloadFile: vi.fn(),
    uploadFileTracked: vi.fn(),
    downloadFileTracked: vi.fn(),
    cancelFileTransfer: vi.fn(),
    getRootStatus: vi.fn(),
    getLsposedScope: vi.fn(),
    getSuPolicies: vi.fn(),
    getSpoofIdentity: vi.fn(),
    listSpoofProfiles: vi.fn(),
    applySpoofProfile: vi.fn(),
    magiskApplySpoof: vi.fn(),
    getCloakStatus: vi.fn(),
    installCloakModule: vi.fn(),
    pushCloakConfig: vi.fn(),
    installNativeCloak: vi.fn(),
    seedUsageBaseline: vi.fn(),
    geoConsistencyCheck: vi.fn(),
    getBatteryState: vi.fn(),
    applyBatteryPolicy: vi.fn(),
    adversarialAudit: vi.fn(),
    shell: vi.fn(),
    getDeviceProxyStatus: vi.fn(),
    applyDeviceProxy: vi.fn(),
    clearDeviceProxy: vi.fn(),
    applyTransparentProxy: vi.fn(),
    stopTransparentProxy: vi.fn(),
    listFiles: vi.fn(),
    storageInfo: vi.fn(),
    listApps: vi.fn(),
    getAppDetail: vi.fn(),
    getAppPermissions: vi.fn(),
    getAppActivities: vi.fn(),
    startApp: vi.fn(),
    stopApp: vi.fn(),
    clearAppData: vi.fn(),
    uninstallApp: vi.fn(),
    installApk: vi.fn(),
    logcat: vi.fn(),
    scrcpyStatus: vi.fn(),
    screenshot: vi.fn(),
  },
}));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../lib/dialogs", () => ({ askConfirm: vi.fn() }));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: {
    setStatusText: () => void;
    saveSettings: () => Promise<void>;
    settings: null;
    monitorAlerts: never[];
    addMonitorAlert: () => void;
    dismissMonitorAlert: () => void;
    clearMonitorAlerts: () => void;
  }) => unknown) =>
    selector({
      setStatusText: () => {},
      saveSettings: async () => {},
      settings: null,
      monitorAlerts: [],
      addMonitorAlert: () => {},
      dismissMonitorAlert: () => {},
      clearMonitorAlerts: () => {},
    }),
}));

const { DeviceService } = await import("../services/deviceService");
const { askConfirm } = await import("../lib/dialogs");
const { open, save } = await import("@tauri-apps/plugin-dialog");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const device = (id: string, name = id): DeviceInfo => ({
  id,
  name,
  serial: `${id}-serial`,
  androidVersion: "13",
  online: true,
  cpu: "2",
  ram: "2g",
  fps: 60,
  adbStatus: "device",
  scrcpyStatus: "stopped",
  dockerStatus: "running",
  ip: "",
  mac: "",
  resolution: "1080x1920",
  dpi: "320",
  containerId: "",
  image: "",
  startedAt: "",
  uptime: "",
  adbPort: 5555,
  scrcpyPort: 5556,
});

const rootStatus = (version: string): RootStatus => ({
  magisk: true,
  version,
  zygiskEnabled: false,
  zygiskActive: false,
  denylistEnforced: false,
  lsposedActive: false,
  magiskApp: true,
  lsposedManager: false,
  modules: [],
  denylist: [],
  props: {},
  presetLogTail: "",
});

const spoofIdentityFixture = {
  brand: "Xiaomi",
  model: "2210132C",
  marketName: "Redmi K40",
  fingerprint: "Xiaomi/alioth/alioth:13/TKQ1.220829.002/V14.0.6.0.TKHCNXM:user/release-keys",
  device: "alioth",
  matchedProfileId: "redmi-k40-alioth",
};

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
  },
];

const file = (name: string): FileEntry => ({
  name,
  path: `/sdcard/${name}`,
  isDir: false,
  size: "1 KB",
  permissions: "rw",
  modified: "2026-09-08",
});

const app = (label: string): AppInfo => ({
  packageName: `com.example.${label.toLowerCase()}`,
  label,
  versionName: "1.0",
  versionCode: "1",
  systemApp: false,
  enabled: true,
  apkPath: `/data/app/${label}.apk`,
  firstInstallTime: "",
  lastUpdateTime: "",
  size: "1 MB",
});

function renderDetail(tab: string) {
  sessionStorage.setItem("rdc.detail.tab.device-1", tab);
  return render(
    <MemoryRouter initialEntries={["/devices/device-1"]}>
      <Routes>
        <Route path="/devices/:id" element={<DeviceDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function emitTransfer(overrides: Partial<FileTransferProgress> = {}) {
  const calls = [
    ...vi.mocked(DeviceService.uploadFileTracked).mock.calls,
    ...vi.mocked(DeviceService.downloadFileTracked).mock.calls,
  ];
  const operationId = overrides.operationId ?? calls[calls.length - 1]?.[3] ?? "op-test";
  const payload: FileTransferProgress = {
    operationId,
    direction: overrides.direction ?? "download",
    status: overrides.status ?? "running",
    bytesTransferred: overrides.bytesTransferred ?? null,
    totalBytes: overrides.totalBytes ?? null,
    percent: overrides.percent ?? null,
    message: overrides.message ?? "running",
  };
  act(() => {
    transferEventState.handler?.({ payload });
  });
}

function findDownloadButton() {
  return screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-download"));
}

function NavigateTo({ path }: { path: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setTimeout(() => navigate(path), 0);
    return () => window.clearTimeout(timer);
  }, [navigate, path]);
  return null;
}

describe("DeviceDetail refresh ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.listDevices).mockResolvedValue([]);
    vi.mocked(DeviceService.getRootStatus).mockResolvedValue(rootStatus("Root"));
    vi.mocked(DeviceService.getLsposedScope).mockResolvedValue({ modules: [] });
    vi.mocked(DeviceService.getSuPolicies).mockResolvedValue([]);
    vi.mocked(DeviceService.storageInfo).mockResolvedValue("storage");
    vi.mocked(DeviceService.listFiles).mockResolvedValue([]);
    vi.mocked(DeviceService.listApps).mockResolvedValue([]);
    vi.mocked(DeviceService.getAppDetail).mockResolvedValue(app("默认应用"));
    vi.mocked(DeviceService.getAppPermissions).mockResolvedValue("");
    vi.mocked(DeviceService.getAppActivities).mockResolvedValue("");
    vi.mocked(DeviceService.logcat).mockResolvedValue("");
    vi.mocked(DeviceService.scrcpyStatus).mockResolvedValue("stopped");
    vi.mocked(DeviceService.screenshot).mockResolvedValue({
      success: false,
      path: "",
      base64: "",
      error: "unavailable",
    });
    vi.mocked(DeviceService.getDevice).mockReset();
    vi.mocked(DeviceService.startContainer).mockReset();
    vi.mocked(DeviceService.restart).mockReset();
    vi.mocked(DeviceService.stop).mockReset();
    vi.mocked(DeviceService.mkdir).mockReset();
    vi.mocked(DeviceService.uploadFile).mockReset();
    vi.mocked(DeviceService.deleteFile).mockReset();
    vi.mocked(DeviceService.downloadFile).mockReset();
    vi.mocked(DeviceService.uploadFileTracked).mockReset();
    vi.mocked(DeviceService.downloadFileTracked).mockReset();
    vi.mocked(DeviceService.cancelFileTransfer).mockReset();
    vi.mocked(DeviceService.startApp).mockReset();
    vi.mocked(DeviceService.stopApp).mockReset();
    vi.mocked(DeviceService.clearAppData).mockReset();
    vi.mocked(DeviceService.uninstallApp).mockReset();
    vi.mocked(DeviceService.installApk).mockReset();
    vi.mocked(askConfirm).mockReset();
    vi.mocked(askConfirm).mockResolvedValue(true);
    vi.stubGlobal("alert", vi.fn());
    vi.mocked(open).mockReset();
    vi.mocked(save).mockReset();
    transferEventState.handler = null;
    transferEventState.unlisten.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the current device when the previous device request resolves later", async () => {
    const oldDevice = deferred<DeviceInfo>();
    const newDevice = deferred<DeviceInfo>();
    vi.mocked(DeviceService.getDevice)
      .mockReturnValueOnce(oldDevice.promise)
      .mockReturnValueOnce(newDevice.promise);

    render(
      <MemoryRouter initialEntries={["/devices/old"]}>
        <NavigateTo path="/devices/new" />
        <Routes>
          <Route path="/devices/:id" element={<DeviceDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.getDevice).toHaveBeenCalledTimes(2);

    await act(async () => {
      newDevice.resolve(device("new", "新设备"));
      await newDevice.promise;
      await Promise.resolve();
    });
    expect(screen.getAllByText("new-serial").length).toBeGreaterThan(0);

    await act(async () => {
      oldDevice.resolve(device("old", "旧设备"));
      await oldDevice.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("old-serial")).toBeNull();
    expect(screen.getAllByText("new-serial").length).toBeGreaterThan(0);
  });

  it("ignores an older file listing after navigating to a newer path", async () => {
    const first = deferred<FileEntry[]>();
    const second = deferred<FileEntry[]>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.listFiles).toHaveBeenCalledTimes(1);

    const pathInput = screen.getByDisplayValue("/sdcard");
    fireEvent.change(pathInput, { target: { value: "/sdcard/Download" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    expect(DeviceService.listFiles).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve([file("new.txt")]);
      await second.promise;
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /new\.txt/ })).toBeTruthy();

    await act(async () => {
      first.resolve([file("old.txt")]);
      await first.promise;
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /old\.txt/ })).toBeNull();
    expect(screen.getByRole("button", { name: /new\.txt/ })).toBeTruthy();
  });

  it("keeps the newest app filter result when the previous listing resolves later", async () => {
    const first = deferred<AppInfo[]>();
    const second = deferred<AppInfo[]>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.listApps).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(DeviceService.listApps).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve([app("新应用")]);
      await second.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("新应用")).toBeTruthy();

    await act(async () => {
      first.resolve([app("旧应用")]);
      await first.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("旧应用")).toBeNull();
    expect(screen.getByText("新应用")).toBeTruthy();
  });

  it("does not show an older app detail after the device refreshes", async () => {
    const detail = deferred<AppInfo>();
    const permissions = deferred<string>();
    const activities = deferred<string>();
    const firstDevice = device("device-1");
    const secondDevice = { ...device("device-1"), serial: "device-2-serial", name: "更新设备" };
    sessionStorage.setItem("rdc.detail.tab.device-1", "apps");
    vi.mocked(DeviceService.getDevice)
      .mockReturnValueOnce(Promise.resolve(firstDevice))
      .mockReturnValueOnce(Promise.resolve(secondDevice));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.getAppDetail).mockReturnValueOnce(detail.promise);
    vi.mocked(DeviceService.getAppPermissions).mockReturnValueOnce(permissions.promise);
    vi.mocked(DeviceService.getAppActivities).mockReturnValueOnce(activities.promise);

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.getAppDetail).toHaveBeenCalledWith("device-1-serial", "com.example.测试应用");

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("更新设备").length).toBeGreaterThan(0);

    await act(async () => {
      detail.resolve(app("旧详情"));
      permissions.resolve("旧权限");
      activities.resolve("旧 Activity");
      await Promise.all([detail.promise, permissions.promise, activities.promise]);
      await Promise.resolve();
    });
    expect(screen.queryByText(/Package: com\.example\.旧详情/)).toBeNull();
  });

  it("keeps the newest logcat interval result when an earlier read resolves later", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.logcat)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderDetail("logs");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.logcat).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(DeviceService.logcat).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve("新日志");
      await second.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("新日志")).toBeTruthy();

    await act(async () => {
      first.resolve("旧日志");
      await first.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("旧日志")).toBeNull();
    expect(screen.getByText("新日志")).toBeTruthy();
  });

  it("keeps the newest root status after a manual refresh", async () => {
    const first = deferred<RootStatus>();
    const second = deferred<RootStatus>();
    vi.mocked(DeviceService.getDevice).mockImplementation(async (id) => device(id));
    vi.mocked(DeviceService.getRootStatus).mockImplementation((serial) =>
      serial === "device-1-serial" ? first.promise : second.promise,
    );

    render(
      <MemoryRouter initialEntries={["/devices/device-1"]}>
        <NavigateTo path="/devices/device-2" />
        <Routes>
          <Route path="/devices/:id" element={<DeviceDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.getRootStatus).toHaveBeenCalledWith("device-1-serial");
    expect(DeviceService.getRootStatus).toHaveBeenCalledWith("device-2-serial");

    await act(async () => {
      second.resolve(rootStatus("Root 新版"));
      await second.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("Root 新版")).toBeTruthy();

    await act(async () => {
      first.resolve(rootStatus("Root 旧版"));
      await first.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("Root 旧版")).toBeNull();
    expect(screen.getByText("Root 新版")).toBeTruthy();
  });

  it("keeps the current device scrcpy status when the previous status resolves later", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstDevice = device("device-1");
    const secondDevice = { ...device("device-1"), serial: "device-2-serial", name: "更新设备" };
    sessionStorage.setItem("rdc.detail.tab.device-1", "control");
    vi.mocked(DeviceService.getDevice)
      .mockReturnValueOnce(Promise.resolve(firstDevice))
      .mockReturnValueOnce(Promise.resolve(secondDevice));
    vi.mocked(DeviceService.scrcpyStatus).mockImplementation((serial) =>
      serial === "device-1-serial" ? first.promise : second.promise,
    );

    renderDetail("control");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.scrcpyStatus).toHaveBeenCalledWith("device-1-serial");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.scrcpyStatus).toHaveBeenCalledWith("device-2-serial");

    await act(async () => {
      second.resolve("新状态");
      await second.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("scrcpy: 新状态")).toBeTruthy();

    await act(async () => {
      first.resolve("旧状态");
      await first.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("scrcpy: 旧状态")).toBeNull();
    expect(screen.getByText("scrcpy: 新状态")).toBeTruthy();
  });

  it("does not show an older device screenshot after the device refreshes", async () => {
    const screenshot = deferred<ScreenshotResult>();
    const firstDevice = device("device-1");
    const secondDevice = { ...device("device-1"), serial: "device-2-serial", name: "更新设备" };
    sessionStorage.setItem("rdc.detail.tab.device-1", "control");
    vi.mocked(DeviceService.getDevice)
      .mockReturnValueOnce(Promise.resolve(firstDevice))
      .mockReturnValueOnce(Promise.resolve(secondDevice));
    vi.mocked(DeviceService.screenshot).mockReturnValueOnce(screenshot.promise);

    renderDetail("control");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "截图" })[0]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.screenshot).toHaveBeenCalledWith("device-1-serial");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("更新设备")).toBeTruthy();

    await act(async () => {
      screenshot.resolve({ success: true, path: "old.png", base64: "old-image" });
      await screenshot.promise;
      await Promise.resolve();
    });
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reports a container start error and releases the busy state", async () => {
    const offlineDevice = {
      ...device("device-1"),
      online: false,
      adbStatus: "offline",
      containerId: "container-1",
    };
    vi.mocked(DeviceService.getDevice).mockResolvedValue(offlineDevice);
    vi.mocked(DeviceService.startContainer).mockRejectedValueOnce(new Error("docker unavailable"));

    renderDetail("overview");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "启动容器" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("docker unavailable");
    expect((screen.getByRole("button", { name: "启动容器" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a restart error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.restart).mockRejectedValueOnce(new Error("restart unavailable"));

    renderDetail("overview");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "restart" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("restart unavailable");
  });

  it("reports a stop error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.stop).mockRejectedValueOnce(new Error("stop unavailable"));

    renderDetail("overview");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "stop" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("stop unavailable");
  });

  it("reports a folder creation error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.mkdir).mockRejectedValueOnce(new Error("mkdir unavailable"));
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("new-folder"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("mkdir unavailable");
  });

  it("reports a file deletion error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(DeviceService.deleteFile).mockRejectedValueOnce(new Error("delete unavailable"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const trashButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-trash-2"));
    expect(trashButton).toBeTruthy();
    fireEvent.click(trashButton!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("delete unavailable");
  });

  it("reports a file upload error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFileTracked).mockRejectedValueOnce(new Error("upload unavailable"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("upload unavailable");
  });

  it("reports a file download error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked).mockRejectedValueOnce(new Error("download unavailable"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const downloadButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-download"));
    expect(downloadButton).toBeTruthy();
    fireEvent.click(downloadButton!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("download unavailable");
  });

  it("keeps file upload cancellation silent", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockRejectedValueOnce(new Error("user canceled"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).not.toHaveBeenCalled();
    expect(DeviceService.uploadFileTracked).not.toHaveBeenCalled();
  });

  it("keeps file download cancellation silent", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockRejectedValueOnce(new Error("user canceled"));

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const downloadButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-download"));
    expect(downloadButton).toBeTruthy();
    fireEvent.click(downloadButton!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).not.toHaveBeenCalled();
    expect(DeviceService.downloadFileTracked).not.toHaveBeenCalled();
  });

  it("reports an app start error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.startApp).mockRejectedValueOnce(new Error("start unavailable"));

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("start unavailable");
  });

  it("reports an app stop error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.stopApp).mockRejectedValueOnce(new Error("stop unavailable"));

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("stop unavailable");
  });

  it("reports an app data clearing error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.clearAppData).mockRejectedValueOnce(new Error("clear unavailable"));

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const appActions = screen.getAllByRole("combobox");
    fireEvent.change(appActions[appActions.length - 1], { target: { value: "clear" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("clear unavailable");
  });

  it("reports an app uninstall error instead of leaving an unhandled rejection", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.uninstallApp).mockRejectedValueOnce(new Error("uninstall unavailable"));

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const appActions = screen.getAllByRole("combobox");
    fireEvent.change(appActions[appActions.length - 1], { target: { value: "uninstall" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("uninstall unavailable");
  });

  it("uses tracked upload and renders a real event percentage", async () => {
    const pending = deferred<ShellResult>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFileTracked).mockReturnValueOnce(pending.promise);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.uploadFileTracked).toHaveBeenCalledWith(
      "device-1-serial",
      "C:/upload.txt",
      "/sdcard/upload.txt",
      expect.any(String),
    );
    emitTransfer({ direction: "upload", percent: 50, bytesTransferred: 512, totalBytes: 1024 });
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");

    await act(async () => {
      pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("shows indeterminate progress when the backend has no percentage", async () => {
    const pending = deferred<ShellResult>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked).mockReturnValueOnce(pending.promise);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(findDownloadButton()!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    emitTransfer({ direction: "download", status: "running" });
    expect(screen.getByRole("status").textContent).toContain("进行中");
    expect(screen.queryByRole("progressbar")).toBeNull();

    await act(async () => {
      pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("sends cancellation once and stays silent for a cancelled transfer", async () => {
    const pending = deferred<ShellResult>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked).mockReturnValueOnce(pending.promise);
    vi.mocked(DeviceService.cancelFileTransfer).mockResolvedValueOnce(true);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(findDownloadButton()!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    emitTransfer({ direction: "download", status: "running" });

    const cancelButton = screen.getByRole("button", { name: /取消/ });
    fireEvent.click(cancelButton);
    fireEvent.click(cancelButton);
    expect(DeviceService.cancelFileTransfer).toHaveBeenCalledTimes(1);

    emitTransfer({ direction: "download", status: "cancelled" });
    await act(async () => {
      pending.resolve({ success: false, stdout: "", stderr: "command cancelled", exitCode: -1 });
      await pending.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText(/下载失败/)).toBeNull();
    expect((findDownloadButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes the listener on unmount and ignores another operation", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    const view = renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    emitTransfer({ operationId: "other-op", direction: "download", percent: 90 });
    expect(screen.queryByRole("progressbar")).toBeNull();
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(transferEventState.unlisten).toHaveBeenCalledTimes(1);
  });

  it("retries with a new operation id without reopening the save dialog", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked)
      .mockRejectedValueOnce(new Error("download unavailable"))
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(findDownloadButton()!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.downloadFileTracked).toHaveBeenCalledTimes(2);
    expect(new Set(vi.mocked(DeviceService.downloadFileTracked).mock.calls.map((call) => call[3])).size).toBe(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate upload protection while a tracked transfer is running", async () => {
    const pending = deferred<{ success: boolean; stdout: string; stderr: string; exitCode: number }>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFileTracked).mockReturnValueOnce(pending.promise);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const uploadButton = screen.getByRole("button", { name: "上传" });
    fireEvent.click(uploadButton);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("上传中");
    expect((uploadButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(uploadButton);
    expect(DeviceService.uploadFileTracked).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("offers an upload retry without reopening the file picker", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFileTracked)
      .mockRejectedValueOnce(new Error("upload unavailable"))
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试上传" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.uploadFileTracked).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(DeviceService.uploadFileTracked).toHaveBeenLastCalledWith(
      "device-1-serial",
      "C:/upload.txt",
      "/sdcard/upload.txt",
      expect.any(String),
    );
  });

  it("offers a download retry without reopening the save dialog", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked)
      .mockRejectedValueOnce(new Error("download unavailable"))
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const downloadButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-download"));
    expect(downloadButton).toBeTruthy();
    fireEvent.click(downloadButton!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.downloadFileTracked).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(DeviceService.downloadFileTracked).toHaveBeenLastCalledWith(
      "device-1-serial",
      "/sdcard/old.txt",
      "C:/old.txt",
      expect.any(String),
    );
  });

  it("blocks uploads while a download is in progress", async () => {
    const pending = deferred<{ success: boolean; stdout: string; stderr: string; exitCode: number }>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFileTracked).mockReturnValueOnce(pending.promise);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const downloadButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-download"));
    expect(downloadButton).toBeTruthy();
    fireEvent.click(downloadButton!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const uploadButton = screen.getByRole("button", { name: "上传" });

    expect((uploadButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(uploadButton);
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("offers an APK install retry using the previously selected path", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/app.apk");
    vi.mocked(DeviceService.listApps).mockResolvedValue([]);
    vi.mocked(DeviceService.installApk)
      .mockRejectedValueOnce(new Error("install unavailable"))
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "安装 APK" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试安装" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.installApk).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(DeviceService.installApk).toHaveBeenLastCalledWith("device-1-serial", "C:/app.apk", true);
  });
});

describe("DeviceDetail spoof card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.listDevices).mockResolvedValue([]);
    vi.mocked(DeviceService.getRootStatus).mockResolvedValue(rootStatus("Root"));
    vi.mocked(DeviceService.getLsposedScope).mockResolvedValue({ modules: [] });
    vi.mocked(DeviceService.getSuPolicies).mockResolvedValue([]);
    vi.mocked(DeviceService.getSpoofIdentity).mockResolvedValue(spoofIdentityFixture);
    vi.mocked(DeviceService.listSpoofProfiles).mockResolvedValue(spoofProfilesFixture);
    vi.mocked(DeviceService.applySpoofProfile).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.magiskApplySpoof).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.getCloakStatus).mockResolvedValue({ installed: false, enabled: false, scopeCount: 0 });
    vi.mocked(DeviceService.installCloakModule).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.pushCloakConfig).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.installNativeCloak).mockResolvedValue({ success: true, stdout: "installed-via-unzip", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.seedUsageBaseline).mockResolvedValue({ success: true, stdout: "包名清单已写入 /data/local/tmp/rdc-cloak/usage-pkg-list（46 个包）", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.geoConsistencyCheck).mockResolvedValue({
      profileId: "redmi-k40-alioth",
      deviceTimezone: "Asia/Shanghai",
      deviceLocale: "zh-CN",
      issues: [],
      consistent: true,
    });
    vi.mocked(DeviceService.getBatteryState).mockResolvedValue({ level: 87, status: 3, charging: false });
    vi.mocked(DeviceService.applyBatteryPolicy).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.adversarialAudit).mockResolvedValue({
      serial: "device-1-serial",
      profileId: null,
      ranAt: "2026-09-14T00:00:00Z",
      message: "",
      checks: [
        { id: "cgroup", category: "cgroup", verdict: "fail", detail: "shell 进程 cgroup 含 docker：/docker/abc" },
        { id: "qemu", category: "props", verdict: "pass", detail: "ro.kernel.qemu / ro.boot.qemu 均为空" },
      ],
    });
    vi.mocked(DeviceService.shell).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.getDeviceProxyStatus).mockResolvedValue({
      httpProxy: "",
      original: "",
      transparentRunning: false,
    });
    vi.mocked(DeviceService.applyDeviceProxy).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.clearDeviceProxy).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.applyTransparentProxy).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.stopTransparentProxy).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.stubGlobal("alert", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("disables the spoof card when the device is offline", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue({ ...device("device-1"), online: false, adbStatus: "offline" });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const applyButton = screen.getByRole("button", { name: "切换档案" });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a restart suggestion after applying a profile", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const modelSelect = screen.getByLabelText("选择档案…") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "samsung-galaxy-s23" } });
    fireEvent.click(screen.getByRole("button", { name: "切换档案" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.applySpoofProfile).toHaveBeenCalledWith("device-1-serial", "samsung-galaxy-s23");
    expect(screen.getByText("立即重启")).toBeTruthy();
  });

  it("renders the deep-spoofing section and disabled buttons when offline", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue({ ...device("device-1"), online: false, adbStatus: "offline" });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("深度伪装（DeviceCloak）")).toBeTruthy();
    const installButton = screen.getByRole("button", { name: "安装模块" }) as HTMLButtonElement;
    expect(installButton.disabled).toBe(true);
  });

  it("shows the enabled status and scoped package count", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.getCloakStatus).mockResolvedValue({
      installed: true,
      enabled: true,
      scopeCount: 3,
      configPushed: true,
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("启用作用域 3 个包")).toBeTruthy();
    expect(screen.getByText("配置已推送")).toBeTruthy();
  });

  it("applies a socks5 proxy through the egress command and shows the tun2socks hint", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = screen.getByPlaceholderText("http://host:port 或 socks5://user:pass@host:port");
    fireEvent.change(input, { target: { value: "socks5://user:pass@10.0.0.2:1080" } });
    // SOCKS5 entered: hint about Android's http-only global proxy shows up.
    expect(screen.getByText(/SOCKS5 地址写入 Android 全局代理/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "应用代理" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.applyDeviceProxy).toHaveBeenCalledWith(
      "device-1-serial",
      "socks5://user:pass@10.0.0.2:1080",
    );
  });

  it("clears the proxy through the egress command", async () => {
    vi.useRealTimers(); // findByText polling needs real timers
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.getDeviceProxyStatus).mockResolvedValue({
      httpProxy: "10.0.0.2:1080",
      original: "socks5://10.0.0.2:1080",
      transparentRunning: false,
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Adjacent JSX expressions share one text node — match with a regex.
    expect(await screen.findByText(/当前代理：10\.0\.0\.2:1080/)).toBeTruthy();
    expect(screen.getByText(/记录 socks5:\/\/10\.0\.0\.2:1080/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除代理" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.clearDeviceProxy).toHaveBeenCalledWith("device-1-serial");
  });

  it("shows the transparent-takeover fallback hint when tun2socks is not configured", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The mocked app settings carry no tun2socksPath — the section must
    // degrade to a hint instead of a takeover button.
    expect(screen.getByText(/透明接管不可用：未在设置中配置 tun2socks 路径/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "启动透明接管" }),
    ).toBeNull();
  });

  it("renders the battery spoofing section, persists the toggle and applies on demand", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("电池伪装")).toBeTruthy();
    const toggle = screen.getByRole("checkbox", { name: "按模拟曲线伪装电池" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/87%/)).toBeTruthy();
    expect(screen.getByText(/放电中/)).toBeTruthy();

    // Toggle persists into the shared per-device session draft.
    fireEvent.click(toggle);
    const draft = JSON.parse(
      sessionStorage.getItem("rdc.settings.draft.device-1-serial") ?? "{}",
    ) as Record<string, string>;
    expect(draft.batterySpoof).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "立即应用" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.applyBatteryPolicy).toHaveBeenCalledWith("device-1-serial");
  });

  it("applies the battery curve automatically every 5 minutes while enabled", async () => {
    // This describe's beforeEach seeds mocks without resetting call history.
    vi.mocked(DeviceService.applyBatteryPolicy).mockClear();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    sessionStorage.clear();
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.applyBatteryPolicy).not.toHaveBeenCalled();

    // Enable the per-device switch (draft), then cross one refresh tick.
    fireEvent.click(screen.getByRole("checkbox", { name: "按模拟曲线伪装电池" }));
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.applyBatteryPolicy).toHaveBeenCalledWith("device-1-serial");
  });

  it("disables battery apply and the audit run when the device is offline", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue({
      ...device("device-1"),
      online: false,
      adbStatus: "offline",
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("button", { name: "立即应用" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "运行审计" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs the adversarial audit and renders verdict rows", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("尚未运行审计。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "运行审计" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.adversarialAudit).toHaveBeenCalledWith("device-1-serial", undefined);
    expect(screen.getByText("未通过")).toBeTruthy();
    expect(screen.getByText("通过")).toBeTruthy();
    expect(screen.getByText(/含 docker/)).toBeTruthy();
    expect(screen.getByText("容器 cgroup")).toBeTruthy();
    expect(screen.getByText(/shell 层证据/)).toBeTruthy();
  });

  it("links the selected spoof profile into the audit call", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const profileSelect = screen.getByLabelText("关联伪装档案") as HTMLSelectElement;
    fireEvent.change(profileSelect, { target: { value: "samsung-galaxy-s23" } });
    fireEvent.click(screen.getByRole("button", { name: "运行审计" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.adversarialAudit).toHaveBeenCalledWith(
      "device-1-serial",
      "samsung-galaxy-s23",
    );
  });

  it("renders the expanded 12-item audit checklist with network and telephony rows", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.adversarialAudit).mockResolvedValue({
      serial: "device-1-serial",
      profileId: null,
      ranAt: "2026-09-14T00:00:00Z",
      message: "",
      checks: [
        { id: "cgroup", category: "cgroup", verdict: "fail", detail: "shell 进程 cgroup 含 docker" },
        { id: "cpuinfo", category: "cpu", verdict: "pass", detail: "cpuinfo 显示 ARM 架构" },
        { id: "mac", category: "attestation", verdict: "fail", detail: "无 wlan0，仅 eth0" },
        { id: "dns", category: "network", verdict: "pass", detail: "net.dns1=1.1.1.1" },
        {
          id: "hostname",
          category: "network",
          verdict: "fail",
          detail: "net.hostname = 3f2b1a4c9d7e —— 12 位 hex 是 Docker 容器短 ID 特征",
        },
        {
          id: "telephony",
          category: "telephony",
          verdict: "unknown",
          detail: "信令态：mCallState=0；Java 层已盖 API 读取 —— 已知缺口",
        },
      ],
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "运行审计" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // New check rows (stable ids → i18n labels).
    expect(screen.getByText("net.hostname")).toBeTruthy();
    expect(screen.getByText("DNS 配置")).toBeTruthy();
    expect(screen.getByText("信令态（telephony.registry）")).toBeTruthy();
    // New categories render too (network covers hostname + dns).
    expect(screen.getAllByText("网络").length).toBe(2);
    expect(screen.getByText("信令")).toBeTruthy();
    // The unknown verdict keeps its own badge style/label.
    expect(screen.getByText("不确定")).toBeTruthy();
    expect(screen.getAllByText("未通过").length).toBeGreaterThanOrEqual(2);
  });

  it("checks geo consistency and renders the issue list", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.geoConsistencyCheck).mockResolvedValue({
      profileId: "samsung-galaxy-s23",
      deviceTimezone: "Asia/Shanghai",
      deviceLocale: "zh-CN",
      consistent: false,
      issues: [
        {
          code: "proxyCountryMismatch",
          message: "代理出口国别 US 与档案 country KR 不一致（proxyCountry 为用户声明值，应用内不做 GeoIP 查询）",
        },
      ],
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "检查地理一致性" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.geoConsistencyCheck).toHaveBeenCalledWith(
      "device-1-serial",
      "redmi-k40-alioth",
    );
    expect(screen.getByText(/代理出口国别 US 与档案 country KR 不一致/)).toBeTruthy();
    expect(screen.getByText(/设备时区 Asia\/Shanghai/)).toBeTruthy();
  });

  it("shows the consistent geo verdict when no issues are found", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "检查地理一致性" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("地理一致")).toBeTruthy();
  });

  it("installs the native cloak module and seeds the usage baseline", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "安装 NativeCloak" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.installNativeCloak).toHaveBeenCalledWith("device-1-serial");

    fireEvent.click(screen.getByRole("button", { name: "播种使用基线" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.seedUsageBaseline).toHaveBeenCalledWith(
      "device-1-serial",
      "redmi-k40-alioth",
    );
  });

  it("marks the native cloak present once the status reports it installed", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.getCloakStatus).mockResolvedValue({
      installed: true,
      enabled: true,
      scopeCount: 1,
      configPushed: true,
      nativeInstalled: true,
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("NativeCloak 已安装")).toBeTruthy();
  });

  it("disables the new deep-spoofing buttons when the device is offline", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue({
      ...device("device-1"),
      online: false,
      adbStatus: "offline",
    });
    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (screen.getByRole("button", { name: "安装 NativeCloak" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "播种使用基线" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "检查地理一致性" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
