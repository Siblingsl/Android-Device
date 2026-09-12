import { describe, expect, it } from "vitest";
import { createScheduledTask, dueTasks, markTaskRun, nextRunAfter, prepareScheduledTask, recordScheduledResult } from "../src/lib/scheduler";

describe("scheduler", () => {
  it("calculates local daily and interval runs", () => {
    const from = new Date(2026, 8, 11, 8, 30);
    const daily = createScheduledTask({ kind: "daily", time: "09:00" });
    expect(nextRunAfter(daily, from)?.getHours()).toBe(9);
    const interval = createScheduledTask({ kind: "interval", intervalMinutes: 10, lastRun: from.toISOString() });
    expect(nextRunAfter(interval, from)?.getMinutes()).toBe(40);
  });

  it("marks a due one-time task disabled", () => {
    const task = createScheduledTask({ kind: "once", nextRun: "2026-09-11T09:00:00.000Z" });
    expect(dueTasks([task], new Date("2026-09-11T10:00:00.000Z"))).toHaveLength(1);
    expect(markTaskRun(task, new Date("2026-09-11T10:00:00.000Z")).enabled).toBe(false);
  });

  it("does not return a task that is already running", () => {
    const task = createScheduledTask({ id: "running-task", kind: "once", nextRun: "2026-09-11T09:00:00.000Z" });
    const running = new Set([task.id]);
    expect(dueTasks([task], new Date("2026-09-11T10:00:00.000Z"), running)).toEqual([]);
  });

  it("supports five-field local cron and keeps execution history", () => {
    const from = new Date(2026, 8, 11, 8, 29, 30);
    const task = createScheduledTask({ kind: "cron", cronExpression: "30 8 * * 5" });
    expect(nextRunAfter(task, from)?.getHours()).toBe(8);
    expect(nextRunAfter(task, from)?.getMinutes()).toBe(30);
    expect(recordScheduledResult([task], task.id, false, "设备离线")[0].history[0].message).toBe("设备离线");
  });

  it("restores a missing next run after app restart", () => {
    const task = createScheduledTask({ kind: "daily", time: "08:30", nextRun: "" });
    const prepared = prepareScheduledTask(task, new Date(2026, 8, 11, 7, 0));
    expect(prepared.nextRun).toBe(new Date(2026, 8, 11, 8, 30).toISOString());
  });
});
