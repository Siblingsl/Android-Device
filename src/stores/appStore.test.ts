import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import type { MonitorAlert } from "../lib/monitorAlerts";

const MONITOR_ALERT_STORAGE_KEY = "rdc.monitorAlerts";

const alertFor = (deviceId: string, id: string): MonitorAlert => ({
  id,
  deviceId,
  deviceName: deviceId.toUpperCase(),
  kind: "cpu",
  createdAt: Number(id.replace("alert-", "")),
});

describe("app monitor alert state", () => {
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
