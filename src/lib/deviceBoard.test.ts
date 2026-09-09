import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "../types";
import { deviceCapabilitySummary, groupDevicesForBoard } from "./deviceBoard";

const device = (id: string, overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id,
  name: `设备 ${id}`,
  serial: `${id}-serial`,
  androidVersion: "13",
  online: false,
  cpu: "2",
  ram: "2g",
  fps: 60,
  adbStatus: "offline",
  scrcpyStatus: "stopped",
  dockerStatus: "running",
  ip: "",
  mac: "",
  resolution: "1080x1920",
  dpi: "320",
  containerId: `container-${id}`,
  image: "redroid:13",
  startedAt: "",
  uptime: "",
  adbPort: 5555,
  scrcpyPort: 5556,
  ...overrides,
});

describe("device board grouping", () => {
  it("uses adb readiness as the online lane and keeps unauthorized devices separate", () => {
    expect(
      groupDevicesForBoard([
        device("ready", { online: true, adbStatus: "device" }),
        device("auth", { online: true, adbStatus: "unauthorized" }),
        device("offline", { online: false, adbStatus: "offline" }),
      ]),
    ).toMatchObject({
      online: [{ id: "ready" }],
      attention: [{ id: "auth" }],
      offline: [{ id: "offline" }],
    });
  });

  it("does not invent telemetry that is not present on the device model", () => {
    expect(deviceCapabilitySummary(device("plain"))).toEqual({
      telemetry: "unavailable",
      scrcpy: "stopped",
      adb: "offline",
    });
  });
});
