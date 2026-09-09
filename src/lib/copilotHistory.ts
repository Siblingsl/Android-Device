import type { CopilotChatMessage } from "../services/copilotService";

export const COPILOT_HISTORY_STORAGE_KEY = "rdc.copilot.history";
const MAX_MESSAGES = 200;

function safeMessage(value: unknown): CopilotChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(String(source.role)) || typeof source.content !== "string") return null;
  const message: CopilotChatMessage = { role: source.role as CopilotChatMessage["role"], content: source.content.slice(0, 20_000) };
  if (message.role === "assistant" && Array.isArray(source.tool_calls)) {
    const toolCalls = source.tool_calls.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const call = entry as Record<string, unknown>;
      const fn = call.function;
      if (typeof call.id !== "string" || !fn || typeof fn !== "object") return [];
      const functionData = fn as Record<string, unknown>;
      if (typeof functionData.name !== "string" || typeof functionData.arguments !== "string") return [];
      return [{ id: call.id, type: "function" as const, function: { name: functionData.name, arguments: functionData.arguments.slice(0, 10_000) } }];
    });
    if (toolCalls.length) message.tool_calls = toolCalls;
  }
  if (message.role === "tool" && typeof source.tool_call_id === "string") message.tool_call_id = source.tool_call_id;
  return message;
}

export function readCopilotHistory(): CopilotChatMessage[] {
  try {
    const raw = localStorage.getItem(COPILOT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_MESSAGES).flatMap((entry) => { const message = safeMessage(entry); return message ? [message] : []; }) : [];
  } catch {
    return [];
  }
}

export function writeCopilotHistory(messages: CopilotChatMessage[]): void {
  try {
    const safe = messages.slice(-MAX_MESSAGES).flatMap((entry) => { const message = safeMessage(entry); return message ? [message] : []; });
    localStorage.setItem(COPILOT_HISTORY_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* history is best effort and must never interrupt device work */
  }
}
