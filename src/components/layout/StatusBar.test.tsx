// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import type { MonitorAlert } from "../../lib/monitorAlerts";
import { I18nProvider } from "../../i18n";
import { StatusBar } from "./StatusBar";

const alertFor = (id: string): MonitorAlert => ({
  id,
  deviceId: "device-a",
  deviceName: "Device A",
  kind: "cpu",
  createdAt: Number(id.replace("alert-", "")),
});

function renderStatusBar() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <StatusBar />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("StatusBar monitor alert undo", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
    useAppStore.setState({
      devices: [],
      monitorAlerts: [],
      lastDismissedMonitorAlerts: null,
      monitorAlertUndoKind: null,
      monitorAlertUndoExpiresAt: null,
      statusText: "Ready",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the Chinese undo label with a live countdown and restores on click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useAppStore.getState().addMonitorAlert(alertFor("alert-1000"));
    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);

    renderStatusBar();

    expect(screen.getByRole("button", { name: "撤销关闭（10秒）" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByRole("button", { name: "撤销关闭（9秒）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "撤销关闭（9秒）" }));

    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.id)).toEqual(["alert-1000"]);
    expect(screen.queryByRole("button", { name: /撤销关闭/ })).toBeNull();
    expect(screen.getByText("已恢复 1 条告警")).toBeTruthy();
  });

  it("switches the undo label to English", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    localStorage.setItem("rdc.lang", "en-US");
    useAppStore.getState().addMonitorAlert(alertFor("alert-1000"));
    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);

    renderStatusBar();

    expect(screen.getByRole("button", { name: "Undo dismiss (10s)" })).toBeTruthy();
  });

  it("hides the undo action and clears the snapshot after ten seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useAppStore.getState().addMonitorAlert(alertFor("alert-1000"));
    useAppStore.getState().clearMonitorAlerts();

    renderStatusBar();
    expect(screen.getByRole("button", { name: "撤销清空（10秒）" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.queryByRole("button", { name: /撤销清空/ })).toBeNull();
    expect(useAppStore.getState().lastDismissedMonitorAlerts).toBeNull();
    expect(useAppStore.getState().monitorAlertUndoExpiresAt).toBeNull();
  });
});
