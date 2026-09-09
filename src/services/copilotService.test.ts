import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCopilotCompletion, runCopilotTask, type CopilotProviderConfig } from "./copilotService";
import { DeviceService } from "./deviceService";

const config: CopilotProviderConfig = {
  baseUrl: "https://example.test/v1/",
  apiKey: "secret-key",
  model: "demo-model",
  maxTokens: 512,
  timeoutMs: 5000,
};

describe("copilot service", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls an OpenAI-compatible endpoint and parses assistant tool calls", async () => {
    const completionMock = vi.spyOn(DeviceService, "copilotCompletion").mockResolvedValue({
      choices: [{ message: { content: "我先读取设备列表。", tool_calls: [{ id: "call-1", function: { name: "devices.list", arguments: "{}" } }] } }],
    });

    const result = await requestCopilotCompletion(config, [{ role: "user", content: "查看设备" }], ["devices.list"]);

    expect(result.content).toBe("我先读取设备列表。");
    expect(result.toolCalls).toEqual([{ id: "call-1", toolId: "devices.list", args: {} }]);
    expect(completionMock).toHaveBeenCalledWith(expect.objectContaining({ ...config, messages: expect.any(Array), tools: expect.any(Array) }));
  });

  it("returns a safe user-facing error for provider failures without exposing the key", async () => {
    vi.spyOn(DeviceService, "copilotCompletion").mockRejectedValue(new Error("AI 服务请求失败（401）"));

    await expect(requestCopilotCompletion(config, [], [])).rejects.toThrow("AI 服务请求失败（401）");
    await expect(requestCopilotCompletion({ ...config, apiKey: "dont-show" }, [], [])).rejects.not.toThrow("dont-show");
  });

  it("executes a read-only tool and sends its result back for the final answer", async () => {
    const completionMock = vi.spyOn(DeviceService, "copilotCompletion")
      .mockResolvedValueOnce({ choices: [{ message: { content: "", tool_calls: [{ id: "call-1", function: { name: "devices.list", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "设备已读取。", tool_calls: [] } }] });

    const result = await runCopilotTask(config, [{ role: "user", content: "查看设备" }], ["devices.list"], async () => "[{\"name\":\"Pixel\"}]", { maxSteps: 4 });

    expect(result.status).toBe("completed");
    expect(result.content).toBe("设备已读取。");
    expect(result.stepCount).toBe(1);
    expect(completionMock).toHaveBeenCalledTimes(2);
    expect(completionMock.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: "[{\"name\":\"Pixel\"}]" }),
    ]));
  });

  it("stops the loop at the configured maximum step count", async () => {
    vi.spyOn(DeviceService, "copilotCompletion").mockResolvedValue({ choices: [{ message: { content: "", tool_calls: [{ id: "loop", function: { name: "devices.list", arguments: "{}" } }] } }] });

    const result = await runCopilotTask(config, [{ role: "user", content: "继续" }], ["devices.list"], async () => "[]", { maxSteps: 1 });

    expect(result.status).toBe("max_steps");
    expect(result.stepCount).toBe(1);
  });

  it("returns a cancelled result without calling the provider when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const completionMock = vi.spyOn(DeviceService, "copilotCompletion");

    const result = await runCopilotTask(config, [{ role: "user", content: "停止" }], ["devices.list"], async () => "[]", { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(completionMock).not.toHaveBeenCalled();
  });

  it("stops before provider work when the total task timeout is reached", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1001);
    const completionMock = vi.spyOn(DeviceService, "copilotCompletion");

    const result = await runCopilotTask(config, [{ role: "user", content: "查看设备" }], ["devices.list"], async () => "[]", { totalTimeoutMs: 1000 });

    expect(result.status).toBe("timeout");
    expect(completionMock).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
