import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import { MONITOR_ALERT_UNDO_WINDOW_MS, type MonitorAlert } from "../lib/monitorAlerts";

const MONITOR_ALERT_STORAGE_KEY = "rdc.monitorAlerts";

const alertFor = (deviceId: string, id: string): MonitorAlert => ({
  id,
  deviceId,
  deviceName: deviceId.toUpperCase(),
  kind: "cpu",
  createdAt: Number(id.replace("alert-", "")),
});

describe("app monitor alert state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    localStorage.clear();
    useAppStore.getState().clearMonitorAlerts();
  });

  it("stores alerts across devices and clears only the requested device", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1"));
    useAppStore.getState().addMonitorAlert(alertFor("device-b", "alert-2"));

    useAppStore.getState().clearMonitorAlerts("device-a");

    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.deviceId)).toEqual(["device-b"]);
  });

  it("does not duplicate the same device alert during the cooldown window", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-30000"));

    expect(useAppStore.getState().monitorAlerts).toHaveLength(1);
  });

  it("persists alert changes for the next app launch", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));

    expect(JSON.parse(localStorage.getItem(MONITOR_ALERT_STORAGE_KEY) ?? "[]")).toEqual([
      alertFor("device-a", "alert-1000"),
    ]);

    useAppStore.getState().dismissMonitorAlert("alert-1000");
    expect(localStorage.getItem(MONITOR_ALERT_STORAGE_KEY)).toBe("[]");
  });

  it("removes selected alerts in one persisted batch", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-b", "alert-2000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-c", "alert-3000"));

    useAppStore.getState().dismissMonitorAlerts(["alert-1000", "alert-3000"]);

    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.id)).toEqual(["alert-2000"]);
    expect(JSON.parse(localStorage.getItem(MONITOR_ALERT_STORAGE_KEY) ?? "[]").map((alert: MonitorAlert) => alert.id)).toEqual([
      "alert-2000",
    ]);
  });

  it("restores the last batch and clears the undo slot", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-b", "alert-2000"));
    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);

    expect(useAppStore.getState().restoreDismissedMonitorAlerts()).toBe(true);
    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.id)).toEqual([
      "alert-2000",
      "alert-1000",
    ]);
    expect(useAppStore.getState().lastDismissedMonitorAlerts).toBeNull();
    expect(useAppStore.getState().restoreDismissedMonitorAlerts()).toBe(false);
  });

  it("expires the undo slot after the timed restore window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));

    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);

    expect(useAppStore.getState().monitorAlertUndoExpiresAt).toBe(
      100_000 + MONITOR_ALERT_UNDO_WINDOW_MS,
    );

    vi.setSystemTime(100_000 + MONITOR_ALERT_UNDO_WINDOW_MS);
    expect(useAppStore.getState().restoreDismissedMonitorAlerts()).toBe(false);
    expect(useAppStore.getState().lastDismissedMonitorAlerts).toBeNull();
    expect(useAppStore.getState().monitorAlertUndoExpiresAt).toBeNull();
  });

  it("keeps only the newest batch in the undo slot", () => {
    vi.useFakeTimers();
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-b", "alert-2000"));

    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);
    useAppStore.getState().dismissMonitorAlerts(["alert-2000"]);

    expect(useAppStore.getState().restoreDismissedMonitorAlerts()).toBe(true);
    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.id)).toEqual(["alert-2000"]);
  });

  it("invalidates undo after clearing monitor history", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().dismissMonitorAlerts(["alert-1000"]);

    useAppStore.getState().clearMonitorAlerts();

    expect(useAppStore.getState().restoreDismissedMonitorAlerts()).toBe(false);
  });

  it("clears alerts older than a timestamp and persists the retained history", () => {
    useAppStore.getState().addMonitorAlert(alertFor("device-a", "alert-1000"));
    useAppStore.getState().addMonitorAlert(alertFor("device-b", "alert-70000"));

    useAppStore.getState().clearMonitorAlertsBefore(50_000);

    expect(useAppStore.getState().monitorAlerts.map((alert) => alert.id)).toEqual(["alert-70000"]);
    expect(JSON.parse(localStorage.getItem(MONITOR_ALERT_STORAGE_KEY) ?? "[]")).toEqual([
      alertFor("device-b", "alert-70000"),
    ]);
  });
});
