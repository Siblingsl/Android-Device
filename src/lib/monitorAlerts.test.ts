import { describe, expect, it } from "vitest";
import {
  appendMonitorAlert,
  clearMonitorAlertsBefore,
  evaluateMonitorAlert,
  evaluateResourceAlert,
  filterMonitorAlerts,
  hasRecentMonitorAlert,
  monitorAlertMessageKey,
  parseStoredMonitorAlerts,
  removeMonitorAlertsByIds,
  runConfirmedMonitorAlertCleanup,
  serializeMonitorAlertsCsv,
  summarizeMonitorAlerts,
  summarizeMonitorAlertsByDevice,
  buildMonitorAlertTrend,
  type MonitorAlert,
  type MonitorAlertTracker,
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

describe("evaluateMonitorAlert", () => {
  it("emits when an active resource alert escalates from warning to critical", () => {
    const previous: MonitorAlertTracker = {
      active: { kind: "cpu", severity: "warning" },
      lastEmittedAt: 1_000,
    };

    const result = evaluateMonitorAlert(
      previous,
      { kind: "cpu", severity: "critical" },
      2_000,
    );

    expect(result.emit).toBe(true);
    expect(result.tracker).toEqual({
      active: { kind: "cpu", severity: "critical" },
      lastEmittedAt: 2_000,
    });
  });

  it("keeps the critical alert inside the cooldown window and resets after recovery", () => {
    const previous: MonitorAlertTracker = {
      active: { kind: "cpu", severity: "critical" },
      lastEmittedAt: 1_000,
    };

    expect(evaluateMonitorAlert(previous, { kind: "cpu", severity: "critical" }, 59_999).emit).toBe(false);
    expect(evaluateMonitorAlert(previous, null, 2_000)).toEqual({
      emit: false,
      tracker: { active: null, lastEmittedAt: null },
    });
  });
});

describe("appendMonitorAlert", () => {
  it("prepends a new alert and keeps only the newest eight records", () => {
    const existing: MonitorAlert[] = Array.from({ length: 8 }, (_, index) => ({
      id: `alert-${index}`,
      deviceId: "device-a",
      deviceName: "Device A",
      kind: "cpu",
      createdAt: index,
    }));

    const result = appendMonitorAlert(existing, {
      id: "alert-new",
      deviceId: "device-b",
      deviceName: "Device B",
      kind: "memory",
      createdAt: 99,
    });

    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({
      id: "alert-new",
      deviceId: "device-b",
      deviceName: "Device B",
      kind: "memory",
      createdAt: 99,
    });
    expect(result[result.length - 1]?.id).toBe("alert-6");
  });
});

describe("filterMonitorAlerts", () => {
  const now = 1_000_000;
  const alerts: MonitorAlert[] = [
    { id: "cpu-a", deviceId: "device-a", deviceName: "Device A", kind: "cpu", createdAt: now - 1_000 },
    { id: "memory-b", deviceId: "device-b", deviceName: "Device B", kind: "memory", createdAt: now - 2 * 86_400_000 },
    { id: "both-a", deviceId: "device-a", deviceName: "Device A", kind: "both", createdAt: now - 8 * 86_400_000 },
  ];

  it("filters by device, resource kind, and recent time window", () => {
    expect(
      filterMonitorAlerts(alerts, { deviceId: "device-a", kind: "both", timeRange: "all" }, now),
    ).toEqual([alerts[2]]);
    expect(
      filterMonitorAlerts(alerts, { deviceId: "all", kind: "all", timeRange: "24h" }, now),
    ).toEqual([alerts[0]]);
  });

  it("keeps newest records first when no filter is applied", () => {
    expect(
      filterMonitorAlerts(alerts, { deviceId: "all", kind: "all", timeRange: "all" }, now).map(
        (alert) => alert.id,
      ),
    ).toEqual(["cpu-a", "memory-b", "both-a"]);
  });

  it("filters by warning or critical severity while keeping all severities by default", () => {
    const critical = { ...alerts[0], id: "critical-a", severity: "critical" as const };
    expect(
      filterMonitorAlerts(
        [...alerts, critical],
        { deviceId: "all", kind: "all", severity: "critical", timeRange: "all" },
        now,
      ),
    ).toEqual([critical]);
    expect(
      filterMonitorAlerts(
        [...alerts, critical],
        { deviceId: "all", kind: "all", timeRange: "all" },
        now,
      ),
    ).toHaveLength(4);
  });

  it("filters an exact local calendar day while keeping adjacent days out", () => {
    const dayStart = new Date(2026, 8, 8).getTime();
    const sameDay = {
      id: "same-day",
      deviceId: "device-a",
      deviceName: "Device A",
      kind: "cpu" as const,
      createdAt: new Date(2026, 8, 8, 18, 0).getTime(),
    };
    const nextDay = { ...sameDay, id: "next-day", createdAt: new Date(2026, 8, 9, 0, 0).getTime() };
    const previousDay = { ...sameDay, id: "previous-day", createdAt: new Date(2026, 8, 7, 23, 59).getTime() };

    expect(
      filterMonitorAlerts(
        [sameDay, nextDay, previousDay],
        { deviceId: "all", kind: "all", timeRange: "24h", dayStart },
        new Date(2026, 8, 10, 12, 0).getTime(),
      ),
    ).toEqual([sameDay]);
  });

  it("searches device, resource, severity, and threshold fields without changing other filters", () => {
    const searchableAlerts: MonitorAlert[] = [
      { id: "cpu-lab", deviceId: "device-a", deviceName: "Lab One", kind: "cpu", createdAt: now, alertThreshold: 80 },
      { id: "critical-memory", deviceId: "device-b", deviceName: "Office Two", kind: "memory", severity: "critical", createdAt: now - 1_000, alertThreshold: 90 },
    ];

    expect(filterMonitorAlerts(searchableAlerts, { deviceId: "all", kind: "all", timeRange: "all", query: "office" }, now).map((alert) => alert.id)).toEqual(["critical-memory"]);
    expect(filterMonitorAlerts(searchableAlerts, { deviceId: "all", kind: "all", timeRange: "all", query: "critical" }, now).map((alert) => alert.id)).toEqual(["critical-memory"]);
    expect(filterMonitorAlerts(searchableAlerts, { deviceId: "all", kind: "all", timeRange: "all", query: "80" }, now).map((alert) => alert.id)).toEqual(["cpu-lab"]);
  });
});

describe("removeMonitorAlertsByIds", () => {
  it("removes only selected alerts and keeps the original list for an empty selection", () => {
    const alerts: MonitorAlert[] = [
      { id: "a", deviceId: "device-a", deviceName: "A", kind: "cpu", createdAt: 3 },
      { id: "b", deviceId: "device-b", deviceName: "B", kind: "memory", createdAt: 2 },
      { id: "c", deviceId: "device-c", deviceName: "C", kind: "both", createdAt: 1 },
    ];

    expect(removeMonitorAlertsByIds(alerts, ["a", "c"]).map((alert) => alert.id)).toEqual(["b"]);
    expect(removeMonitorAlertsByIds(alerts, [])).toEqual(alerts);
  });
});

describe("monitor alert summaries and trend", () => {
  it("counts resource kinds and treats legacy records as warning alerts", () => {
    expect(summarizeMonitorAlerts([
      { id: "cpu", deviceId: "a", deviceName: "A", kind: "cpu", createdAt: 1 },
      { id: "memory", deviceId: "a", deviceName: "A", kind: "memory", severity: "critical", createdAt: 2 },
      { id: "both", deviceId: "a", deviceName: "A", kind: "both", createdAt: 3 },
    ])).toEqual({ total: 3, cpu: 1, memory: 1, both: 1, warning: 2, critical: 1 });
  });

  it("builds seven-day local trend buckets with separate warning and critical counts", () => {
    const now = new Date(2026, 8, 8, 12, 0).getTime();
    const trend = buildMonitorAlertTrend([
      { id: "warning-today", deviceId: "a", deviceName: "A", kind: "cpu", createdAt: new Date(2026, 8, 8, 9, 0).getTime() },
      { id: "critical-today", deviceId: "a", deviceName: "A", kind: "memory", severity: "critical", createdAt: new Date(2026, 8, 8, 10, 0).getTime() },
      { id: "warning-yesterday", deviceId: "a", deviceName: "A", kind: "both", createdAt: new Date(2026, 8, 7, 10, 0).getTime() },
    ], now, 3);

    expect(trend).toEqual([
      { dayStart: new Date(2026, 8, 6).getTime(), warning: 0, critical: 0 },
      { dayStart: new Date(2026, 8, 7).getTime(), warning: 1, critical: 0 },
      { dayStart: new Date(2026, 8, 8).getTime(), warning: 1, critical: 1 },
    ]);
  });

  it("summarizes each device and marks a clear seven-day alert peak", () => {
    const now = new Date(2026, 8, 8, 12, 0).getTime();
    const today = new Date(2026, 8, 8, 9, 0).getTime();
    const yesterday = new Date(2026, 8, 7, 9, 0).getTime();
    const summaries = summarizeMonitorAlertsByDevice([
      { id: "a-1", deviceId: "a", deviceName: "Device A", kind: "cpu", createdAt: today },
      { id: "a-2", deviceId: "a", deviceName: "Device A", kind: "cpu", createdAt: today + 1_000 },
      { id: "a-3", deviceId: "a", deviceName: "Device A", kind: "memory", createdAt: today + 2_000 },
      { id: "a-4", deviceId: "a", deviceName: "Device A", kind: "both", createdAt: today + 3_000 },
      { id: "a-5", deviceId: "a", deviceName: "Device A", kind: "cpu", createdAt: yesterday },
      { id: "b-1", deviceId: "b", deviceName: "Device B", kind: "memory", severity: "critical", createdAt: today },
      { id: "b-2", deviceId: "b", deviceName: "Device B", kind: "memory", severity: "critical", createdAt: today + 1_000 },
    ], now);

    expect(summaries.find((summary) => summary.deviceId === "a")).toEqual({
      deviceId: "a",
      deviceName: "Device A",
      total: 5,
      warning: 5,
      critical: 0,
      peakDayStart: new Date(2026, 8, 8).getTime(),
      peakCount: 4,
      peakIsAnomaly: true,
    });
    expect(summaries.find((summary) => summary.deviceId === "b")).toEqual({
      deviceId: "b",
      deviceName: "Device B",
      total: 2,
      warning: 0,
      critical: 2,
      peakDayStart: new Date(2026, 8, 8).getTime(),
      peakCount: 2,
      peakIsAnomaly: false,
    });
  });
});

describe("monitorAlertMessageKey", () => {
  it("maps each resource alert kind to its localized message key", () => {
    expect(monitorAlertMessageKey("cpu")).toBe("detail.monitor.alert.resourceCpu");
    expect(monitorAlertMessageKey("memory")).toBe("detail.monitor.alert.resourceMemory");
    expect(monitorAlertMessageKey("both")).toBe("detail.monitor.alert.resourceBoth");
  });
});

describe("hasRecentMonitorAlert", () => {
  it("detects only the same device and alert kind inside the cooldown window", () => {
    const existing: MonitorAlert = {
      id: "alert-1000",
      deviceId: "device-a",
      deviceName: "Device A",
      kind: "cpu",
      createdAt: 1_000,
    };

    expect(
      hasRecentMonitorAlert([existing], { ...existing, id: "alert-2000", createdAt: 2_000 }),
    ).toBe(true);
    expect(
      hasRecentMonitorAlert([
        existing,
      ], { ...existing, id: "alert-61000", createdAt: 61_000 }),
    ).toBe(false);
    expect(
      hasRecentMonitorAlert(
        [existing],
        { ...existing, id: "alert-memory", kind: "memory", createdAt: 2_000 },
      ),
    ).toBe(false);
    expect(
      hasRecentMonitorAlert(
        [existing],
        { ...existing, id: "alert-critical", severity: "critical", createdAt: 2_000 },
      ),
    ).toBe(false);
  });
});

describe("parseStoredMonitorAlerts", () => {
  it("restores valid alerts newest first and ignores malformed persisted entries", () => {
    const result = parseStoredMonitorAlerts(JSON.stringify([
      { id: "older", deviceId: "device-a", deviceName: "Device A", kind: "cpu", createdAt: 1_000 },
      { id: "invalid-kind", deviceId: "device-a", deviceName: "Device A", kind: "disk", createdAt: 2_000 },
      { id: "newer", deviceId: "device-b", deviceName: "Device B", kind: "memory", severity: "critical", createdAt: 3_000, alertThreshold: 75 },
      { id: "bad-threshold", deviceId: "device-c", deviceName: "Device C", kind: "both", createdAt: 2_500, alertThreshold: "75" },
      null,
    ]));

    expect(result.map((alert) => [alert.id, alert.alertThreshold, alert.severity])).toEqual([
      ["newer", 75, "critical"],
      ["bad-threshold", undefined, "warning"],
      ["older", undefined, "warning"],
    ]);
  });

  it("returns an empty history for corrupt persisted data", () => {
    expect(parseStoredMonitorAlerts("not-json")).toEqual([]);
    expect(parseStoredMonitorAlerts(JSON.stringify({ alerts: [] }))).toEqual([]);
  });

  it("caps restored history to the newest fifty alerts", () => {
    const stored = Array.from({ length: 55 }, (_, index) => ({
      id: `alert-${index}`,
      deviceId: "device-a",
      deviceName: "Device A",
      kind: "cpu",
      createdAt: index,
    }));

    const result = parseStoredMonitorAlerts(JSON.stringify(stored));

    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe("alert-54");
    expect(result[49]?.id).toBe("alert-5");
  });
});

describe("clearMonitorAlertsBefore", () => {
  it("removes only alerts older than the selected cutoff", () => {
    const alerts: MonitorAlert[] = [
      { id: "at-cutoff", deviceId: "a", deviceName: "A", kind: "cpu", createdAt: 2_000 },
      { id: "older", deviceId: "b", deviceName: "B", kind: "memory", createdAt: 1_999 },
      { id: "newer", deviceId: "c", deviceName: "C", kind: "both", createdAt: 3_000 },
    ];

    expect(clearMonitorAlertsBefore(alerts, 2_000).map((alert) => alert.id)).toEqual([
      "at-cutoff",
      "newer",
    ]);
  });
});

describe("serializeMonitorAlertsCsv", () => {
  it("exports stable timestamps and escapes device fields for spreadsheet import", () => {
    const alerts: MonitorAlert[] = [
      {
        id: "alert-1",
        deviceId: "device,1",
        deviceName: 'Lab "A"',
        kind: "both",
        createdAt: Date.UTC(2026, 8, 8, 1, 2, 3),
        alertThreshold: 75,
        severity: "critical",
      },
    ];

    expect(serializeMonitorAlertsCsv(alerts)).toBe(
      '\uFEFFtimestamp,device_name,device_id,resource,severity,alert_threshold\r\n2026-09-08T01:02:03.000Z,"Lab ""A""","device,1",both,critical,75',
    );
  });
});

describe("runConfirmedMonitorAlertCleanup", () => {
  it("keeps history unchanged when cleanup is not confirmed", async () => {
    let cleared = false;

    const completed = await runConfirmedMonitorAlertCleanup(
      async () => false,
      () => {
        cleared = true;
      },
    );

    expect(completed).toBe(false);
    expect(cleared).toBe(false);
  });

  it("runs cleanup once after confirmation", async () => {
    let clearCount = 0;

    const completed = await runConfirmedMonitorAlertCleanup(
      async () => true,
      () => {
        clearCount += 1;
      },
    );

    expect(completed).toBe(true);
    expect(clearCount).toBe(1);
  });
});
