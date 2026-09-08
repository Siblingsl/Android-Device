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
  runConfirmedMonitorAlertCleanup,
  serializeMonitorAlertsCsv,
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
