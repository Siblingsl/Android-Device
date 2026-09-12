import type { DeviceInfo } from "../types";

export type DeviceBoardLane = "online" | "attention" | "offline";

export type DeviceBoardGroups = Record<DeviceBoardLane, DeviceInfo[]>;

export type DeviceCapabilitySummary = {
  telemetry: "available" | "unavailable";
  scrcpy: DeviceInfo["scrcpyStatus"];
  adb: string;
};

export function isDeviceOnline(device: DeviceInfo): boolean {
  return device.online && device.adbStatus === "device";
}

export function deviceLaneFor(device: DeviceInfo): DeviceBoardLane {
  if (isDeviceOnline(device)) return "online";
  if (device.adbStatus === "unauthorized" || device.adbStatus === "authorizing") {
    return "attention";
  }
  return "offline";
}

export function groupDevicesForBoard(devices: DeviceInfo[]): DeviceBoardGroups {
  return devices.reduce<DeviceBoardGroups>(
    (groups, device) => {
      groups[deviceLaneFor(device)].push(device);
      return groups;
    },
    { online: [], attention: [], offline: [] },
  );
}

export function deviceCapabilitySummary(device: DeviceInfo): DeviceCapabilitySummary {
  const hasTelemetry =
    typeof device.cpuUsage === "number" ||
    typeof device.memoryUsage === "number" ||
    typeof device.memoryTotalMb === "number" ||
    typeof device.memoryUsedMb === "number";

  return {
    telemetry: hasTelemetry ? "available" : "unavailable",
    scrcpy: device.scrcpyStatus,
    adb: device.adbStatus,
  };
}
