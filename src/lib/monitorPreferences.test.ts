import { describe, expect, it } from "vitest";
import {
  applyDeviceMonitorRule,
  normalizeMonitorPreferences,
  resolveDeviceMonitorPreferences,
  resourceAlertFor,
} from "./monitorPreferences";

describe("normalizeMonitorPreferences", () => {
  it("uses stable defaults when preferences are missing", () => {
    expect(normalizeMonitorPreferences()).toEqual({
      alertThreshold: 80,
      refreshIntervalSecs: 10,
    });
  });

  it("clamps unsafe threshold and refresh interval values", () => {
    expect(normalizeMonitorPreferences(120, 2)).toEqual({
      alertThreshold: 100,
      refreshIntervalSecs: 5,
    });
    expect(normalizeMonitorPreferences(20, 90)).toEqual({
      alertThreshold: 50,
      refreshIntervalSecs: 60,
    });
  });
});

describe("resourceAlertFor", () => {
  it("identifies CPU, memory, and combined threshold breaches", () => {
    expect(resourceAlertFor(80, 60, 80)).toBe("cpu");
    expect(resourceAlertFor(60, 80, 80)).toBe("memory");
    expect(resourceAlertFor(80, 80, 80)).toBe("both");
    expect(resourceAlertFor(79.9, 79.9, 80)).toBeNull();
  });
});

describe("resolveDeviceMonitorPreferences", () => {
  it("inherits normalized global preferences when a device has no rule", () => {
    expect(resolveDeviceMonitorPreferences(72, 12)).toEqual({
      preset: "inherit",
      alertThreshold: 72,
      refreshIntervalSecs: 12,
    });
  });

  it("uses stable values for each preset instead of stale stored numbers", () => {
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "sensitive",
      alertThreshold: 99,
      refreshIntervalSecs: 59,
    })).toEqual({ preset: "sensitive", alertThreshold: 65, refreshIntervalSecs: 5 });
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "balanced",
      alertThreshold: 50,
      refreshIntervalSecs: 60,
    })).toEqual({ preset: "balanced", alertThreshold: 80, refreshIntervalSecs: 10 });
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "relaxed",
      alertThreshold: 50,
      refreshIntervalSecs: 5,
    })).toEqual({ preset: "relaxed", alertThreshold: 90, refreshIntervalSecs: 20 });
  });

  it("clamps custom device values and falls back to globals for invalid numbers", () => {
    expect(resolveDeviceMonitorPreferences(74, 16, {
      preset: "custom",
      alertThreshold: 40,
      refreshIntervalSecs: 90,
    })).toEqual({ preset: "custom", alertThreshold: 50, refreshIntervalSecs: 60 });
    expect(resolveDeviceMonitorPreferences(74, 16, {
      preset: "custom",
      alertThreshold: Number.NaN,
      refreshIntervalSecs: Number.NaN,
    })).toEqual({ preset: "custom", alertThreshold: 74, refreshIntervalSecs: 16 });
  });

  it("falls back to inheritance for an unknown persisted preset", () => {
    expect(resolveDeviceMonitorPreferences(76, 14, {
      preset: "unknown",
      alertThreshold: 60,
      refreshIntervalSecs: 5,
    } as never)).toEqual({ preset: "inherit", alertThreshold: 76, refreshIntervalSecs: 14 });
  });
});

describe("applyDeviceMonitorRule", () => {
  const existing = {
    "device-a": { preset: "balanced" as const, alertThreshold: 80, refreshIntervalSecs: 10 },
    "device-b": { preset: "relaxed" as const, alertThreshold: 90, refreshIntervalSecs: 20 },
  };

  it("removes only the target override when the device inherits global settings", () => {
    expect(applyDeviceMonitorRule(existing, "device-a", {
      preset: "inherit",
      alertThreshold: 75,
      refreshIntervalSecs: 15,
    })).toEqual({
      "device-b": { preset: "relaxed", alertThreshold: 90, refreshIntervalSecs: 20 },
    });
    expect(existing).toHaveProperty("device-a");
  });

  it("stores a normalized override without changing other devices", () => {
    expect(applyDeviceMonitorRule(existing, "device-a", {
      preset: "custom",
      alertThreshold: 73,
      refreshIntervalSecs: 12,
    })).toEqual({
      "device-a": { preset: "custom", alertThreshold: 73, refreshIntervalSecs: 12 },
      "device-b": { preset: "relaxed", alertThreshold: 90, refreshIntervalSecs: 20 },
    });
  });
});
