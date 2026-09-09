// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LogsPage } from "./Logs";
import type { LogEntry } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../lib/dialogs", () => ({ askConfirm: vi.fn() }));
vi.mock("../services/deviceService", () => ({
  DeviceService: {
    getLogs: vi.fn(),
  },
}));

const { DeviceService } = await import("../services/deviceService");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const log = (id: string, message: string): LogEntry => ({
  id,
  timestamp: "2026-09-08 13:00:00",
  level: "INFO",
  source: "System",
  message,
});

describe("LogsPage refresh ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(DeviceService.getLogs).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ignores an older filter response that resolves after the newer filter", async () => {
    const first = deferred<LogEntry[]>();
    const second = deferred<LogEntry[]>();
    vi.mocked(DeviceService.getLogs)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(
      <MemoryRouter>
        <LogsPage />
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(DeviceService.getLogs).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "ADB" } });
    expect(DeviceService.getLogs).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve([log("old", "旧筛选结果")]);
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/旧筛选结果/)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(DeviceService.getLogs).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve([log("new", "新筛选结果")]);
      await second.promise;
    });
    expect(screen.getByText(/新筛选结果/)).toBeTruthy();
  });

  it("keeps the log workbench rails and log surface visible", async () => {
    vi.mocked(DeviceService.getLogs).mockResolvedValue([log("one", "日志内容")]);

    render(
      <MemoryRouter>
        <LogsPage />
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".log-workbench")).toBeTruthy();
    expect(document.querySelector(".log-filter-rail")).toBeTruthy();
    expect(document.querySelector(".log-action-rail")).toBeTruthy();
    expect(document.querySelector(".log-surface")).toBeTruthy();
    expect(document.querySelector(".log-status-rail")).toBeTruthy();
    expect(screen.getByRole("button", { name: /日志内容/ })).toBeTruthy();
  });
});
