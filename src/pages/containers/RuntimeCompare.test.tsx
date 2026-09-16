// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
// Evaluated before the page tree on purpose: `appStore` and `i18n` form an
// import cycle (the store calls tStatic while initializing), and the Docker
// panel's chain reaches i18n first through `ui/ToolStatus`. Importing the store
// first keeps the cycle in the order the other page tests already rely on.
import { useAppStore } from "../../stores/appStore";
import RuntimeCompare from "./RuntimeCompare";
import RuntimePage from "./RuntimePage";
import type {
  AppSettings,
  DockerContainer,
  DockerInfo,
  QemuDoctorReport,
  QemuRedroidInstance,
  QemuVmEntry,
} from "../../types";
import type {
  DockerSourceReading,
  QemuSourceReading,
  RuntimeInstanceRow,
} from "../../lib/runtimeTrack";

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
    // Shell / appStore surface.
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getSystemStatus: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    listDevicesUnified: vi.fn(async () => []),
    appendLog: vi.fn(async () => undefined),
    // Docker panel's existing read-only surface.
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
    getCreateStage: vi.fn(),
    // Runtime write commands — the compare view must never reach any of them.
    createInstance: vi.fn(),
    cancelCreateInstance: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    restartContainer: vi.fn(),
    removeContainer: vi.fn(),
    cloneContainer: vi.fn(),
    renameContainer: vi.fn(),
    removeImage: vi.fn(),
    pruneDanglingImages: vi.fn(),
    removeVolume: vi.fn(),
    switchWslKernel: vi.fn(),
  },
  QemuService: {
    // Read-only surface used by the panels (and the reviewer's refresh path).
    doctor: vi.fn(),
    vmList: vi.fn(),
    redroidList: vi.fn(),
    verify: vi.fn(),
    // Write commands.
    vmCreate: vi.fn(),
    vmStart: vi.fn(),
    vmStop: vi.fn(),
    vmDelete: vi.fn(),
    vmSnapshot: vi.fn(),
    vmRestore: vi.fn(),
    redroidCreate: vi.fn(),
    redroidUpgrade: vi.fn(),
    redroidRestore: vi.fn(),
    guestWait: vi.fn(),
    setup: vi.fn(),
  },
}));

const { DeviceService, QemuService } = await import("../../services/deviceService");
const { probeTool } = await import("../../hooks/useToolProbe");

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

/**
 * Write commands of both tracks, listed explicitly (spec §9.10: the compare
 * view has no write path). A new write command added to either service has to be
 * listed here too, and the whitelist assertion below fails until it is — which
 * is the point: no write may slip through unnoticed.
 */
const WRITE_METHODS = [
  "DeviceService.createInstance",
  "DeviceService.cancelCreateInstance",
  "DeviceService.startContainer",
  "DeviceService.stopContainer",
  "DeviceService.restartContainer",
  "DeviceService.removeContainer",
  "DeviceService.cloneContainer",
  "DeviceService.renameContainer",
  "DeviceService.removeImage",
  "DeviceService.pruneDanglingImages",
  "DeviceService.removeVolume",
  "DeviceService.switchWslKernel",
  "QemuService.vmCreate",
  "QemuService.vmStart",
  "QemuService.vmStop",
  "QemuService.vmDelete",
  "QemuService.vmSnapshot",
  "QemuService.vmRestore",
  "QemuService.redroidCreate",
  "QemuService.redroidUpgrade",
  "QemuService.redroidRestore",
  "QemuService.setup",
] as const;

/**
 * Read-only surface the merged page may reach *at all*, including the panels'
 * pre-existing mount loads (the compare view itself calls none of them; the
 * "renders on its own" test below asserts exactly that). `updateSettings` is the
 * shell's track-memory preference write (P2) — a preference, not a runtime
 * command: no container, node or backend state is touched by it.
 */
const READ_ONLY_WHITELIST = new Set<string>([
  "DeviceService.getSettings",
  "DeviceService.updateSettings",
  "DeviceService.getSystemStatus",
  "DeviceService.listDevices",
  "DeviceService.listDevicesUnified",
  "DeviceService.appendLog",
  "DeviceService.refreshDockerInfo",
  "DeviceService.getWslKernelStatus",
  "DeviceService.getMagiskAssets",
  "DeviceService.getLocalGappsPath",
  "DeviceService.listSpoofProfiles",
  "DeviceService.spoofProfileUsage",
  "DeviceService.pathExists",
  "DeviceService.checkInstanceName",
  "DeviceService.checkAdbPort",
  "DeviceService.nextFreeAdbPort",
  "DeviceService.getCreateStage",
  "QemuService.doctor",
  "QemuService.vmList",
  "QemuService.redroidList",
]);

type SpyMap = Record<string, ReturnType<typeof vi.fn>>;

function serviceBag(): Array<[string, SpyMap[string]]> {
  const bag: Array<[string, SpyMap[string]]> = [];
  for (const [name, service] of [
    ["DeviceService", DeviceService],
    ["QemuService", QemuService],
  ] as const) {
    // `vi.mock` replaced every method with a spy; the declared module types do
    // not know that, hence the cast through `unknown`.
    for (const [method, fn] of Object.entries(service as unknown as SpyMap)) {
      bag.push([`${name}.${method}`, fn]);
    }
  }
  return bag;
}

/** Qualified names of every service method that was actually called. */
function calledMethods(): string[] {
  return serviceBag()
    .filter(([, fn]) => fn.mock.calls.length > 0)
    .map(([method]) => method);
}

/** Write commands that were called — the compare view must keep this empty. */
function writeMethodCalls(): string[] {
  const called = new Set(calledMethods());
  return WRITE_METHODS.filter((method) => called.has(method));
}

function totalCallCount(): number {
  return serviceBag().reduce((sum, [, fn]) => sum + fn.mock.calls.length, 0);
}

/** Calls that are not on the read-only whitelist (must stay empty). */
function unlistedCalls(): string[] {
  return calledMethods().filter((method) => !READ_ONLY_WHITELIST.has(method));
}

const dockerInfo: DockerInfo = {
  running: true,
  version: "27.0.0",
  images: [],
  containers: [],
  cpuUsage: 0,
  memoryUsage: 0,
};

const doctorEight: QemuDoctorReport = {
  stateDir: "C:/QemuCenter",
  checks: Array.from({ length: 8 }, (_, i) => ({
    id: `check-${i}`,
    title: `Check ${i}`,
    status: "ok",
    detail: "",
    fix: "",
  })),
};

const vmFixture = (name: string): QemuVmEntry => ({
  name,
  vcpus: 4,
  memMib: 4096,
  accel: "whpx",
  sshHostPort: 22300,
  adbPorts: [24500, 24501],
  adbAssignments: [],
});

const redroidFixture = (
  name: string,
  over: Partial<QemuRedroidInstance> = {},
): QemuRedroidInstance => ({
  instance: name,
  container: `qc-${name}`,
  port: 24500,
  serial: "127.0.0.1:24500",
  status: "Up 2 minutes",
  androidVersion: "13",
  image: "redroid/redroid:13.0.0-latest",
  rollbackAvailable: false,
  ...over,
});

const containerFixture = (name: string, over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: name,
  name,
  image: "redroid/redroid:13.0.0-latest",
  status: "Up 2 minutes",
  ports: "0.0.0.0:5555->5555/tcp",
  created: "2 minutes ago",
  isRedroid: true,
  ...over,
});

function dockerRow(
  name: string,
  over: Partial<RuntimeInstanceRow> = {},
): RuntimeInstanceRow {
  return {
    name,
    androidVersion: "",
    image: "redroid/redroid:13.0.0-latest",
    status: "Up 2 minutes",
    host: "",
    ...over,
  };
}

function qemuRow(name: string, over: Partial<RuntimeInstanceRow> = {}): RuntimeInstanceRow {
  return {
    name,
    androidVersion: "13",
    image: "redroid/redroid:13.0.0-latest",
    status: "Up 2 minutes",
    host: "node1",
    ...over,
  };
}

function dockerReading(
  instances: RuntimeInstanceRow[] | null,
  over: Partial<DockerSourceReading> = {},
): DockerSourceReading {
  return {
    at: Date.now(),
    running: true,
    containers: instances ? instances.length : null,
    cliAvailable: true,
    kernelBinderEnabled: true,
    instances,
    ...over,
  };
}

function qemuReading(
  instanceRows: RuntimeInstanceRow[] | null,
  over: Partial<QemuSourceReading> = {},
): QemuSourceReading {
  return {
    at: Date.now(),
    nodes: 1,
    instances: instanceRows ? instanceRows.length : null,
    scope: "node1",
    checks: { at: Date.now(), total: 8, ok: 8, fail: 0, other: 0 },
    cliError: "",
    instanceRows,
    ...over,
  };
}

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

function compareEl(): HTMLElement {
  return document.getElementById("runtime-panel-compare") as HTMLElement;
}

function panelEl(track: "docker" | "qemu"): HTMLElement | null {
  return document.getElementById(`runtime-panel-${track}`);
}

/** The compare view's own DOM only: the badges carry identically named buttons. */
function compare() {
  return within(compareEl());
}

function groupCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".runtime-compare-group")) as HTMLElement[];
}

/** The element of one metric cell (the cell state lives on its inner element). */
function cell(group: HTMLElement, metric: string, track: "docker" | "qemu"): HTMLElement {
  const td = group.querySelector(
    `tr[data-metric="${metric}"] td[data-track="${track}"]`,
  ) as HTMLElement | null;
  return (td?.querySelector("[data-cell]") as HTMLElement | null) ?? (td as HTMLElement);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Render the page, let the panels finish their mount loads, *then* install the
 * session snapshots. Order matters: the active track's panel republishes what it
 * read on mount, so a snapshot written before that would be overwritten — this
 * mirrors reality, where a track's snapshot is exactly what its own load
 * published.
 */
async function renderWithSnapshots(
  entry: string,
  sources: { docker: DockerSourceReading | null; qemu: QemuSourceReading | null },
) {
  const view = renderShell(entry);
  await flush();
  await act(async () => {
    useAppStore.setState({ runtimeSources: sources });
  });
  await flush();
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("rdc.lang", "zh-CN");
  useAppStore.setState({
    settings: { ...baseSettings },
    runtimeSources: { docker: null, qemu: null },
    qemuSetup: null,
    qemuWaitVm: null,
  });
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
  vi.mocked(DeviceService.checkInstanceName).mockResolvedValue(false);
  vi.mocked(DeviceService.checkAdbPort).mockResolvedValue(false);
  vi.mocked(QemuService.doctor).mockResolvedValue(doctorEight);
  vi.mocked(QemuService.vmList).mockResolvedValue([vmFixture("node1")]);
  vi.mocked(QemuService.redroidList).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("rdc.lang");
  vi.useRealTimers();
});

describe("compare view entry and deep links (P6)", () => {
  const bothTracks = {
    docker: dockerReading([dockerRow("rdc-1")]),
    qemu: qemuReading([qemuRow("qc-1")]),
  };

  it("replaces the panel area with the compare view and keeps ?track=", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", bothTracks);

    expect(currentLocation()).toBe("/containers?track=docker&view=compare");
    expect(compareEl()).toBeTruthy();
    // The panel stays mounted (its own state/cache must survive)…
    expect(panelEl("docker")).toBeTruthy();
    // …and the compare root is the visible tabpanel the tabs point at (the
    // mounted panel keeps its own tabpanel role; CSS takes it out of the a11y
    // tree while the compare view is shown — asserted in the CSS test below).
    expect(compareEl().getAttribute("role")).toBe("tabpanel");
    expect(compareEl().getAttribute("aria-labelledby")).toBe("runtime-tab-docker");
    expect(screen.getByRole("tab", { name: "本机 Docker" }).getAttribute("aria-controls")).toBe(
      "runtime-panel-compare",
    );
    // A following sibling of the shell: the hide rules and the `.page-fade > div`
    // layout treatment the panels get both depend on that position.
    expect(compareEl().previousElementSibling?.classList.contains("runtime-shell")).toBe(true);
  });

  it("enters from the track view and returns to the same track", async () => {
    renderShell("/containers?track=qemu");
    await flush();
    expect(compareEl()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "对比视图" }));
    await flush();
    expect(currentLocation()).toBe("/containers?track=qemu&view=compare");
    expect(compareEl()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "返回轨道" }));
    await flush();
    expect(currentLocation()).toBe("/containers?track=qemu");
    expect(compareEl()).toBeNull();
    expect(panelEl("qemu")).toBeTruthy();
  });

  it("leaves the compare view when a tab is picked (a tab shows that panel)", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", bothTracks);

    fireEvent.click(screen.getByRole("tab", { name: "QEMU 节点" }));
    await flush();

    expect(currentLocation()).toBe("/containers?track=qemu");
    expect(compareEl()).toBeNull();
    expect(panelEl("qemu")).toBeTruthy();
  });

  it("treats an unknown ?view= value as the track view and never loses ?track=", async () => {
    renderShell("/containers?track=qemu&view=podman");
    await flush();

    expect(compareEl()).toBeNull();
    expect(panelEl("qemu")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "QEMU 节点" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "对比视图" }));
    await flush();
    expect(currentLocation()).toBe("/containers?track=qemu&view=compare");
    expect(compareEl().getAttribute("aria-labelledby")).toBe("runtime-tab-qemu");
  });

  it("hides both panels through the CSS rule while the compare root stays visible", async () => {
    // The mechanism, asserted against the real stylesheet (like the P3 hide
    // rule): the compare root is a following sibling of the shell, so it must be
    // excluded from both hide rules.
    const { readFileSync } = await import("node:fs");
    const style = document.createElement("style");
    style.textContent = readFileSync("src/styles/global.css", "utf8");
    document.head.appendChild(style);
    const probe = document.createElement("div");
    probe.innerHTML =
      '<div class="app-shell page-docker"><div class="main-area"><div class="content">' +
      '<div class="page-fade">' +
      '<div class="runtime-shell" data-view="compare"></div>' +
      '<div id="probe-docker"></div>' +
      '<div id="probe-qemu" class="page-qemu"></div>' +
      '<div id="probe-compare" class="runtime-compare"></div>' +
      "</div></div></div></div>";
    document.body.appendChild(probe);
    const shell = probe.querySelector(".runtime-shell") as HTMLElement;
    const dockerPanel = document.getElementById("probe-docker") as HTMLElement;
    const qemuPanel = document.getElementById("probe-qemu") as HTMLElement;
    const compareRoot = document.getElementById("probe-compare") as HTMLElement;
    try {
      expect(getComputedStyle(dockerPanel).display).toBe("none");
      expect(getComputedStyle(qemuPanel).display).toBe("none");
      expect(getComputedStyle(compareRoot).display).not.toBe("none");

      // A hidden track with a running task also sets data-inactive-track; the
      // compare root has to survive that rule too.
      shell.setAttribute("data-inactive-track", "docker");
      expect(getComputedStyle(dockerPanel).display).toBe("none");
      expect(getComputedStyle(compareRoot).display).not.toBe("none");

      // Leaving the compare view gives both panels back.
      shell.removeAttribute("data-view");
      shell.removeAttribute("data-inactive-track");
      expect(getComputedStyle(dockerPanel).display).not.toBe("none");
      expect(getComputedStyle(compareRoot).display).not.toBe("none");
    } finally {
      probe.remove();
      style.remove();
    }
  });
});

describe("compare view grouping (P6)", () => {
  const grouped = {
    docker: dockerReading(
      [
        dockerRow("rdc-1"),
        dockerRow("rdc-2", { status: "Exited (0) 1 hour ago" }),
        dockerRow("rdc-9", { image: "redroid/redroid:14.0.0-latest" }),
      ],
      { containers: 5 },
    ),
    qemu: qemuReading([
      qemuRow("qc-1"),
      qemuRow("qc-2", { status: "Exited (0) 5 minutes ago" }),
    ]),
  };

  it("compares both tracks in one Android version group and labels single-track versions", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", grouped);

    const cards = groupCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Android 13");
    expect(cards[0].textContent).toContain("两轨对齐");
    expect(cards[0].textContent).toContain("13 · 13.0.0-latest");

    // Real numbers of both sides, with the running ratio and its bars.
    expect(cell(cards[0], "instances", "docker").textContent).toContain("2");
    expect(cell(cards[0], "instances", "qemu").textContent).toContain("2");
    expect(cell(cards[0], "running", "docker").textContent).toContain("1 / 2");
    const runningMeter = cell(cards[0], "running", "docker").querySelector('[role="meter"]');
    expect(runningMeter?.getAttribute("aria-valuenow")).toBe("50");
    expect(runningMeter?.getAttribute("aria-valuemax")).toBe("100");
    expect((runningMeter as HTMLElement).querySelector("span")?.style.width).toBe("50%");
    // Instance share of the group: 2 of 4.
    expect(
      cell(cards[0], "instances", "docker")
        .querySelector('[role="meter"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("50");

    // 14 only exists on the docker side: listed separately, labelled, and the
    // QEMU column states a *read* zero (data available, no instance of 14).
    expect(cards[1].textContent).toContain("Android 14");
    expect(cards[1].textContent).toContain("单轨独有 · 本机 Docker");
    expect(cell(cards[1], "instances", "docker").textContent).toContain("1");
    expect(cell(cards[1], "instances", "qemu").textContent).toContain("0");
    expect(cell(cards[1], "instances", "qemu").textContent).toContain("已读取，本组无实例");
  });

  it("lists the instances of each side in the group", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", grouped);

    const chips = (track: "docker" | "qemu") =>
      Array.from(
        groupCards()[0].querySelectorAll(
          `tr[data-metric="instancesList"] td[data-track="${track}"] .runtime-compare-chip`,
        ),
      ) as HTMLElement[];

    expect(chips("docker").map((chip) => chip.textContent)).toEqual(["rdc-1", "rdc-2"]);
    expect(chips("docker")[0].getAttribute("data-state")).toBe("up");
    expect(chips("docker")[1].getAttribute("data-state")).toBe("down");
    expect(chips("qemu").map((chip) => chip.textContent)).toEqual(["qc-1", "qc-2"]);
    // The node each instance lives on is part of the chip's tooltip.
    expect(chips("qemu")[0].getAttribute("title")).toContain("node1");
  });

  it("shows the cached health summary of both tracks on every group", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1")]),
      qemu: qemuReading([qemuRow("qc-1")]),
    });

    expect(cell(groupCards()[0], "health", "docker").textContent).toBe("正常");
    expect(cell(groupCards()[0], "health", "qemu").textContent).toContain("体检 8/8");
  });

  it("prints the raw version labels it grouped by", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1"), dockerRow("rdc-2", { image: "local/rdc" })]),
      qemu: null,
    });

    expect(groupCards().map((card) => card.textContent)).toEqual([
      expect.stringContaining("Android 13"),
      expect.stringContaining("未标注版本"),
    ]);
  });

  it("is fed by the panels' own existing reads — no seeding needed (P6 data path)", async () => {
    vi.mocked(DeviceService.refreshDockerInfo).mockResolvedValue({
      ...dockerInfo,
      containers: [
        containerFixture("rdc-1"),
        containerFixture("rdc-2", { image: "redroid/redroid:14.0.0-latest" }),
        // Neither redroid-named nor rdc-prefixed: the panel's own list leaves it
        // out, and so does the snapshot.
        containerFixture("nginx", { isRedroid: false, image: "nginx:latest" }),
      ],
    });
    vi.mocked(QemuService.vmList).mockResolvedValue([vmFixture("node1")]);
    vi.mocked(QemuService.redroidList).mockResolvedValue([redroidFixture("qc-1")]);

    // Visit the Docker track first, then the QEMU one: each panel publishes its
    // snapshot while it is mounted, and the cache survives the switch (P5).
    renderShell("/containers?track=docker");
    await flush();
    expect(useAppStore.getState().runtimeSources.docker?.instances?.map((row) => row.name)).toEqual([
      "rdc-1",
      "rdc-2",
    ]);
    expect(useAppStore.getState().runtimeSources.docker?.containers).toBe(3);

    fireEvent.click(screen.getByRole("tab", { name: "QEMU 节点" }));
    await flush();
    expect(useAppStore.getState().runtimeSources.qemu?.instanceRows?.map((row) => row.name)).toEqual([
      "qc-1",
    ]);

    const readsBefore = {
      docker: vi.mocked(DeviceService.refreshDockerInfo).mock.calls.length,
      nodes: vi.mocked(QemuService.vmList).mock.calls.length,
      instances: vi.mocked(QemuService.redroidList).mock.calls.length,
    };

    fireEvent.click(screen.getByRole("button", { name: "对比视图" }));
    await flush();

    // Both tracks' panels published it; entering the view reads nothing new.
    expect(vi.mocked(DeviceService.refreshDockerInfo).mock.calls.length).toBe(readsBefore.docker);
    expect(vi.mocked(QemuService.vmList).mock.calls.length).toBe(readsBefore.nodes);
    expect(vi.mocked(QemuService.redroidList).mock.calls.length).toBe(readsBefore.instances);
    expect(writeMethodCalls()).toEqual([]);

    expect(groupCards()).toHaveLength(2);
    expect(groupCards()[0].textContent).toContain("Android 13");
    expect(groupCards()[1].textContent).toContain("Android 14");
    // The docker group has both tracks' instances, the 14 group only docker's.
    expect(cell(groupCards()[0], "instances", "docker").textContent).toContain("1");
    expect(cell(groupCards()[0], "instances", "qemu").textContent).toContain("1");
    expect(groupCards()[1].textContent).toContain("单轨独有 · 本机 Docker");
    // Scope notes name what the snapshots cover (the filtered container count
    // and the QEMU panel's selected node).
    expect(compareEl().textContent).toContain("本机 Docker 共 3 个容器，其中 2 个参与对比");
    expect(compareEl().textContent).toContain("QEMU 侧仅含当前所选节点 node1 的实例");
  });
});

describe("compare view unavailable semantics (P6)", () => {
  function onlyGroup(): HTMLElement {
    return groupCards()[0];
  }

  it("states the reason instead of 0 when a track cannot be read", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading(null, { running: false, containers: null }),
      qemu: qemuReading([qemuRow("qc-1")]),
    });

    const instances = cell(onlyGroup(), "instances", "docker").textContent ?? "";
    const running = cell(onlyGroup(), "running", "docker").textContent ?? "";
    expect(instances).toContain("Docker 未启动");
    expect(running).toContain("Docker 未启动");
    expect(instances).not.toContain("0");
    expect(running).not.toContain("0");
    // The track strip states the same reason for the whole track.
    expect(compareEl().textContent).toContain("Docker 未启动");
    expect(compareEl().textContent).not.toContain("0 个实例");
  });

  it("states a missing CLI on the QEMU side and keeps the docker numbers", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1")]),
      qemu: qemuReading(null, { cliError: "qemu-center not found", instances: null }),
    });

    expect(cell(onlyGroup(), "instances", "qemu").textContent).toContain("CLI 缺失");
    expect(cell(onlyGroup(), "instances", "qemu").getAttribute("title")).toBe(
      "qemu-center not found",
    );
    expect(cell(onlyGroup(), "instances", "docker").textContent).toContain("1");
    expect(onlyGroup().textContent).toContain("无法判定（另一轨无数据）");
  });

  it("says 未读取 when the snapshot has no instance rows yet", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1")]),
      // A pre-P6 snapshot shape: counts but no rows.
      qemu: {
        at: Date.now(),
        nodes: 1,
        instances: 3,
        scope: "node1",
        checks: null,
        cliError: "",
      },
    });

    expect(cell(onlyGroup(), "instances", "qemu").textContent).toContain("未读取");
    expect(compareEl().textContent).not.toContain("3 个实例");
  });

  it("renders a precise unavailable reason when the snapshot has no metrics — never 0", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1")]),
      qemu: qemuReading([qemuRow("qc-1")]),
    });

    for (const metric of ["cpuQuota", "memQuota", "disk", "bootTime"]) {
      for (const track of ["docker", "qemu"] as const) {
        const el = cell(onlyGroup(), metric, track);
        expect(el.textContent).toBe("不可用（本次读取无指标）");
        expect(el.getAttribute("data-cell")).toBe("unavailable");
        expect(el.textContent).not.toContain("0");
      }
    }
    expect(cell(onlyGroup(), "cpuQuota", "docker").getAttribute("title")).toContain("docker inspect");
  });

  it("calls an unanswered node a missing reading, not 0 running", async () => {
    await renderWithSnapshots("/containers?track=docker&view=compare", {
      docker: dockerReading([dockerRow("rdc-1")]),
      qemu: qemuReading([qemuRow("qc-1", { status: "unknown" })]),
    });

    const running = cell(onlyGroup(), "running", "qemu");
    expect(running.textContent).toBe("不可用（节点未报告运行状态）");
    expect(running.getAttribute("data-cell")).toBe("unavailable");
    expect(running.getAttribute("title")).toBe("unknown");
    expect(running.textContent).not.toContain("0");
    // The instance count of that same read is still a real number.
    expect(cell(onlyGroup(), "instances", "qemu").textContent).toContain("1");
  });

  it("shows an explicit empty state when neither track has a usable snapshot", async () => {
    renderShell("/containers?track=docker&view=compare");
    await flush();

    expect(document.querySelector(".runtime-compare-empty")?.textContent).toContain(
      "暂无可对比的数据",
    );
    expect(compareEl().textContent).toContain("未读取");
    expect(groupCards()).toHaveLength(0);
  });
});

describe("compare view is read-only (P6, spec §9.10)", () => {
  it("calls no service at all when it renders — every method stays at 0", async () => {
    // Rendered on its own: any call would have to come from the compare view.
    useAppStore.setState({
      runtimeSources: {
        docker: dockerReading([dockerRow("rdc-1")]),
        qemu: qemuReading([qemuRow("qc-1")]),
      },
    });
    const onRefresh = vi.fn();
    render(<RuntimeCompare onRefresh={onRefresh} inPlace={{ docker: true, qemu: true }} />);
    await flush();

    expect(calledMethods()).toEqual([]);
    expect(totalCallCount()).toBe(0);
    expect(writeMethodCalls()).toEqual([]);
    expect(groupCards()).toHaveLength(1);
  });

  it("reaches only whitelisted read-only commands through the shell, and zero writes", async () => {
    vi.mocked(DeviceService.refreshDockerInfo).mockResolvedValue({
      ...dockerInfo,
      containers: [containerFixture("rdc-1")],
    });
    vi.mocked(QemuService.redroidList).mockResolvedValue([redroidFixture("qc-1")]);

    renderShell("/containers?track=docker&view=compare");
    await flush();

    // Entering the view triggers no QEMU read at all (that track is unmounted).
    expect(vi.mocked(QemuService.doctor).mock.calls.length).toBe(0);
    expect(vi.mocked(QemuService.vmList).mock.calls.length).toBe(0);
    expect(writeMethodCalls()).toEqual([]);
    expect(unlistedCalls()).toEqual([]);

    // Refresh both strips: one mounted (in place), one unmounted (mount = read).
    fireEvent.click(compare().getByRole("button", { name: "刷新来源：本机 Docker" }));
    await flush();
    expect(vi.mocked(DeviceService.refreshDockerInfo).mock.calls.length).toBeGreaterThan(1);

    fireEvent.click(compare().getByRole("button", { name: "刷新来源：QEMU 节点" }));
    await flush();
    await waitFor(() =>
      expect(vi.mocked(QemuService.redroidList).mock.calls.length).toBeGreaterThan(0),
    );

    expect(writeMethodCalls()).toEqual([]);
    expect(unlistedCalls()).toEqual([]);
  });

  it("does not poll: advancing the clock produces no service call", async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      runtimeSources: {
        docker: dockerReading([dockerRow("rdc-1")]),
        qemu: qemuReading([qemuRow("qc-1")]),
      },
    });
    renderShell("/containers?track=docker&view=compare");
    // Mount loads plus the panels' one-shot debounced probes (250 ms) settle
    // first, so the baseline below is a quiet page.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const before = totalCallCount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(totalCallCount()).toBe(before);
    expect(writeMethodCalls()).toEqual([]);
    expect(compareEl()).toBeTruthy();
  });

  it("delegates the refresh instead of reading: mounted keeps the view, unmounted mounts the track", async () => {
    vi.mocked(QemuService.redroidList).mockResolvedValue([redroidFixture("qc-1")]);
    vi.mocked(QemuService.vmList).mockResolvedValue([vmFixture("node1")]);
    renderShell("/containers?track=docker&view=compare");
    await flush();
    expect(panelEl("qemu")).toBeNull();

    // Unmounted track: the shell can only mount it — mounting is that read.
    fireEvent.click(compare().getByRole("button", { name: "刷新来源：QEMU 节点" }));
    await flush();
    await flush();

    expect(currentLocation()).toBe("/containers?track=qemu&view=compare");
    expect(compareEl()).toBeTruthy();
    expect(panelEl("qemu")).toBeTruthy();
    expect(vi.mocked(QemuService.redroidList).mock.calls.length).toBeGreaterThan(0);
    // …and the freshly published snapshot is what the view now renders.
    expect(compareEl().textContent).toContain("QEMU 侧仅含当前所选节点 node1 的实例");
  });

  it("keeps the mounted track's read in place, without changing the URL", async () => {
    renderShell("/containers?track=docker&view=compare");
    await flush();
    const readsBefore = vi.mocked(DeviceService.refreshDockerInfo).mock.calls.length;

    fireEvent.click(compare().getByRole("button", { name: "刷新来源：本机 Docker" }));
    await flush();

    expect(vi.mocked(DeviceService.refreshDockerInfo).mock.calls.length).toBe(readsBefore + 1);
    expect(currentLocation()).toBe("/containers?track=docker&view=compare");
  });
});

describe("compare view source-level guards (P6)", () => {
  const compareFiles = ["src/pages/containers/RuntimeCompare.tsx", "src/lib/runtimeCompare.ts"];

  /** Drop comments, so provenance notes may name the reads they describe. */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  it("never calls a service from the compare view files", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of compareFiles) {
      const code = codeOnly(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/DeviceService|QemuService|invoke\(|services\//);
    }
    // …and the shell keeps calling none either (the P1-P5 invariant the compare
    // view must not weaken), comments aside.
    const shell = codeOnly(readFileSync("src/pages/containers/RuntimePage.tsx", "utf8"));
    expect(shell).not.toMatch(/DeviceService|QemuService|invoke\(|services\//);
  });

  it("schedules no timer, so it cannot poll", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of compareFiles) {
      const code = codeOnly(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|setImmediate/);
    }
  });

  it("declares every compare key in both languages", async () => {
    const { runtimeZh, runtimeEn } = await import("../../i18n/pages/runtime");
    const zhKeys = Object.keys(runtimeZh).filter((key) => key.startsWith("runtime.compare."));
    const enKeys = Object.keys(runtimeEn).filter((key) => key.startsWith("runtime.compare."));
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(enKeys.sort()).toEqual(zhKeys.sort());
    for (const metric of ["cpuQuota", "memQuota", "disk", "bootTime"]) {
      expect(runtimeZh[`runtime.compare.gap.${metric}`]).toBeTruthy();
      expect(runtimeEn[`runtime.compare.gap.${metric}`]).toBeTruthy();
    }
  });
});
