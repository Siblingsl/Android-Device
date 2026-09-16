// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
// Evaluated before the page tree on purpose: `appStore` and `i18n` form an
// import cycle (the store calls tStatic while initializing), and the Docker
// panel's chain reaches i18n first through `ui/ToolStatus`. Importing the store
// first keeps the cycle in the order the other page tests already rely on.
import { useAppStore } from "../../stores/appStore";
import RuntimePage from "./RuntimePage";
import type { AppSettings, DockerInfo, QemuDoctorReport, QemuVmEntry, ShellResult } from "../../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn(async () => null),
  cursorPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  getCurrentWindow: vi.fn(() => ({ onCloseRequested: vi.fn(async () => () => {}) })),
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));
vi.mock("../../hooks/useToolProbe", () => ({
  probeTool: vi.fn(),
  useToolProbe: () => ({ tools: {}, busy: false, probe: vi.fn(), probeMany: vi.fn() }),
}));
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../lib/dialogs", () => ({ askConfirm: vi.fn(async () => true), alertMsg: vi.fn() }));
vi.mock("../../services/deviceService", () => ({
  DeviceService: {
    // App shell / appStore surface.
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getSystemStatus: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    listDevicesUnified: vi.fn(async () => []),
    appendLog: vi.fn(async () => undefined),
    // Docker track panel surface (mount-time loads).
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
  QemuService: {
    doctor: vi.fn(),
    setup: vi.fn(),
    vmList: vi.fn(),
    vmCreate: vi.fn(),
    vmStart: vi.fn(),
    vmStop: vi.fn(),
    vmDelete: vi.fn(),
    vmSnapshot: vi.fn(),
    vmRestore: vi.fn(),
    guestWait: vi.fn(),
    redroidCreate: vi.fn(),
    redroidUpgrade: vi.fn(),
    redroidRestore: vi.fn(),
    redroidList: vi.fn(),
    adbList: vi.fn(),
    verify: vi.fn(),
  },
}));

const { DeviceService, QemuService } = await import("../../services/deviceService");
const { probeTool } = await import("../../hooks/useToolProbe");
const App = (await import("../../App")).default;

const baseSettings: AppSettings = {
  theme: "light",
  language: "zh-CN",
  autoUpdate: true,
  logPath: "",
  screenshotPath: "",
  apkPath: "",
  proxy: "",
  dockerPath: "docker",
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  gnirehtetPath: "gnirehtet",
  recordingPath: "",
  resourceAlertThreshold: 85,
  deviceRefreshIntervalSecs: 5,
  deviceMonitorRules: {},
  defaultTrack: "docker",
};

const dockerInfo: DockerInfo = {
  running: true,
  version: "27.0.0",
  images: [],
  containers: [],
  cpuUsage: 4,
  memoryUsage: 8,
};

const doctorReport: QemuDoctorReport = { stateDir: "C:/QemuCenter", checks: [] };

// Panel-internal subtitles: unique to each track, so they prove which panel is
// mounted without depending on the shell's own labels.
const DOCKER_PANEL = "Docker 状态、WSL 内核、镜像、容器与 Redroid 实例";
const QEMU_PANEL = "QEMU/WHPX 轨道：节点（VM）→ 实例（redroid 容器）";

/** Shows the router's current location so tests can assert the deep link. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderShell(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RuntimePage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function currentLocation() {
  return screen.getByTestId("location").textContent;
}

/** Flush the panels' mount-time loads. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function activeTab() {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true");
}

function expectOnlyDockerPanel() {
  expect(screen.getByText(DOCKER_PANEL)).toBeTruthy();
  expect(screen.queryByText(QEMU_PANEL)).toBeNull();
}

function expectOnlyQemuPanel() {
  expect(screen.getByText(QEMU_PANEL)).toBeTruthy();
  expect(screen.queryByText(DOCKER_PANEL)).toBeNull();
}

/** Direct children of the router outlet wrapper the panel must not be wrapped in. */
function fadeChildren() {
  const fade = document.querySelector(".page-fade") as HTMLElement;
  return Array.from(fade.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deterministic language: the real provider resolves it from localStorage and
  // falls back to navigator.language (en-US under jsdom).
  localStorage.setItem("rdc.lang", "zh-CN");
  useAppStore.setState({ settings: { ...baseSettings } });
  vi.mocked(probeTool).mockResolvedValue({ ok: true, text: "available" });
  vi.mocked(DeviceService.getSettings).mockResolvedValue({ ...baseSettings });
  vi.mocked(DeviceService.updateSettings).mockImplementation(async (settings) => settings);
  vi.mocked(DeviceService.refreshDockerInfo).mockResolvedValue(dockerInfo);
  vi.mocked(DeviceService.getWslKernelStatus).mockRejectedValue(new Error("unavailable"));
  vi.mocked(DeviceService.getMagiskAssets).mockResolvedValue({
    magiskDir: "",
    magiskOk: false,
    lsposedOk: false,
    shamikoOk: false,
  });
  vi.mocked(DeviceService.getLocalGappsPath).mockResolvedValue("");
  vi.mocked(DeviceService.listSpoofProfiles).mockResolvedValue([]);
  vi.mocked(DeviceService.spoofProfileUsage).mockResolvedValue([]);
  vi.mocked(DeviceService.getCreateStage).mockResolvedValue("");
  vi.mocked(QemuService.doctor).mockResolvedValue(doctorReport);
  vi.mocked(QemuService.vmList).mockResolvedValue([] as QemuVmEntry[]);
  vi.mocked(QemuService.redroidList).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("rdc.lang");
  window.location.hash = "";
});

describe("RuntimePage track resolution", () => {
  it("falls back to the Docker track when nothing is remembered", async () => {
    renderShell("/containers");
    await flush();

    expect(activeTab()?.textContent).toContain("本机 Docker");
    expectOnlyDockerPanel();
  });

  it("restores the remembered track when the URL has no ?track=", async () => {
    useAppStore.setState({ settings: { ...baseSettings, defaultTrack: "qemu" } });
    renderShell("/containers");
    await flush();

    expect(activeTab()?.textContent).toContain("QEMU 节点");
    expectOnlyQemuPanel();
  });

  it("lets ?track= win over the remembered track", async () => {
    useAppStore.setState({ settings: { ...baseSettings, defaultTrack: "qemu" } });
    renderShell("/containers?track=docker");
    await flush();

    expect(activeTab()?.textContent).toContain("本机 Docker");
    expectOnlyDockerPanel();
  });

  it("ignores an unknown ?track= value and falls back to the remembered track", async () => {
    useAppStore.setState({ settings: { ...baseSettings, defaultTrack: "qemu" } });
    renderShell("/containers?track=podman");
    await flush();

    expect(activeTab()?.textContent).toContain("QEMU 节点");
    expectOnlyQemuPanel();
  });

  it("mounts only the active track's panel", async () => {
    const { unmount } = renderShell("/containers?track=docker");
    await flush();
    expect(screen.queryByText(QEMU_PANEL)).toBeNull();
    unmount();

    renderShell("/containers?track=qemu");
    await flush();
    expect(screen.queryByText(DOCKER_PANEL)).toBeNull();
  });
});

describe("RuntimePage track switching", () => {
  it("writes the picked track into the URL", async () => {
    renderShell("/containers");
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "QEMU 节点" }));
    await flush();

    expect(currentLocation()).toBe("/containers?track=qemu");
    expectOnlyQemuPanel();
  });

  it("remembers the picked track through the settings preference", async () => {
    renderShell("/containers");
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "QEMU 节点" }));
    await flush();

    expect(DeviceService.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTrack: "qemu" }),
    );
    expect(useAppStore.getState().settings?.defaultTrack).toBe("qemu");

    // The next bare visit (fresh URL, no ?track=) resolves from the memory.
    cleanup();
    renderShell("/containers");
    await flush();
    expectOnlyQemuPanel();
  });

  it("switches tracks with the left/right arrow keys and keeps focus on the tab", async () => {
    renderShell("/containers?track=docker");
    await flush();

    const dockerTab = screen.getByRole("tab", { name: "本机 Docker" });
    dockerTab.focus();
    expect(document.activeElement).toBe(dockerTab);

    fireEvent.keyDown(dockerTab, { key: "ArrowRight" });
    await flush();

    expect(currentLocation()).toBe("/containers?track=qemu");
    expectOnlyQemuPanel();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "QEMU 节点" }));

    // Arrow keys wrap around at both ends of the tablist.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    await flush();
    expect(currentLocation()).toBe("/containers?track=docker");
    expectOnlyDockerPanel();
  });
});

describe("runtime shell i18n", () => {
  it("defines every shell key in both zh and en", async () => {
    const { runtimeZh, runtimeEn } = await import("../../i18n/pages/runtime");
    expect(Object.keys(runtimeEn).sort()).toEqual(Object.keys(runtimeZh).sort());
    // Agreed copy from the page-merge spec (§6.6 / decision #1).
    expect(runtimeZh["runtime.title"]).toBe("容器与节点");
    expect(runtimeZh["runtime.track.docker"]).toBe("本机 Docker");
    expect(runtimeZh["runtime.track.qemu"]).toBe("QEMU 节点");
    expect(runtimeEn["runtime.title"]).toBeTruthy();
    expect(runtimeEn["runtime.subtitle"]).toBeTruthy();
  });
});

/**
 * P3 lifecycle (merge spec §6.4): mount strategy across a track switch, the
 * `active` polling contract and the source-tagged status line. These tests
 * drive the real panel code — the Docker long task is started through the
 * create form, the QEMU one through the global setup flag it already reads.
 */
describe("RuntimePage lifecycle (P3)", () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    useAppStore.setState({ qemuSetup: null, qemuWaitVm: null, statusText: "" });
    // The debounced probes below run for real once fake timers are advanced.
    vi.mocked(DeviceService.checkInstanceName).mockResolvedValue(false);
    vi.mocked(DeviceService.checkAdbPort).mockResolvedValue(false);
    vi.mocked(DeviceService.pathExists).mockResolvedValue(true);
    vi.mocked(DeviceService.getCreateStage).mockResolvedValue("");
    vi.mocked(DeviceService.nextFreeAdbPort).mockResolvedValue(5555);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    vi.useRealTimers();
    useAppStore.setState({ qemuSetup: null, qemuWaitVm: null });
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  /** Let pending promises (and, under fake timers, due timers) settle. */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  /** Let a few promise chains settle (panel loads fan out over several ticks). */
  async function drain() {
    for (let i = 0; i < 3; i += 1) await settle();
  }

  async function switchTo(name: string) {
    fireEvent.click(screen.getByRole("tab", { name }));
    await drain();
  }

  function runtimeShell() {
    return document.querySelector(".runtime-shell") as HTMLElement;
  }

  function inactiveTrack() {
    return runtimeShell().getAttribute("data-inactive-track");
  }

  function backgroundBar() {
    return document.querySelector(".runtime-bg-task");
  }

  function createSubmit() {
    return document.getElementById("rdc-create-submit") as HTMLButtonElement | null;
  }

  /**
   * The Docker create is still running *in this mount*: the create modal is
   * still open and its submit is in the loading state (a remount would have
   * reset `showCreate` and `busy`, and the button with them).
   */
  function expectCreateStillRunning() {
    expect(document.querySelector(".create-modal-layer")).toBeTruthy();
    expect(createSubmit()?.disabled).toBe(true);
    expect(createSubmit()?.textContent).toBe("...");
  }

  /**
   * Start a real Docker create through the panel's own form: the GApps
   * preinstall has to come off first (no asset in this environment), then the
   * submit keeps running until the returned deferred resolves.
   */
  async function startDockerCreate() {
    const create = deferred<ShellResult>();
    vi.mocked(DeviceService.createInstance).mockReturnValue(create.promise);
    fireEvent.click(screen.getByRole("button", { name: "创建实例" }));
    await drain();
    fireEvent.click(screen.getByLabelText(/预装到本实例/));
    await drain();
    fireEvent.click(createSubmit() as HTMLElement);
    await drain();
    return create;
  }

  /** Stage label of the running create, as the shell's bar shows it. */
  const PROBING = "检测 Docker";

  it("keeps a task-running track mounted, shows the bar and returns to that track", async () => {
    vi.useFakeTimers();
    renderShell("/containers?track=docker");
    await drain();
    await startDockerCreate();

    expect(screen.getByText(DOCKER_PANEL)).toBeTruthy();
    expectCreateStillRunning();

    await switchTo("QEMU 节点");

    // Still mounted (hidden by CSS, not unmounted): the create's local state
    // must survive the switch.
    expect(screen.getByText(DOCKER_PANEL)).toBeTruthy();
    expect(screen.getByText(QEMU_PANEL)).toBeTruthy();
    expect(inactiveTrack()).toBe("docker");
    const bar = backgroundBar();
    expect(bar?.textContent).toContain("本机 Docker 仍在执行");
    expect(bar?.textContent).toContain(PROBING);
    expect(bar?.querySelector("button")?.textContent).toBe("回到该轨道");

    fireEvent.click(screen.getByRole("button", { name: "回到该轨道" }));
    await drain();

    expect(currentLocation()).toBe("/containers?track=docker");
    expect(inactiveTrack()).toBeNull();
    expect(screen.queryByText(QEMU_PANEL)).toBeNull();
    // Same mount, not a fresh one: the create is still running in the panel.
    expectCreateStillRunning();
  });

  it("unmounts the hidden track again once its task ended", async () => {
    vi.useFakeTimers();
    renderShell("/containers?track=docker");
    await drain();
    const create = await startDockerCreate();

    await switchTo("QEMU 节点");
    expect(inactiveTrack()).toBe("docker");
    expect(screen.getByText(DOCKER_PANEL)).toBeTruthy();

    await act(async () => {
      create.resolve({ success: false, stdout: "", stderr: "boom", exitCode: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });
    await drain();
    await drain();

    expect(screen.queryByText(DOCKER_PANEL)).toBeNull();
    expect(inactiveTrack()).toBeNull();
    expect(backgroundBar()).toBeNull();
  });

  it("pauses the hidden track's business polling (zero polls while inactive)", async () => {
    vi.useFakeTimers();
    renderShell("/containers?track=docker");
    await drain();
    await startDockerCreate();

    // Polling while active: the create-stage poll is this track's business timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(vi.mocked(DeviceService.getCreateStage).mock.calls.length).toBeGreaterThan(0);

    await switchTo("QEMU 节点");
    const callsAfterSwitch = vi.mocked(DeviceService.getCreateStage).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700 * 12);
    });

    expect(vi.mocked(DeviceService.getCreateStage).mock.calls.length).toBe(callsAfterSwitch);
    // It is still mounted — the poll is paused, the panel was not dropped.
    expect(screen.getByText(DOCKER_PANEL)).toBeTruthy();
    expectCreateStillRunning();
  });

  it("pauses the hidden track's setup poll but keeps polling while active", async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      qemuSetup: { running: true, step: "all", startedAt: Date.now() },
    });
    renderShell("/containers?track=qemu");
    await drain();
    expect(screen.getByText(QEMU_PANEL)).toBeTruthy();

    // Active + setup running: the 30s doctor poll runs (task-progress refresh).
    const before = vi.mocked(QemuService.doctor).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(vi.mocked(QemuService.doctor).mock.calls.length).toBeGreaterThan(before);

    await switchTo("本机 Docker");
    expect(inactiveTrack()).toBe("qemu");
    const callsAfterSwitch = vi.mocked(QemuService.doctor).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000 * 4);
    });

    expect(vi.mocked(QemuService.doctor).mock.calls.length).toBe(callsAfterSwitch);
    expect(screen.getByText(QEMU_PANEL)).toBeTruthy();
    expect(backgroundBar()?.textContent).toContain("QEMU 节点 仍在执行");
  });

  it("takes the mounted-but-hidden panel out of layout through the CSS rule", async () => {
    // The hide step is CSS-only on purpose: a wrapper element around a panel
    // would break the `.page-fade > div` scoping the track layouts rely on.
    // That makes the rule itself the contract, so assert it against the real
    // stylesheet and the real DOM shape (there is no other guard for it).
    const { readFileSync } = await import("node:fs");
    const style = document.createElement("style");
    style.textContent = readFileSync("src/styles/global.css", "utf8");
    document.head.appendChild(style);
    const probe = document.createElement("div");
    probe.innerHTML =
      '<div class="app-shell page-qemu"><div class="main-area"><div class="content">' +
      '<div class="page-fade">' +
      '<div class="runtime-shell" data-inactive-track="docker"></div>' +
      '<div id="probe-docker"></div>' +
      '<div id="probe-qemu" class="page-qemu"></div>' +
      "</div></div></div></div>";
    document.body.appendChild(probe);
    const hiddenDocker = document.getElementById("probe-docker") as HTMLElement;
    const activeQemu = document.getElementById("probe-qemu") as HTMLElement;
    const shell = probe.querySelector(".runtime-shell") as HTMLElement;
    try {
      // Docker hidden behind the active QEMU track: display:none, i.e. no
      // second scroll container and no extra layout box.
      expect(getComputedStyle(hiddenDocker).display).toBe("none");
      expect(getComputedStyle(activeQemu).display).not.toBe("none");

      // And the other way round: only the reported-inactive track disappears.
      shell.setAttribute("data-inactive-track", "qemu");
      expect(getComputedStyle(activeQemu).display).toBe("none");
      expect(getComputedStyle(hiddenDocker).display).not.toBe("none");
    } finally {
      probe.remove();
      style.remove();
    }
  });

  it("tags the shared status line with the track it came from", async () => {
    vi.mocked(DeviceService.refreshDockerInfo).mockRejectedValue(new Error("engine down"));
    renderShell("/containers?track=docker");
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(useAppStore.getState().statusText).toContain("刷新失败"));

    const { statusText } = useAppStore.getState();
    expect(statusText.startsWith("本机 Docker · ")).toBe(true);

    // The QEMU track renders its own in-panel status line and never writes the
    // shared one, so the tagged Docker text cannot be overwritten by a switch.
    fireEvent.click(screen.getByRole("tab", { name: "QEMU 节点" }));
    await flush();
    expect(useAppStore.getState().statusText).toBe(statusText);
  });
});

describe("legacy routes", () => {
  it("redirects the old /docker bookmark onto the Docker track", async () => {
    window.location.hash = "#/docker";
    render(<App />);
    await flush();

    expect(window.location.hash).toBe("#/containers?track=docker");
    expectOnlyDockerPanel();
    // The shell keeps handing the active track's page scope class to
    // `.app-shell`, and the panel root stays the direct child of `.page-fade`
    // (global.css scopes each track's layout through exactly that depth).
    expect(document.querySelector(".app-shell")?.className).toContain("page-docker");
    expect(fadeChildren()).toHaveLength(2);
  });

  it("redirects the old /qemu bookmark onto the QEMU track", async () => {
    window.location.hash = "#/qemu";
    render(<App />);
    await flush();

    expect(window.location.hash).toBe("#/containers?track=qemu");
    expectOnlyQemuPanel();
    expect(document.querySelector(".app-shell")?.className).toContain("page-qemu");
    const children = fadeChildren();
    expect(children).toHaveLength(2);
    expect(children[1].classList.contains("page-qemu")).toBe(true);
  });

  it("keeps the unchanged sidebar entries landing on their track", async () => {
    window.location.hash = "#/containers?track=qemu";
    render(<App />);
    await flush();
    expectOnlyQemuPanel();

    fireEvent.click(screen.getByRole("link", { name: "Docker" }));
    await flush();

    expect(window.location.hash).toBe("#/containers?track=docker");
    expectOnlyDockerPanel();
  });
});
