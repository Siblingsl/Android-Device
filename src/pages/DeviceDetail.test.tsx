// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { DeviceDetail } from "./DeviceDetail";
import type { AppInfo, DeviceInfo, FileEntry, RootStatus, ScreenshotResult } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
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
    getRootStatus: vi.fn(),
    getLsposedScope: vi.fn(),
    getSuPolicies: vi.fn(),
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
    vi.mocked(DeviceService.uploadFile).mockRejectedValueOnce(new Error("upload unavailable"));

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
    vi.mocked(DeviceService.downloadFile).mockRejectedValueOnce(new Error("download unavailable"));

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
    expect(DeviceService.uploadFile).not.toHaveBeenCalled();
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
    expect(DeviceService.downloadFile).not.toHaveBeenCalled();
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

  it("shows upload progress and blocks duplicate uploads", async () => {
    const pending = deferred<{ success: boolean; stdout: string; stderr: string; exitCode: number }>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFile).mockReturnValueOnce(pending.promise);

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
    expect(DeviceService.uploadFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ success: true, stdout: "", stderr: "", exitCode: 0 });
      await pending.promise;
      await Promise.resolve();
    });
  });

  it("offers an upload retry without reopening the file picker", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(open).mockResolvedValueOnce("C:/upload.txt");
    vi.mocked(DeviceService.uploadFile)
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

    expect(DeviceService.uploadFile).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(DeviceService.uploadFile).toHaveBeenLastCalledWith("device-1-serial", "C:/upload.txt", "/sdcard/upload.txt");
  });

  it("offers a download retry without reopening the save dialog", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFile)
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

    expect(DeviceService.downloadFile).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(DeviceService.downloadFile).toHaveBeenLastCalledWith("device-1-serial", "/sdcard/old.txt", "C:/old.txt");
  });

  it("blocks uploads while a download is in progress", async () => {
    const pending = deferred<{ success: boolean; stdout: string; stderr: string; exitCode: number }>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(save).mockResolvedValueOnce("C:/old.txt");
    vi.mocked(DeviceService.downloadFile).mockReturnValueOnce(pending.promise);

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
