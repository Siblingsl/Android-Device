import { describe, expect, it, vi } from "vitest";
import { executeCopilotToolCall } from "./copilotToolExecutor";

vi.mock("./deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn().mockResolvedValue([{ id: "d1", name: "Pixel", serial: "serial-1", online: true }]),
    listFiles: vi.fn().mockResolvedValue([{ name: "demo.txt", path: "/sdcard/demo.txt" }]),
    screenshot: vi.fn().mockResolvedValue({ success: true, path: "C:/shot.png", base64: "" }),
    shell: vi.fn().mockResolvedValue({ success: true, stdout: "ok", stderr: "", exitCode: 0 }),
    startApp: vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 }),
    startAppOnDisplay: vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 }),
    stopApp: vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 }),
  },
}));

const { DeviceService } = await import("./deviceService");

describe("copilot tool executor", () => {
  it("executes read-only device queries through DeviceService", async () => {
    const result = await executeCopilotToolCall({ toolId: "devices.list", args: {} }, "serial-1");

    expect(DeviceService.listDevices).toHaveBeenCalledTimes(1);
    expect(result).toContain("Pixel");
  });

  it("maps a confirmed write tool to the existing command", async () => {
    const result = await executeCopilotToolCall({ toolId: "device.startApp", args: { packageName: "com.demo" } }, "serial-1");

    expect(DeviceService.startApp).toHaveBeenCalledWith("serial-1", "com.demo");
    expect(result).toContain("成功");
  });

  it("maps the display launch tool to the selected display", async () => {
    const result = await executeCopilotToolCall({ toolId: "device.startAppOnDisplay", args: { packageName: "com.demo", displayId: 2 } }, "serial-1");

    expect(DeviceService.startAppOnDisplay).toHaveBeenCalledWith("serial-1", "com.demo", 2);
    expect(result).toContain("成功");
  });

  it("routes expanded read and app-control tools through DeviceService", async () => {
    const result = await executeCopilotToolCall({ toolId: "device.files", args: { path: "/sdcard" } }, "serial-1");

    expect(DeviceService.listFiles).toHaveBeenCalledWith("serial-1", "/sdcard");
    expect(result).toContain("demo.txt");
    await executeCopilotToolCall({ toolId: "device.stopApp", args: { packageName: "com.demo" } }, "serial-1");
    expect(DeviceService.stopApp).toHaveBeenCalledWith("serial-1", "com.demo");
  });
});
