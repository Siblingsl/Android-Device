export type DeviceHealthState = "healthy" | "offline" | "adb" | "container";

export interface DeviceHealthInput {
  online: boolean;
  adbStatus: string;
  containerId: string;
  dockerStatus: string;
}

export interface DeviceHealthSummary {
  state: DeviceHealthState;
  online: boolean;
  adbReady: boolean;
  containerReady: boolean;
}

function isContainerRunning(status: string): boolean {
  const value = status.trim().toLowerCase();
  if (!value || value === "n/a" || value === "unknown") return false;
  if (/(exited|stopped|dead|created|paused|restarting|not running|down)/.test(value)) return false;
  return value.includes("up") || value.includes("running");
}

export function summarizeDeviceHealth(input: DeviceHealthInput): DeviceHealthSummary {
  const adbReady = input.online && input.adbStatus === "device";
  const containerReady = !input.containerId || isContainerRunning(input.dockerStatus);

  let state: DeviceHealthState = "healthy";
  if (!input.online) state = "offline";
  else if (!adbReady) state = "adb";
  else if (!containerReady) state = "container";

  return { state, online: input.online, adbReady, containerReady };
}
