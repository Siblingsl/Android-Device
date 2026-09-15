// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import type { DashboardData, ReadinessItem } from "../types";

vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getDashboard: vi.fn(),
    readinessChecklist: vi.fn(async () => [] as ReadinessItem[]),
  },
}));
vi.mock("../stores/appStore", () => ({
  useAppStore: (selector: (state: { setSelectedDeviceId: () => void; setStatusText: () => void }) => unknown) =>
    selector({ setSelectedDeviceId: () => {}, setStatusText: () => {} }),
}));

const { DeviceService } = await import("../services/deviceService");

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

describe("Dashboard readiness checklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getDashboard).mockReset();
    vi.mocked(DeviceService.getDashboard).mockResolvedValue(dashboard("ok", 5));
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

  it("hides the whole card when every checklist item is done", async () => {
    vi.mocked(DeviceService.readinessChecklist).mockResolvedValue([
      item("docker", true), item("adb", true),
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
    expect(screen.queryByText(/首次使用待办/)).toBeNull();
    expect(screen.queryByText("docker")).toBeNull();
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
});