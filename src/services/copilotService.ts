import { authorizeCopilotToolCall, type CopilotToolCall } from "../lib/copilotTools";

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
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface CopilotCompletion {
  content: string;
  toolCalls: CopilotToolCall[];
}

export interface CopilotTaskOptions {
  maxSteps?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}

export type CopilotTaskStatus = "completed" | "awaiting_confirmation" | "max_steps" | "timeout" | "cancelled" | "failed";

export interface CopilotTaskResult {
  status: CopilotTaskStatus;
  content: string;
  messages: CopilotChatMessage[];
  stepCount: number;
  pendingCall?: CopilotToolCall;
  pendingReason?: string;
  error?: string;
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

function protocolToolCall(call: CopilotToolCall, index: number) {
  return {
    id: call.id || `call-${Date.now()}-${index}`,
    type: "function" as const,
    function: { name: call.toolId, arguments: JSON.stringify(call.args) },
  };
}

export async function runCopilotTask(
  config: CopilotProviderConfig,
  initialMessages: CopilotChatMessage[],
  allowedToolIds: string[],
  executeTool: (call: CopilotToolCall) => Promise<string>,
  options: CopilotTaskOptions = {},
): Promise<CopilotTaskResult> {
  const messages = [...initialMessages];
  const maxSteps = Math.max(1, Math.min(32, options.maxSteps ?? 8));
  const totalTimeoutMs = Math.max(1000, options.totalTimeoutMs ?? Math.max(config.timeoutMs * maxSteps, 60_000));
  const startedAt = Date.now();
  let stepCount = 0;
  let lastContent = "";

  const result = (status: CopilotTaskStatus, extra: Partial<CopilotTaskResult> = {}): CopilotTaskResult => ({
    status,
    content: extra.content ?? lastContent,
    messages: [...messages],
    stepCount,
    ...extra,
  });

  try {
    while (true) {
      if (options.signal?.aborted) return result("cancelled");
      if (Date.now() - startedAt >= totalTimeoutMs) return result("timeout", { error: "AI 任务超过总时长限制" });

      const completion = await requestCopilotCompletion(config, messages, allowedToolIds, options.signal);
      lastContent = completion.content;
      const toolCalls = completion.toolCalls;
      const assistantMessage: CopilotChatMessage = {
        role: "assistant",
        content: completion.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(protocolToolCall) } : {}),
      };
      messages.push(assistantMessage);

      if (toolCalls.length === 0) return result("completed");

      for (const call of toolCalls) {
        if (stepCount >= maxSteps) return result("max_steps", { error: "AI 工具调用达到最大步数限制" });
        stepCount += 1;
        if (Date.now() - startedAt >= totalTimeoutMs) return result("timeout", { error: "AI 任务超过总时长限制" });

        const authorization = authorizeCopilotToolCall(call, { allowedToolIds, confirmed: false });
        if (authorization.status === "blocked") {
          return result("failed", { error: authorization.reason });
        }
        if (authorization.status === "confirmation_required") {
          return result("awaiting_confirmation", { pendingCall: call, pendingReason: authorization.reason });
        }

        const output = await executeTool(call);
        messages.push({
          role: "tool",
          content: output,
          tool_call_id: call.id || protocolToolCall(call, stepCount).id,
          name: call.toolId,
        });
      }
    }
  } catch (cause) {
    if (options.signal?.aborted || (cause instanceof Error && cause.message.includes("超时或已取消"))) return result("cancelled");
    return result("failed", { error: cause instanceof Error ? cause.message : String(cause) });
  }
}
