import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCopilotCompletion, type CopilotProviderConfig } from "./copilotService";

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
});
