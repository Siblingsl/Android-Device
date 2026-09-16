// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import type { DashboardData, ReadinessItem } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getDashboard: vi.fn(),
    readinessChecklist: vi.fn(async () => [] as ReadinessItem[]),
  },
}));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

const { DeviceService } = await import("../services/deviceService");

const mockStoreState = vi.hoisted(() => ({
  monitorAlerts: [] as Array<{
    id: string;
    deviceId: string;
    deviceName: string;
    kind: "cpu" | "memory" | "both";
    createdAt: number;
    severity: "warning" | "critical";
    alertThreshold: number;
  }>,
  setSelectedDeviceId: vi.fn(),
  setStatusText: vi.fn(),
}));

/** Shows the router's current location so tests can assert a jump target. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const dashboard = (message: string, cpuUsage: number): DashboardData => ({
  status: {
    dockerRunning: true,
    dockerVersion: "Docker 27",
    adbRunning: true,
    adbVersion: "Android Debug Bridge 1.0",
    onlineDevices: 0,
    cpuUsage,
    memoryUsage: 32,
    memoryTotalMb: 16_384,
    memoryUsedMb: 5_242,
  },
  devices: [],
  recentLogs: [],
  recentScreenshots: [],
  recentApks: [],
  notifications: [message],
});

describe("Dashboard refresh ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getDashboard).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the newer scheduled refresh when the initial request resolves later", async () => {
    const initial = deferred<DashboardData>();
    const scheduled = deferred<DashboardData>();
    vi.mocked(DeviceService.getDashboard)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(scheduled.promise);

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(DeviceService.getDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(DeviceService.getDashboard).toHaveBeenCalledTimes(2);

    await act(async () => {
      scheduled.resolve(dashboard("新统计结果", 12));
      await scheduled.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/新统计结果/)).toBeTruthy();

    await act(async () => {
      initial.resolve(dashboard("旧统计结果", 88));
      await initial.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/旧统计结果/)).toBeNull();
    expect(screen.getByText(/新统计结果/)).toBeTruthy();
  });
});

describe("Dashboard monitor summary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getDashboard).mockReset();
    vi.mocked(DeviceService.getDashboard).mockResolvedValue(dashboard("ok", 5));
    vi.mocked(DeviceService.readinessChecklist).mockReset();
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([]);
    mockStoreState.monitorAlerts = [];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("summarizes cross-device alerts and opens the full alert history", async () => {
    mockStoreState.monitorAlerts = [
      {
        id: "alert-critical",
        deviceId: "device-a",
        deviceName: "redroid-a",
        kind: "both",
        createdAt: Date.now(),
        severity: "critical",
        alertThreshold: 80,
      },
      {
        id: "alert-warning",
        deviceId: "device-b",
        deviceName: "redroid-b",
        kind: "cpu",
        createdAt: Date.now() - 60_000,
        severity: "warning",
        alertThreshold: 85,
      },
    ];

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/monitor" element={<div data-testid="monitor-page">monitor-history</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("资源告警")).toBeTruthy();
    expect(screen.getByText("2 条")).toBeTruthy();
    expect(screen.getByText("redroid-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看全部告警" }));
    expect(screen.getByTestId("monitor-page")).toBeTruthy();
  });
});

describe("Dashboard readiness checklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getDashboard).mockReset();
    vi.mocked(DeviceService.getDashboard).mockResolvedValue(dashboard("ok", 5));
    vi.mocked(DeviceService.readinessChecklist).mockReset();
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const item = (id: string, done: boolean, cta = "/docker"): ReadinessItem => ({
    id,
    title: id,
    done,
    hint: done ? "" : `fix ${id}`,
    cta,
  });

  it("keeps a recheck entry and marks every ready item as available", async () => {
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      { ...item("docker", true), status: "ready", track: "docker", detail: "Docker is ready" },
      { ...item("adb", true), status: "ready", track: "shared" },
    ]);
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("首次使用环境已准备")).toBeTruthy();
    expect(screen.getAllByText(/环境已就绪/).length).toBe(2);
    expect(screen.getByRole("button", { name: "重新检查" })).toBeTruthy();
  });

  it("renders unsupported and unknown with different labels and details", async () => {
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      { ...item("scrcpy", false, "/settings"), status: "unsupported", track: "shared", detail: "Not supported here" },
      { ...item("whpx", false, "/qemu"), status: "unknown", track: "qemu", detail: "Probe timed out" },
    ]);
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText(/不支持/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/无法判定/).length).toBeGreaterThan(0);
    expect(screen.getByText("Not supported here")).toBeTruthy();
    expect(screen.getByText("Probe timed out")).toBeTruthy();
  });

  it("rechecks only the readiness snapshot when the user asks", async () => {
    vi.mocked(DeviceService.readinessChecklist)
      .mockResolvedValueOnce([item("docker", false)])
      .mockResolvedValueOnce([item("docker", true)]);
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.readinessChecklist).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(DeviceService.readinessChecklist).toHaveBeenCalledTimes(2);
  });

  it("renders pending items with hints and a per-item jump", async () => {
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      item("docker", true),
      item("adb", false, "/adb"),
    ]);
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/adb" element={<div>adb-page-probe</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The card renders with the pending count and the done item shows green.
    expect(screen.getByText("首次使用待办（1 项未完成）")).toBeTruthy();
    expect(screen.getByText("fix adb")).toBeTruthy();
    // Clicking the jump routes to the checklist target.
    fireEvent.click(screen.getAllByRole("button", { name: "去处理" })[0]);
    expect(screen.getByText("adb-page-probe")).toBeTruthy();
  });

  it("resolves a legacy checklist target onto the merged runtime route", async () => {
    // The backend still emits `/docker` / `/qemu` as `ReadinessItem.cta`
    // (readiness.rs, untouched this round); P4 sends those clicks to the merged
    // page instead of bouncing off the redirect.
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      item("docker", false, "/docker"),
    ]);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/containers" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "去处理" })[0]);
    expect(screen.getByTestId("location").textContent).toBe("/containers?track=docker");
  });
});
