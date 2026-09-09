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
    listFiles: vi.fn(),
    storageInfo: vi.fn(),
    shell: vi.fn(),
    listApps: vi.fn(),
    getAppDetail: vi.fn(),
    getAppPermissions: vi.fn(),
    getAppActivities: vi.fn(),
    startApp: vi.fn(),
    startAppOnDisplay: vi.fn(),
    stopApp: vi.fn(),
    clearAppData: vi.fn(),
    uninstallApp: vi.fn(),
    installApk: vi.fn(),
    logcat: vi.fn(),
    scrcpyStart: vi.fn(),
    scrcpyStatus: vi.fn(),
    screenshot: vi.fn(),
  },
}));
vi.mock("../services/terminalSessionService", () => ({
  TerminalSessionService: { start: vi.fn() },
}));
vi.mock("../lib/terminalWindow", () => ({ openTerminalWindow: vi.fn() }));
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
const { TerminalSessionService } = await import("../services/terminalSessionService");
const { openTerminalWindow } = await import("../lib/terminalWindow");

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
    vi.mocked(DeviceService.listFiles).mockReset();
    vi.mocked(DeviceService.listFiles).mockResolvedValue([]);
    vi.mocked(DeviceService.listApps).mockReset();
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
    vi.mocked(DeviceService.scrcpyStart).mockReset();
    vi.mocked(DeviceService.scrcpyStart).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
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
    vi.mocked(DeviceService.shell).mockReset();
    vi.mocked(DeviceService.shell).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(TerminalSessionService.start).mockReset();
    vi.mocked(TerminalSessionService.start).mockResolvedValue({
      id: "device-session-1",
      kind: "device",
      title: "ADB Shell · device-1-serial",
      status: "running",
    });
    vi.mocked(openTerminalWindow).mockReset();
    vi.mocked(openTerminalWindow).mockResolvedValue({} as never);
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

  it("opens a device PTY session from the existing one-shot shell card", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    sessionStorage.setItem("rdc.detail.tab.device-1", "control");

    renderDetail("control");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(TerminalSessionService.start).toHaveBeenCalledWith({
      kind: "device",
      serial: "device-1-serial",
      shell: "",
    });
    expect(openTerminalWindow).toHaveBeenCalledWith("device-session-1", { title: "独立终端" });
  });

  it("keeps the detail workbench shell and compact control dock visible", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    sessionStorage.setItem("rdc.detail.tab.device-1", "control");

    renderDetail("control");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".device-detail-workbench")).toBeTruthy();
    expect(document.querySelector(".device-detail-header")).toBeTruthy();
    expect(document.querySelector(".device-detail-tabs")).toBeTruthy();
    expect(document.querySelector(".control-workbench")).toBeTruthy();
    expect(document.querySelector(".control-action-dock")).toBeTruthy();
    expect(document.querySelectorAll(".control-action-shelf")).toHaveLength(4);
  });

  it("keeps the file workbench rails and table surface visible", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("notes.txt")]);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".file-workbench")).toBeTruthy();
    expect(document.querySelector(".file-location-strip")).toBeTruthy();
    expect(document.querySelector(".file-command-rail")).toBeTruthy();
    expect(document.querySelector(".file-transfer-strip")).toBeTruthy();
    expect(document.querySelector(".file-selection-rail")).toBeTruthy();
    expect(document.querySelector(".file-table-surface")).toBeTruthy();
  });

  it("keeps the app workbench rails, table surface, and detail surface visible", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.getAppDetail).mockResolvedValue(app("测试应用"));

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".app-workbench")).toBeTruthy();
    expect(document.querySelector(".app-filter-strip")).toBeTruthy();
    expect(document.querySelector(".app-install-rail")).toBeTruthy();
    expect(document.querySelector(".app-install-status")).toBeTruthy();
    expect(document.querySelector(".app-table-surface")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".app-detail-surface")).toBeTruthy();
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

  it("starts scrcpy with visual options while preserving custom arguments", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));

    renderDetail("settings");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText("常用参数"));
    fireEvent.change(screen.getByRole("combobox", { name: "画面长边" }), { target: { value: "720" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "立即用此参数启动" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.scrcpyStart).toHaveBeenCalledWith(
      "device-1-serial",
      720,
      8,
      expect.stringContaining("--max-size 720"),
    );
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

  it("pastes selected files into the current folder with a remote copy command", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    vi.mocked(DeviceService.shell).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 old.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "复制所选" }));
    const pathInput = screen.getAllByRole("textbox")[0];
    fireEvent.change(pathInput, { target: { value: "/sdcard/Download" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.shell).toHaveBeenCalledWith(
      "device-1-serial",
      "cp -R '/sdcard/old.txt' '/sdcard/Download/old.txt'",
    );
  });

  it("opens a text preview and saves edited content through the device shell", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("old.txt")]);
    const readResult = deferred<ShellResult>();
    vi.mocked(DeviceService.shell)
      .mockReturnValueOnce(readResult.promise)
      .mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getAllByTitle("编辑文本")[0]);
    expect(DeviceService.shell).toHaveBeenCalledWith("device-1-serial", "cat '/sdcard/old.txt'");
    await act(async () => {
      readResult.resolve({ success: true, stdout: "hello", stderr: "", exitCode: 0 });
      await readResult.promise;
    });
    const editor = screen.getByRole("dialog", { name: "编辑文本" });
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello");
    fireEvent.change(textarea, { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "保存文件" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.shell).toHaveBeenNthCalledWith(1, "device-1-serial", "cat '/sdcard/old.txt'");
    expect(DeviceService.shell).toHaveBeenNthCalledWith(
      2,
      "device-1-serial",
      "printf '%s' '5L2g5aW9' | base64 -d > '/sdcard/old.txt'",
    );
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

  it("launches an app on the selected Android display", async () => {
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listApps).mockResolvedValue([app("测试应用")]);
    vi.mocked(DeviceService.startAppOnDisplay).mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });

    renderDetail("apps");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByRole("spinbutton", { name: "显示屏编号" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "启动到显示屏" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DeviceService.startAppOnDisplay).toHaveBeenCalledWith(
      "device-1-serial",
      "com.example.测试应用",
      2,
    );
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

  it("shows batch progress while downloading multiple selected files", async () => {
    const pending = deferred<ShellResult>();
    vi.mocked(DeviceService.getDevice).mockResolvedValue(device("device-1"));
    vi.mocked(DeviceService.listFiles).mockResolvedValue([file("one.txt"), file("two.txt")]);
    vi.mocked(open).mockResolvedValueOnce("C:/downloads");
    vi.mocked(DeviceService.downloadFileTracked).mockReturnValueOnce(pending.promise);
    vi.mocked(askConfirm).mockResolvedValue(false);

    renderDetail("files");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 one.txt" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 two.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "批量下载" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("批量下载 1/2")).toBeTruthy();
    expect(screen.getByText("已完成 0 · 失败 0")).toBeTruthy();

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
