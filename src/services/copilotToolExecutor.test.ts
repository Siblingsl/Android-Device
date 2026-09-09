import { describe, expect, it, vi } from "vitest";
import { executeCopilotToolCall } from "./copilotToolExecutor";

vi.mock("./deviceService", () => ({
  DeviceService: {
    listDevices: vi.fn().mockResolvedValue([{ id: "d1", name: "Pixel", serial: "serial-1", online: true }]),
    screenshot: vi.fn().mockResolvedValue({ success: true, path: "C:/shot.png", base64: "" }),
    shell: vi.fn().mockResolvedValue({ success: true, stdout: "ok", stderr: "", exitCode: 0 }),
    startApp: vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 }),
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
});
