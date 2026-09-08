import { describe, expect, it } from "vitest";
import {
  applyDeviceMonitorRule,
  isWithinMonitorQuietHours,
  normalizeMonitorPreferences,
  normalizeMonitorQuietHours,
  resolveDeviceMonitorPreferences,
  resourceAlertFor,
  shouldSuppressMonitorAlert,
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
      alertsEnabled: true,
      quietHours: null,
    });
  });

  it("uses stable values for each preset instead of stale stored numbers", () => {
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "sensitive",
      alertThreshold: 99,
      refreshIntervalSecs: 59,
    })).toEqual({
      preset: "sensitive",
      alertThreshold: 65,
      refreshIntervalSecs: 5,
      alertsEnabled: true,
      quietHours: null,
    });
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "balanced",
      alertThreshold: 50,
      refreshIntervalSecs: 60,
    })).toEqual({
      preset: "balanced",
      alertThreshold: 80,
      refreshIntervalSecs: 10,
      alertsEnabled: true,
      quietHours: null,
    });
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "relaxed",
      alertThreshold: 50,
      refreshIntervalSecs: 5,
    })).toEqual({
      preset: "relaxed",
      alertThreshold: 90,
      refreshIntervalSecs: 20,
      alertsEnabled: true,
      quietHours: null,
    });
  });

  it("clamps custom device values and falls back to globals for invalid numbers", () => {
    expect(resolveDeviceMonitorPreferences(74, 16, {
      preset: "custom",
      alertThreshold: 40,
      refreshIntervalSecs: 90,
    })).toEqual({
      preset: "custom",
      alertThreshold: 50,
      refreshIntervalSecs: 60,
      alertsEnabled: true,
      quietHours: null,
    });
    expect(resolveDeviceMonitorPreferences(74, 16, {
      preset: "custom",
      alertThreshold: Number.NaN,
      refreshIntervalSecs: Number.NaN,
    })).toEqual({
      preset: "custom",
      alertThreshold: 74,
      refreshIntervalSecs: 16,
      alertsEnabled: true,
      quietHours: null,
    });
  });

  it("preserves notification overrides while inheriting global thresholds", () => {
    expect(resolveDeviceMonitorPreferences(80, 10, {
      preset: "inherit",
      alertsEnabled: false,
      quietStart: "22:00",
      quietEnd: "06:30",
    })).toEqual({
      preset: "inherit",
      alertThreshold: 80,
      refreshIntervalSecs: 10,
      alertsEnabled: false,
      quietHours: { start: "22:00", end: "06:30" },
    });
  });

  it("falls back to inheritance for an unknown persisted preset", () => {
    expect(resolveDeviceMonitorPreferences(76, 14, {
      preset: "unknown",
      alertThreshold: 60,
      refreshIntervalSecs: 5,
    } as never)).toEqual({
      preset: "inherit",
      alertThreshold: 76,
      refreshIntervalSecs: 14,
      alertsEnabled: true,
      quietHours: null,
    });
  });
});

describe("monitor quiet hours", () => {
  it("accepts valid times and rejects incomplete or unsafe ranges", () => {
    expect(normalizeMonitorQuietHours("22:00", "06:30")).toEqual({
      start: "22:00",
      end: "06:30",
    });
    expect(normalizeMonitorQuietHours("22:00", "22:00")).toBeNull();
    expect(normalizeMonitorQuietHours("22:00", "bad")).toBeNull();
    expect(normalizeMonitorQuietHours("", "06:30")).toBeNull();
  });

  it("handles both same-day and cross-midnight ranges", () => {
    const daytime = normalizeMonitorQuietHours("09:00", "18:00");
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 8, 12, 0), daytime)).toBe(true);
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 8, 18, 0), daytime)).toBe(false);

    const overnight = normalizeMonitorQuietHours("22:00", "06:30");
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 8, 23, 0), overnight)).toBe(true);
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 9, 6, 29), overnight)).toBe(true);
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 9, 6, 30), overnight)).toBe(false);
    expect(isWithinMonitorQuietHours(new Date(2026, 8, 9, 12, 0), overnight)).toBe(false);
  });

  it("suppresses alerts when disabled or during configured quiet hours", () => {
    const quietHours = { start: "22:00", end: "06:30" };
    expect(shouldSuppressMonitorAlert({ alertsEnabled: false, quietHours }, new Date(2026, 8, 8, 12, 0))).toBe(true);
    expect(shouldSuppressMonitorAlert({ alertsEnabled: true, quietHours }, new Date(2026, 8, 8, 23, 0))).toBe(true);
    expect(shouldSuppressMonitorAlert({ alertsEnabled: true, quietHours }, new Date(2026, 8, 8, 12, 0))).toBe(false);
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
      alertsEnabled: true,
      quietHours: null,
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
      alertsEnabled: true,
      quietHours: null,
    })).toEqual({
      "device-a": {
        preset: "custom",
        alertThreshold: 73,
        refreshIntervalSecs: 12,
        alertsEnabled: true,
      },
      "device-b": { preset: "relaxed", alertThreshold: 90, refreshIntervalSecs: 20 },
    });
  });

  it("stores notification-only overrides while inheriting global thresholds", () => {
    expect(applyDeviceMonitorRule(existing, "device-a", {
      preset: "inherit",
      alertThreshold: 80,
      refreshIntervalSecs: 10,
      alertsEnabled: false,
      quietHours: { start: "22:00", end: "06:30" },
    })).toEqual({
      "device-a": {
        preset: "inherit",
        alertsEnabled: false,
        quietStart: "22:00",
        quietEnd: "06:30",
      },
      "device-b": { preset: "relaxed", alertThreshold: 90, refreshIntervalSecs: 20 },
    });
  });
});
