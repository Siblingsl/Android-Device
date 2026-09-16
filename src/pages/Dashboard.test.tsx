// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
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

describe("Dashboard optional summaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getDashboard).mockReset();
    vi.mocked(DeviceService.getDashboard).mockResolvedValue(dashboard("ok", 5));
    vi.mocked(DeviceService.readinessChecklist).mockReset();
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([]);
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
    ];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not render the onboarding or monitor summaries on the Dashboard", async () => {
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      { id: "docker", title: "Docker", done: false, hint: "fix docker", cta: "/containers" },
    ]);
    render(<Dashboard />,
      { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("资源告警")).toBeNull();
    expect(screen.queryByText("首次使用待办（1 项未完成）")).toBeNull();
    expect(screen.queryByText("redroid-a")).toBeNull();
    expect(DeviceService.readinessChecklist).not.toHaveBeenCalled();
  });
});
