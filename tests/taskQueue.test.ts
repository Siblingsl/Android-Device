import { describe, expect, it } from "vitest";
import { runTaskQueue } from "../src/lib/taskQueue";

describe("runTaskQueue", () => {
  it("returns an independent result for every item", async () => {
    const task = runTaskQueue(
      ["online", "offline", "retry"],
      async (item) => {
        if (item === "offline") throw new Error("需在线");
        return `${item}:ok`;
      },
      { concurrency: 2 },
    );

    const result = await task.done;

    expect(result.results).toEqual([
      { item: "online", status: "fulfilled", value: "online:ok" },
      { item: "offline", status: "rejected", reason: "需在线" },
      { item: "retry", status: "fulfilled", value: "retry:ok" },
    ]);
    expect(result.cancelled).toBe(false);
  });

  it("does not start new work after cancellation", async () => {
    const started: number[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const task = runTaskQueue(
      [1, 2, 3],
      async (item) => {
        started.push(item);
        if (item === 1) await first;
        return item;
      },
      { concurrency: 1 },
    );

    await Promise.resolve();
    task.cancel();
    releaseFirst();
    const result = await task.done;

    expect(started).toEqual([1]);
    expect(result.cancelled).toBe(true);
    expect(result.results).toEqual([
      { item: 1, status: "fulfilled", value: 1 },
      { item: 2, status: "cancelled" },
      { item: 3, status: "cancelled" },
    ]);
  });

  it("reports active and completed progress for each queue phase", async () => {
    const progress: Array<{ completed: number; active: number; item?: string }> = [];
    const task = runTaskQueue(
      ["a", "b"],
      async (item) => item.toUpperCase(),
      {
        concurrency: 1,
        onProgress: (next) => progress.push({ completed: next.completed, active: next.active, item: next.item }),
      },
    );

    await task.done;

    expect(progress[0]).toEqual({ completed: 0, active: 1, item: "a" });
    expect(progress.at(-1)).toEqual({ completed: 2, active: 0, item: "b" });
  });
});
