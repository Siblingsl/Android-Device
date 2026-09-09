import { describe, expect, it } from "vitest";
import { authorizeCopilotToolCall, COPILOT_TOOLS } from "./copilotTools";

describe("copilot tool safety", () => {
  it("allows read-only tools by default", () => {
    const result = authorizeCopilotToolCall(
      { toolId: "devices.list", args: {} },
      { allowedToolIds: ["devices.list"], confirmed: false },
    );

    expect(result).toEqual({ status: "allowed", tool: expect.objectContaining({ id: "devices.list" }) });
  });

  it("requires explicit confirmation before write operations", () => {
    const result = authorizeCopilotToolCall(
      { toolId: "device.installApk", args: { path: "C:/demo.apk" } },
      { allowedToolIds: ["device.installApk"], confirmed: false },
    );

    expect(result.status).toBe("confirmation_required");
  });

  it("blocks dangerous shell commands even when the tool is enabled", () => {
    const result = authorizeCopilotToolCall(
      { toolId: "device.shell", args: { command: "rm -rf /data/local/tmp" } },
      { allowedToolIds: ["device.shell"], confirmed: true },
    );

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toContain("危险");
  });

  it("keeps a visible registry for the settings page", () => {
    expect(COPILOT_TOOLS.some((tool) => tool.id === "device.screenshot")).toBe(true);
    expect(COPILOT_TOOLS.some((tool) => tool.risk === "write")).toBe(true);
  });

  it("validates model arguments against the registered schema", () => {
    const result = authorizeCopilotToolCall(
      { toolId: "device.startApp", args: { packageName: "" } },
      { allowedToolIds: ["device.startApp"], confirmed: true },
    );

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toContain("参数缺失");
  });

  it("exposes concrete parameters to the model for expanded tools", () => {
    const files = COPILOT_TOOLS.find((tool) => tool.id === "device.files");
    expect(files?.parameters.properties.path.type).toBe("string");
    expect(COPILOT_TOOLS.some((tool) => tool.id === "device.volumeUp")).toBe(true);
  });

  it("requires a package and display id for display app launch", () => {
    const tool = COPILOT_TOOLS.find((entry) => entry.id === "device.startAppOnDisplay");
    expect(tool?.parameters.required).toEqual(["packageName", "displayId"]);
    expect(tool?.requiresConfirmation).toBe(true);
  });

  it("blocks an invalid display id before confirmation", () => {
    const result = authorizeCopilotToolCall(
      { toolId: "device.startAppOnDisplay", args: { packageName: "com.demo", displayId: 101 } },
      { allowedToolIds: ["device.startAppOnDisplay"], confirmed: true },
    );

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toContain("显示屏编号");
  });
});
