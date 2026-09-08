import { describe, expect, it } from "vitest";
import { normalizeMonitorPreferences, resourceAlertFor } from "./monitorPreferences";

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
