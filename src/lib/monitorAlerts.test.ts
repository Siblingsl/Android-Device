import { describe, expect, it } from "vitest";
import {
  appendMonitorAlert,
  evaluateResourceAlert,
  type MonitorAlert,
  type ResourceAlertTracker,
} from "./monitorAlerts";

describe("evaluateResourceAlert", () => {
  it("emits the first active resource alert", () => {
    const result = evaluateResourceAlert(
      { active: null, lastEmittedAt: null },
      "cpu",
      1_000,
    );

    expect(result.emit).toBe(true);
    expect(result.tracker).toEqual({ active: "cpu", lastEmittedAt: 1_000 });
  });

  it("suppresses the same alert during the cooldown window", () => {
    const previous: ResourceAlertTracker = { active: "cpu", lastEmittedAt: 1_000 };

    const result = evaluateResourceAlert(previous, "cpu", 59_999);

    expect(result.emit).toBe(false);
    expect(result.tracker).toEqual(previous);
  });

  it("emits after cooldown, recovery, or an alert type change", () => {
    const active: ResourceAlertTracker = { active: "cpu", lastEmittedAt: 1_000 };

    expect(evaluateResourceAlert(active, "cpu", 61_000).emit).toBe(true);
    expect(evaluateResourceAlert(active, null, 2_000)).toEqual({
      emit: false,
      tracker: { active: null, lastEmittedAt: null },
    });
    expect(evaluateResourceAlert(active, "memory", 2_000).emit).toBe(true);
  });
});

describe("appendMonitorAlert", () => {
  it("prepends a new alert and keeps only the newest eight records", () => {
    const existing: MonitorAlert[] = Array.from({ length: 8 }, (_, index) => ({
      id: `alert-${index}`,
      kind: "cpu",
      createdAt: index,
    }));

    const result = appendMonitorAlert(existing, {
      id: "alert-new",
      kind: "memory",
      createdAt: 99,
    });

    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({ id: "alert-new", kind: "memory", createdAt: 99 });
    expect(result[result.length - 1]?.id).toBe("alert-6");
  });
});
