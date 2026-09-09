import { useEffect, useRef, useState } from "react";
import { Bot, Check, Send, ShieldAlert, SlidersHorizontal, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import { authorizeCopilotToolCall, COPILOT_TOOLS, type CopilotToolCall } from "../lib/copilotTools";
import { readCopilotPolicy, writeCopilotPolicy } from "../lib/copilotPolicy";
import { readCopilotHistory, writeCopilotHistory } from "../lib/copilotHistory";
import { readCopilotPreferences, writeCopilotPreferences } from "../lib/copilotPreferences";
import { runCopilotTask, type CopilotChatMessage } from "../services/copilotService";
import { executeCopilotToolCall } from "../services/copilotToolExecutor";
import { useAppStore } from "../stores/appStore";

type Message = { id: string; role: "assistant" | "user"; content: string };
type PendingCall = { call: CopilotToolCall; reason: string; label: string };
type ExecutionState = { status: string; steps: number; error: string };

function visibleMessages(protocolMessages: CopilotChatMessage[]): Message[] {
  return protocolMessages.flatMap((message, index) => {
    if (!message.content.trim()) return [];
    const content = message.role === "tool" ? `工具结果：${message.content}` : message.content;
    return [{ id: `protocol-${index}`, role: message.role === "user" ? "user" : "assistant", content }];
  });
}

export function CopilotPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const readOnlyIds = COPILOT_TOOLS.filter((tool) => tool.risk === "read").map((tool) => tool.id);
  const [allowedToolIds, setAllowedToolIds] = useState(() => readCopilotPolicy(readOnlyIds).allowedToolIds);
  const [request, setRequest] = useState("");
  const [protocolMessages, setProtocolMessages] = useState<CopilotChatMessage[]>(() => {
    const history = readCopilotHistory();
    return history.length ? history : [{ role: "assistant", content: t("copilot.welcome") }];
  });
  const [messages, setMessages] = useState<Message[]>(() => {
    const history = readCopilotHistory();
    return history.length ? visibleMessages(history) : [{ id: "welcome", role: "assistant", content: t("copilot.welcome") }];
  });
  const [preferences] = useState(readCopilotPreferences);
  const [endpoint, setEndpoint] = useState(preferences.endpoint);
  const [model, setModel] = useState(preferences.model);
  const [apiKey, setApiKey] = useState("");
  const [targetSerial, setTargetSerial] = useState(preferences.targetSerial);
  const [maxTokens, setMaxTokens] = useState(preferences.maxTokens);
  const [timeoutMs, setTimeoutMs] = useState(preferences.timeoutMs);
  const [maxSteps, setMaxSteps] = useState(preferences.maxSteps);
  const [totalTimeoutMs, setTotalTimeoutMs] = useState(preferences.totalTimeoutMs);
  const [execution, setExecution] = useState<ExecutionState>({ status: "idle", steps: 0, error: "" });
  const [busy, setBusy] = useState(false);
  const [pendingCall, setPendingCall] = useState<PendingCall | null>(null);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    writeCopilotHistory(protocolMessages);
  }, [protocolMessages]);

  useEffect(() => {
    writeCopilotPreferences({ endpoint, model, targetSerial, maxTokens, timeoutMs, maxSteps, totalTimeoutMs });
  }, [endpoint, model, targetSerial, maxTokens, timeoutMs, maxSteps, totalTimeoutMs]);

  const toggleTool = (id: string) => setAllowedToolIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const savePolicy = () => {
    writeCopilotPolicy({ allowedToolIds });
    setStatusText(t("copilot.saved"));
  };

  const applyTaskResult = (result: Awaited<ReturnType<typeof runCopilotTask>>) => {
    setExecution({ status: result.status, steps: result.stepCount, error: result.error || "" });
    setProtocolMessages(result.messages);
    setMessages(visibleMessages(result.messages));
    if (result.status === "awaiting_confirmation" && result.pendingCall) {
      const tool = COPILOT_TOOLS.find((item) => item.id === result.pendingCall?.toolId);
      setPendingCall({ call: result.pendingCall, reason: result.pendingReason || "该操作需要确认", label: tool?.label || result.pendingCall.toolId });
      return;
    }
    setPendingCall(null);
    if (result.status !== "completed" && result.status !== "cancelled") {
      const message = result.error || `任务状态：${result.status}`;
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: t("copilot.requestFailed", { message }) }]);
    }
  };

  const send = async () => {
    const content = request.trim();
    if (!content || busy) return;
    const nextMessage: Message = { id: `user-${Date.now()}`, role: "user", content };
    const nextProtocolMessages: CopilotChatMessage[] = [...protocolMessages, { role: "user", content }];
    setProtocolMessages(nextProtocolMessages);
    setMessages([...messages, nextMessage]);
    setRequest("");
    setBusy(true);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const result = await runCopilotTask(
        { baseUrl: endpoint, apiKey, model, maxTokens, timeoutMs },
        nextProtocolMessages,
        allowedToolIds,
        (call) => executeCopilotToolCall(call, targetSerial.trim()),
        { maxSteps, totalTimeoutMs, signal: controller.signal },
      );
      applyTaskResult(result);
    } catch (cause) {
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: t("copilot.requestFailed", { message: cause instanceof Error ? cause.message : String(cause) }) }]);
    } finally {
      requestController.current = null;
      setBusy(false);
    }
  };

  const confirmToolCall = async () => {
    if (!pendingCall) return;
    const authorization = authorizeCopilotToolCall(pendingCall.call, { allowedToolIds, confirmed: true });
    setPendingCall(null);
    if (authorization.status !== "allowed") {
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: authorization.reason }]);
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const output = await executeCopilotToolCall(pendingCall.call, targetSerial.trim());
      const toolMessage: CopilotChatMessage = { role: "tool", content: output, tool_call_id: pendingCall.call.id || "confirmed-call", name: pendingCall.call.toolId };
      const nextProtocolMessages = [...protocolMessages, toolMessage];
      const result = await runCopilotTask(
        { baseUrl: endpoint, apiKey, model, maxTokens, timeoutMs },
        nextProtocolMessages,
        allowedToolIds,
        (call) => executeCopilotToolCall(call, targetSerial.trim()),
        { maxSteps, totalTimeoutMs, signal: controller.signal },
      );
      applyTaskResult(result);
    } catch (cause) {
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: `执行失败：${cause instanceof Error ? cause.message : String(cause)}` }]);
    } finally {
      requestController.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="copilot-workbench">
      <div className="page-header copilot-header-rail">
        <div><h1 className="page-title">{t("copilot.title")}</h1><div className="page-subtitle">{t("copilot.subtitle")}</div></div>
        <div className="copilot-safety-badge"><ShieldAlert size={14} />{t("copilot.blocked")}</div>
      </div>
      <div className="copilot-layout">
        <Card className="copilot-conversation" title={t("copilot.conversation")}>
          <div className="copilot-message-list">
            {messages.length === 0 && <div className="empty-state">{t("copilot.empty")}</div>}
            {messages.map((message) => <div key={message.id} className={`copilot-message ${message.role}`}><span className="copilot-message-icon">{message.role === "assistant" ? <Bot size={14} /> : "你"}</span><div>{message.content}</div></div>)}
          </div>
          <div className="copilot-composer">
            <textarea aria-label={t("copilot.request")} value={request} onChange={(event) => setRequest(event.target.value)} placeholder={t("copilot.placeholder")} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) send(); }} />
            <div className="copilot-composer-foot"><span>{busy ? t("copilot.busy") : "Ctrl / ⌘ + Enter"}</span>{busy && <Button variant="secondary" icon={<X size={14} />} onClick={() => requestController.current?.abort()}>{t("copilot.cancel")}</Button>}<Button variant="primary" icon={<Send size={14} />} onClick={() => void send()} disabled={busy}>{t("copilot.send")}</Button></div>
            {pendingCall && <div className="copilot-confirmation"><div><strong>{t("copilot.pending")}</strong><span>{pendingCall.label} · {pendingCall.reason}</span></div><div className="row"><Button variant="secondary" icon={<X size={14} />} onClick={() => setPendingCall(null)}>{t("copilot.reject")}</Button><Button variant="primary" icon={<Check size={14} />} onClick={() => void confirmToolCall()}>{t("copilot.confirm")}</Button></div></div>}
          </div>
        </Card>
        <div className="copilot-side-stack">
          <Card className="copilot-policy-card" title={t("copilot.policy")} action={<SlidersHorizontal size={15} className="muted" />}>
            <p className="copilot-policy-hint">{t("copilot.policyHint")}</p>
            <div className="copilot-tool-list">{COPILOT_TOOLS.map((tool) => <label key={tool.id} className="copilot-tool-item"><input type="checkbox" aria-label={tool.label} checked={allowedToolIds.includes(tool.id)} onChange={() => toggleTool(tool.id)} /><span className="copilot-tool-copy"><strong>{tool.label}</strong><small>{tool.description}</small></span><span className={`copilot-risk ${tool.risk}`}>{tool.risk === "read" ? "只读" : tool.risk === "dangerous" ? "危险" : "写入"}</span></label>)}</div>
            <Button variant="secondary" icon={<Check size={14} />} onClick={savePolicy}>{t("copilot.savePolicy")}</Button>
          </Card>
          <Card className="copilot-provider-card" title={t("copilot.provider")}>
            <label><span>{t("copilot.target")}</span><input value={targetSerial} onChange={(event) => setTargetSerial(event.target.value)} /></label>
            <label><span>{t("copilot.endpoint")}</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
            <label><span>{t("copilot.model")}</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
            <label><span>{t("copilot.apiKey")}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
            <div className="copilot-limit-grid">
              <label><span>{t("copilot.maxTokens")}</span><input aria-label={t("copilot.maxTokens")} type="number" min={128} max={16384} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label>
              <label><span>{t("copilot.maxSteps")}</span><input aria-label={t("copilot.maxSteps")} type="number" min={1} max={32} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
              <label><span>{t("copilot.timeout")}</span><input aria-label={t("copilot.timeout")} type="number" min={1000} max={120000} step={1000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} /></label>
              <label><span>{t("copilot.totalTimeout")}</span><input aria-label={t("copilot.totalTimeout")} type="number" min={1000} max={600000} step={1000} value={totalTimeoutMs} onChange={(event) => setTotalTimeoutMs(Number(event.target.value))} /></label>
            </div>
          </Card>
          <Card className="copilot-execution-card" title={t("copilot.execution")}>
            <div className="copilot-execution-summary">
              <span>{t("copilot.executionStatus")}</span>
              <strong>{execution.status === "idle" ? t("copilot.executionIdle") : execution.status}</strong>
              <span>{t("copilot.executionSteps", { n: execution.steps })}</span>
            </div>
            {execution.error && <div className="copilot-execution-error">{execution.error}</div>}
            <div className="copilot-execution-log">
              {messages.filter((message) => message.content.startsWith("工具结果：")).slice(-5).map((message) => <div key={message.id}>{message.content}</div>)}
              {!messages.some((message) => message.content.startsWith("工具结果：")) && <span className="muted">{t("copilot.executionLogEmpty")}</span>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
