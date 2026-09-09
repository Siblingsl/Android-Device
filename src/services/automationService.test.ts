import { describe, expect, it, vi } from "vitest";
import { createDeviceAutomationRuntime } from "./automationService";

vi.mock("./deviceService", () => ({
  DeviceService: {
    tap: vi.fn().mockResolvedValue({ success: true }),
    swipe: vi.fn().mockResolvedValue({ success: true }),
    longPress: vi.fn().mockResolvedValue({ success: true }),
    text: vi.fn().mockResolvedValue({ success: true }),
    keyevent: vi.fn().mockResolvedValue({ success: true }),
    shell: vi.fn().mockResolvedValue({ success: true }),
    screenshot: vi.fn().mockResolvedValue({ success: true, path: "C:/shot.png", base64: "" }),
    startApp: vi.fn().mockResolvedValue({ success: true }),
    startAppOnDisplay: vi.fn().mockResolvedValue({ success: true }),
    installApk: vi.fn().mockResolvedValue({ success: true }),
    scrcpyStartRecording: vi.fn().mockResolvedValue({ success: true }),
    scrcpyStopRecording: vi.fn().mockResolvedValue({ success: true }),
  },
}));
vi.mock("../lib/imageMatcher", () => ({
  matchScreenshotToTemplate: vi.fn().mockResolvedValue({ matched: true, score: 0.98, x: 11, y: 22 }),
}));

const { DeviceService } = await import("./deviceService");

describe("device automation runtime", () => {
  it("maps automation actions to existing DeviceService commands", async () => {
    const runtime = createDeviceAutomationRuntime();

    await runtime.tap("serial-1", 10, 20);
    await runtime.shell("serial-1", "echo ok");
    await runtime.screenshot("serial-1", "C:/shot.png");

    expect(DeviceService.tap).toHaveBeenCalledWith("serial-1", 10, 20);
    expect(DeviceService.shell).toHaveBeenCalledWith("serial-1", "echo ok");
    expect(DeviceService.screenshot).toHaveBeenCalledWith("serial-1");
  });

  it("turns a failed backend result into a rejected automation action", async () => {
    vi.mocked(DeviceService.tap).mockResolvedValueOnce({ success: false, stderr: "拒绝执行" } as never);
    const runtime = createDeviceAutomationRuntime();

    await expect(runtime.tap("serial-1", 1, 2)).rejects.toThrow("拒绝执行");
  });

  it("matches a template against a fresh device screenshot", async () => {
    const runtime = createDeviceAutomationRuntime();

    await expect(runtime.imageMatch?.("serial-1", "C:/template.png", 0.9)).resolves.toEqual({ matched: true, score: 0.98, x: 11, y: 22 });
    expect(DeviceService.screenshot).toHaveBeenCalledWith("serial-1");
  });

  it("routes an optional display id to the display launch command", async () => {
    const runtime = createDeviceAutomationRuntime();

    await runtime.launch("serial-1", "com.demo", 2);

    expect(DeviceService.startAppOnDisplay).toHaveBeenCalledWith("serial-1", "com.demo", 2);
  });
});
