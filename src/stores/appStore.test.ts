import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";
import type { MonitorAlert } from "../lib/monitorAlerts";

const alertFor = (deviceId: string, id: string): MonitorAlert => ({
  id,
  deviceId,
  deviceName: deviceId.toUpperCase(),
  kind: "cpu",
  createdAt: Number(id.replace("alert-", "")),
});

describe("app monitor alert state", () => {
  beforeEach(() => {
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
});
