import type { CopilotToolCall } from "../lib/copilotTools";

export interface CopilotProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface CopilotChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface CopilotCompletion {
  content: string;
  toolCalls: CopilotToolCall[];
}

function endpointFor(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
}

function toolDescriptor(toolId: string) {
  return {
    type: "function",
    function: {
      name: toolId,
      description: `受控设备工具：${toolId}`,
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  };
}

export async function requestCopilotCompletion(
  config: CopilotProviderConfig,
  messages: CopilotChatMessage[],
  allowedToolIds: string[],
  signal?: AbortSignal,
): Promise<CopilotCompletion> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs));
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(endpointFor(config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: config.maxTokens,
        temperature: 0.2,
        tools: allowedToolIds.map(toolDescriptor),
        tool_choice: "auto",
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`AI 服务请求失败（${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
    const message = payload.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call) => {
      const toolId = call.function?.name;
      if (!toolId) return [];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* malformed model args stay empty and are revalidated later */ }
      return [{ id: call.id || `call-${Date.now()}`, toolId, args }];
    });
    return { content: message?.content || "", toolCalls };
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("AI 服务请求失败")) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("AI 服务请求超时或已取消");
    throw new Error("AI 服务暂时不可用，请检查接口地址、模型和网络连接");
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
