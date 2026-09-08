import { describe, expect, it } from "vitest";
import { summarizeDeviceHealth } from "./deviceMonitor";

const base = {
  online: true,
  adbStatus: "device",
  containerId: "container-1",
  dockerStatus: "Up 2 minutes",
};

describe("summarizeDeviceHealth", () => {
  it("marks an online device with a running container as healthy", () => {
    expect(summarizeDeviceHealth(base)).toEqual({
      state: "healthy",
      online: true,
      adbReady: true,
      containerReady: true,
    });
  });

  it("exposes offline and dependency failures without hiding the other checks", () => {
    expect(
      summarizeDeviceHealth({ ...base, online: false, adbStatus: "disconnected" }),
    ).toEqual({
      state: "offline",
      online: false,
      adbReady: false,
      containerReady: true,
    });

    expect(summarizeDeviceHealth({ ...base, adbStatus: "offline" }).state).toBe("adb");
    expect(summarizeDeviceHealth({ ...base, dockerStatus: "Exited (0)" }).state).toBe("container");
  });

  it("does not require Docker for a standalone ADB device", () => {
    expect(
      summarizeDeviceHealth({
        online: true,
        adbStatus: "device",
        containerId: "",
        dockerStatus: "n/a",
      }),
    ).toEqual({
      state: "healthy",
      online: true,
      adbReady: true,
      containerReady: true,
    });
  });
});
