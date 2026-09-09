import { useRef, useState } from "react";
import { Bot, Check, Send, ShieldAlert, SlidersHorizontal, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useI18n } from "../i18n";
import { authorizeCopilotToolCall, COPILOT_TOOLS, type CopilotToolCall } from "../lib/copilotTools";
import { readCopilotPolicy, writeCopilotPolicy } from "../lib/copilotPolicy";
import { requestCopilotCompletion, type CopilotChatMessage } from "../services/copilotService";
import { executeCopilotToolCall } from "../services/copilotToolExecutor";
import { useAppStore } from "../stores/appStore";

type Message = { id: string; role: "assistant" | "user"; content: string };
type PendingCall = { call: CopilotToolCall; reason: string; label: string };

export function CopilotPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const readOnlyIds = COPILOT_TOOLS.filter((tool) => tool.risk === "read").map((tool) => tool.id);
  const [allowedToolIds, setAllowedToolIds] = useState(() => readCopilotPolicy(readOnlyIds).allowedToolIds);
  const [request, setRequest] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ id: "welcome", role: "assistant", content: t("copilot.welcome") }]);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434/v1");
  const [model, setModel] = useState("qwen2.5");
  const [apiKey, setApiKey] = useState("");
  const [targetSerial, setTargetSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingCall, setPendingCall] = useState<PendingCall | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const toggleTool = (id: string) => setAllowedToolIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const savePolicy = () => {
    writeCopilotPolicy({ allowedToolIds });
    setStatusText(t("copilot.saved"));
  };
  const appendAssistant = (content: string) => setMessages((current) => [...current, { id: `assistant-${Date.now()}-${Math.random()}`, role: "assistant", content }]);

  const handleToolCalls = async (toolCalls: CopilotToolCall[]) => {
    const call = toolCalls[0];
    if (!call) return;
    const authorization = authorizeCopilotToolCall(call, { allowedToolIds, confirmed: false });
    if (authorization.status === "blocked") {
      appendAssistant(authorization.reason);
      return;
    }
    if (authorization.status === "confirmation_required") {
      setPendingCall({ call, reason: authorization.reason, label: authorization.tool.label });
      return;
    }
    const output = await executeCopilotToolCall(call, targetSerial.trim());
    appendAssistant(`${authorization.tool.label}：${output}`);
  };

  const send = async () => {
    const content = request.trim();
    if (!content || busy) return;
    const nextMessage: Message = { id: `user-${Date.now()}`, role: "user", content };
    const nextMessages = [...messages, nextMessage];
    setMessages(nextMessages);
    setRequest("");
    setBusy(true);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const result = await requestCopilotCompletion(
        { baseUrl: endpoint, apiKey, model, maxTokens: 1200, timeoutMs: 60000 },
        nextMessages.map((message): CopilotChatMessage => ({ role: message.role, content: message.content })),
        allowedToolIds,
        controller.signal,
      );
      if (result.content) appendAssistant(result.content);
      await handleToolCalls(result.toolCalls);
    } catch (cause) {
      appendAssistant(t("copilot.requestFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
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
      appendAssistant(authorization.status === "blocked" ? authorization.reason : authorization.reason);
      return;
    }
    try {
      const output = await executeCopilotToolCall(pendingCall.call, targetSerial.trim());
      appendAssistant(`${authorization.tool.label}：${output}`);
    } catch (cause) {
      appendAssistant(`执行失败：${cause instanceof Error ? cause.message : String(cause)}`);
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
            <div className="copilot-composer-foot"><span>{busy ? t("copilot.busy") : "Ctrl / ⌘ + Enter"}</span><Button variant="primary" icon={<Send size={14} />} onClick={() => void send()} disabled={busy}>{t("copilot.send")}</Button></div>
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
          </Card>
        </div>
      </div>
    </div>
  );
}
