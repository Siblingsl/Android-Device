import { describe, expect, it, vi } from "vitest";
import {
  dispatchMcpRequest,
  getDeviceMcpTools,
  type McpRequest,
} from "../src/lib/mcpProtocol";

const device = { name: "测试设备", serial: "emulator-5554" };

describe("MCP device protocol", () => {
  it("exposes a discoverable tool list with input schemas", () => {
    const tools = getDeviceMcpTools(device);
    const shell = tools.find((tool) => tool.name === "shell");

    expect(tools.some((tool) => tool.name === "screenshot")).toBe(true);
    expect(tools.some((tool) => tool.name === "files_list")).toBe(true);
    expect(tools.some((tool) => tool.name === "apps_list")).toBe(true);
    expect(tools.some((tool) => tool.name === "batch_control")).toBe(true);
    expect(shell?.inputSchema.required).toEqual(["command"]);
    expect(shell?.annotations?.destructiveHint).toBe(true);
  });

  it("handles initialize and tools/list requests", async () => {
    const initialize = await dispatchMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { device },
    );
    const listed = await dispatchMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { device },
    );

    expect(initialize.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: { listChanged: false } },
    });
    expect((listed.result as { tools: unknown[] }).tools.length).toBeGreaterThan(5);
  });

  it("validates tool arguments before executing", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "keyevent", arguments: { code: "not-a-number" } },
      },
      { device, execute },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires confirmation for side-effecting tools", async () => {
    const execute = vi.fn().mockResolvedValue("Home 已完成");
    const confirm = vi.fn().mockResolvedValue(false);
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "device_control", arguments: { action: "home" } },
      },
      { device, execute, confirm },
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({ isError: true });
  });

  it("rejects an invalid batch serial list before execution", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "batch_control", arguments: { serials: [], action: "home" } },
      },
      { device, execute, confirm: vi.fn().mockResolvedValue(true) },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps renderer batch control inside the current device context", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "batch_control", arguments: { serials: ["other-device"], action: "home" } },
      },
      { device, allowedSerials: [device.serial], execute, confirm: vi.fn().mockResolvedValue(true) },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates optional app-list filters before execution", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "apps_list", arguments: { includeSystem: "yes" } },
      },
      { device, execute },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects arguments outside the advertised schema", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "screenshot", arguments: { unexpected: true } },
      },
      { device, execute },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects non-object arguments before execution", async () => {
    const execute = vi.fn();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "screenshot", arguments: [] as unknown as Record<string, unknown> },
      },
      { device, execute },
    );

    expect(response.result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
