import { describe, expect, it, vi } from "vitest";
import { createAutomationScript } from "./automation";
import { createAutomationRunSession, runAutomationBatch, runAutomationScript, runAutomationStep, type AutomationRuntime } from "./automationRunner";

function runtime(calls: string[]): AutomationRuntime {
  return {
    tap: async (_serial, x, y) => { calls.push(`tap:${x},${y}`); },
    swipe: async (_serial, x1, y1, x2, y2, duration) => { calls.push(`swipe:${x1},${y1},${x2},${y2},${duration}`); },
    longPress: async (_serial, x, y, duration) => { calls.push(`long:${x},${y},${duration}`); },
    text: async (_serial, value) => { calls.push(`text:${value}`); },
    keyevent: async (_serial, code) => { calls.push(`key:${code}`); },
    shell: async (_serial, command) => { calls.push(`shell:${command}`); },
    screenshot: async (_serial, path) => { calls.push(`shot:${path}`); },
    launch: async (_serial, packageName) => { calls.push(`launch:${packageName}`); },
    install: async (_serial, path) => { calls.push(`install:${path}`); },
    record: async (_serial, outputPath, durationSeconds) => { calls.push(`record:${outputPath}:${durationSeconds}`); },
  };
}

describe("automation runner", () => {
  it("runs enabled steps in order and expands variables", async () => {
    const calls: string[] = [];
    const script = createAutomationScript({
      id: "script-1",
      name: "巡检",
      steps: [
        { id: "tap", kind: "tap", label: "点按", enabled: true, params: { x: 10, y: 20 } },
        { id: "skip", kind: "wait", label: "跳过", enabled: false, params: { milliseconds: 0 } },
        { id: "shell", kind: "shell", label: "命令", enabled: true, params: { command: "echo ${device}" } },
        { id: "shot", kind: "screenshot", label: "截图", enabled: true, params: { outputPath: "${out}" } },
      ],
    });

    const result = await runAutomationScript(script, "serial-1", runtime(calls), { variables: { device: "pixel", out: "C:/shot.png" } });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(3);
    expect(calls).toEqual(["tap:10,20", "shell:echo pixel", "shot:C:/shot.png"]);
  });

  it("continues after an opted-in failure and records the failed step", async () => {
    const calls: string[] = [];
    const adapter = runtime(calls);
    adapter.shell = vi.fn(async () => { throw new Error("shell failed"); });
    const script = createAutomationScript({
      id: "script-2",
      name: "容错",
      steps: [
        { id: "bad", kind: "shell", label: "会失败", enabled: true, continueOnError: true, params: { command: "bad" } },
        { id: "good", kind: "tap", label: "继续", enabled: true, params: { x: 1, y: 2 } },
      ],
    });

    const result = await runAutomationScript(script, "serial-1", adapter);

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(1);
    expect(calls).toEqual(["tap:1,2"]);
    expect(result.logs.some((entry) => entry.status === "failed" && entry.stepId === "bad")).toBe(true);
  });

  it("honors cancellation before a device action starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const script = createAutomationScript({
      id: "script-3",
      name: "取消",
      steps: [{ id: "tap", kind: "tap", label: "点按", enabled: true, params: { x: 1, y: 2 } }],
    });

    const result = await runAutomationScript(script, "serial-1", runtime(calls), { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("pauses between steps and resumes through the execution session", async () => {
    const calls: string[] = [];
    const session = createAutomationRunSession();
    session.pause();
    const script = createAutomationScript({
      id: "script-4",
      name: "暂停",
      steps: [{ id: "tap", kind: "tap", label: "点按", enabled: true, params: { x: 1, y: 2 } }],
    });
    const pending = runAutomationScript(script, "serial-1", runtime(calls), { session });
    await Promise.resolve();
    expect(calls).toEqual([]);
    session.resume();
    await pending;
    expect(calls).toEqual(["tap:1,2"]);
  });

  it("runs multiple devices with a bounded concurrency", async () => {
    const active: string[] = [];
    let maxActive = 0;
    const script = createAutomationScript({
      id: "script-5",
      name: "批量巡检",
      steps: [{ id: "shell", kind: "shell", label: "命令", enabled: true, params: { command: "echo ok" } }],
    });
    const makeRuntime = (): AutomationRuntime => ({
      ...runtime([]),
      shell: async (serial) => {
        active.push(serial);
        maxActive = Math.max(maxActive, active.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.splice(active.indexOf(serial), 1);
      },
    });

    const result = await runAutomationBatch(script, ["one", "two", "three"], makeRuntime, { concurrency: 2 });

    expect(result.status).toBe("completed");
    expect(result.results.map((entry) => entry.serial)).toEqual(["one", "two", "three"]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("runs only the requested step for single-step preview", async () => {
    const calls: string[] = [];
    const script = createAutomationScript({
      id: "script-6",
      name: "单步",
      steps: [
        { id: "one", kind: "tap", label: "第一步", enabled: true, params: { x: 1, y: 2 } },
        { id: "two", kind: "tap", label: "第二步", enabled: true, params: { x: 3, y: 4 } },
      ],
    });

    const result = await runAutomationStep(script, "serial-1", 1, runtime(calls));

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["tap:3,4"]);
  });
});
