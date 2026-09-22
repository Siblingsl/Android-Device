// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "./Settings";
import type { AppSettings } from "../types";

vi.mock("../stores/appStore", () => {
  const saveSettings = vi.fn(async (settings: AppSettings) => settings);
  const loadSettings = vi.fn();
  const state = {
    settings: null as AppSettings | null,
    devices: [] as unknown[],
    saveSettings,
    loadSettings,
    setTheme: vi.fn(),
    setStatusText: vi.fn(),
  };
  return {
    useAppStore: (selector: (s: typeof state) => unknown) => selector(state),
    __state: state,
  };
});
vi.mock("../hooks/useToolProbe", () => ({
  useToolProbe: () => ({
    tools: {},
    busy: false,
    probe: vi.fn(),
    probeMany: vi.fn(async () => ({ ok: 0, total: 0 })),
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.0") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/dialogs", () => ({
  askConfirm: vi.fn(async () => true),
  alertMsg: vi.fn(),
}));
vi.mock("../lib/deviceMetadata", () => ({
  getAllDeviceMetadata: () => ({}),
  removeDeviceMetadata: () => false,
}));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    revealInFolder: vi.fn(async () => undefined),
    authorizationStatus: vi.fn(async () => ({
      status: "not_registered",
      securityLevel: "dpapi_software_fallback",
      keyAlgorithm: "ed25519-dpapi-v1",
    })),
  },
}));
vi.mock("../components/settings/ShortcutEditor", () => ({ ShortcutEditor: () => null }));
vi.mock("../components/settings/ConfigTransfer", () => ({ ConfigTransfer: () => null }));
vi.mock("../components/settings/UpdatePanel", () => ({ UpdatePanel: () => null }));
vi.mock("../components/settings/SchedulerPanel", () => ({ SchedulerPanel: () => null }));

const { __state } = (await import("../stores/appStore")) as unknown as {
  __state: {
    settings: AppSettings | null;
    saveSettings: ReturnType<typeof vi.fn>;
  };
};

const baseSettings: AppSettings = {
  theme: "light",
  language: "zh-CN",
  autoUpdate: true,
  logPath: "C:/logs",
  screenshotPath: "C:/shots",
  apkPath: "C:/apks",
  proxy: "",
  dockerPath: "docker",
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  gnirehtetPath: "gnirehtet",
  recordingPath: "C:/rec",
  resourceAlertThreshold: 85,
  deviceRefreshIntervalSecs: 5,
  deviceMonitorRules: {},
  defaultTrack: "docker",
};

/** The track select has no htmlFor label; locate it through its label text. */
function trackSelect() {
  const field = screen.getByText("默认运行轨道").closest(".field") as HTMLElement;
  return field.querySelector("select") as HTMLSelectElement;
}

/** The track card lives in the "高级" tab since the tabbed settings redesign. */
async function openAdvancedTab() {
  fireEvent.click(screen.getByRole("tab", { name: "高级" }));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SettingsPage default runtime track", () => {
  beforeEach(() => {
    __state.settings = { ...baseSettings };
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the dropdown with the saved track", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();
    const select = trackSelect();
    expect(select.value).toBe("docker");
    expect(screen.getByText("QEMU（实验性）")).toBeTruthy();
  });

  it("persists a switched default track through saveSettings", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();
    fireEvent.change(trackSelect(), { target: { value: "qemu" } });
    const save = screen.getByRole("button", { name: "保存" });
    await act(async () => {
      fireEvent.click(save);
      await Promise.resolve();
    });
    await waitFor(() => expect(__state.saveSettings).toHaveBeenCalled());
    const saved = __state.saveSettings.mock.calls[0][0] as AppSettings;
    expect(saved.defaultTrack).toBe("qemu");
    // The rest of the settings survive the round-trip untouched.
    expect(saved.theme).toBe("light");
    expect(saved.dockerPath).toBe("docker");
  });
});

describe("SettingsPage accessible form labels", () => {
  beforeEach(() => {
    __state.settings = { ...baseSettings };
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("associates the visible labels with the general settings selects", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("tab", { name: "通用" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("combobox", { name: "主题" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "语言" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "更新通道" })).toBeTruthy();
  });

  it("associates the advanced runtime track label with its select", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();

    expect(screen.getByRole("combobox", { name: "默认运行轨道" })).toBeTruthy();
  });

  it("defaults an omitted QEMU warm-node preference to memory-first", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();

    const field = screen.getByText("回收实例时保持 QEMU 节点运行").closest(".field") as HTMLElement;
    const toggle = field.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("defaults critical-pressure idle reclaim to enabled and persists an explicit opt-out", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();

    const toggle = screen.getByRole("checkbox", { name: "临界内存时自动释放闲置实例" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(__state.saveSettings).toHaveBeenCalled());
    expect(__state.saveSettings.mock.calls[0][0].runtimeAutoReleaseIdleOnCritical).toBe(false);
  });
});

describe("SettingsPage authorization security status", () => {
  beforeEach(() => {
    __state.settings = { ...baseSettings };
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("distinguishes DPAPI fallback from TPM-backed protection", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await openAdvancedTab();
    await waitFor(() => expect(screen.getByText(/当前为 DPAPI 回退保护/)).toBeTruthy());
    expect(screen.queryByText(/当前为 TPM\/VBS 硬件隔离保护/)).toBeNull();
  });
});
