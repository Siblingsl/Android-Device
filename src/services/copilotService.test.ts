import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCopilotCompletion, runCopilotTask, type CopilotProviderConfig } from "./copilotService";

const config: CopilotProviderConfig = {
  baseUrl: "https://example.test/v1/",
  apiKey: "secret-key",
  model: "demo-model",
  maxTokens: 512,
  timeoutMs: 5000,
};

describe("copilot service", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls an OpenAI-compatible endpoint and parses assistant tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "我先读取设备列表。", tool_calls: [{ id: "call-1", type: "function", function: { name: "devices.list", arguments: "{}" } }] } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestCopilotCompletion(config, [{ role: "user", content: "查看设备" }], ["devices.list"]);

    expect(result.content).toBe("我先读取设备列表。");
    expect(result.toolCalls).toEqual([{ id: "call-1", toolId: "devices.list", args: {} }]);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "demo-model", max_tokens: 512 });
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
  });

  it("returns a safe user-facing error for provider failures without exposing the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await expect(requestCopilotCompletion(config, [], [])).rejects.toThrow("AI 服务请求失败（401）");
    await expect(requestCopilotCompletion({ ...config, apiKey: "dont-show" }, [], [])).rejects.not.toThrow("dont-show");
  });

  it("executes a read-only tool and sends its result back for the final answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "call-1", function: { name: "devices.list", arguments: "{}" } }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "设备已读取。", tool_calls: [] } }] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCopilotTask(config, [{ role: "user", content: "查看设备" }], ["devices.list"], async () => "[{\"name\":\"Pixel\"}]", { maxSteps: 4 });

    expect(result.status).toBe("completed");
    expect(result.content).toBe("设备已读取。");
    expect(result.stepCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.messages.at(-1)).toMatchObject({ role: "tool", content: "[{\"name\":\"Pixel\"}]" });
  });

  it("stops the loop at the configured maximum step count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "loop", function: { name: "devices.list", arguments: "{}" } }] } }] }) }));

    const result = await runCopilotTask(config, [{ role: "user", content: "继续" }], ["devices.list"], async () => "[]", { maxSteps: 1 });

    expect(result.status).toBe("max_steps");
    expect(result.stepCount).toBe(1);
  });

  it("returns a cancelled result without calling the provider when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCopilotTask(config, [{ role: "user", content: "停止" }], ["devices.list"], async () => "[]", { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before provider work when the total task timeout is reached", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1001);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCopilotTask(config, [{ role: "user", content: "查看设备" }], ["devices.list"], async () => "[]", { totalTimeoutMs: 1000 });

    expect(result.status).toBe("timeout");
    expect(fetchMock).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
