import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Send, SquareTerminal } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { useI18n } from "../i18n";
import {
  TerminalSessionService,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
} from "../services/terminalSessionService";

const MAX_OUTPUT_LENGTH = 200_000;
const MAX_COMMAND_HISTORY = 50;

export function TerminalPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const translateRef = useRef(t);
  translateRef.current = t;

  const appendOutput = (data: string) => {
    if (!data) return;
    setOutput((previous) => `${previous}${data}`.slice(-MAX_OUTPUT_LENGTH));
  };

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    setOutput("");
    setError("");
    setSession(null);
    setCommand("");
    setCommandHistory([]);
    setHistoryIndex(-1);
    setLoading(true);

    const handleOutput = (event: TerminalOutputEvent) => {
      if (!active || event.sessionId !== sessionId) return;
      appendOutput(event.data);
      if (event.kind === "exit") {
        const status = event.status || "exited";
        setSession((previous) => (previous ? { ...previous, status } : previous));
        setSessions((previous) => previous.map((item) => (
          item.id === sessionId ? { ...item, status } : item
        )));
      }
    };

    void TerminalSessionService.subscribe(handleOutput)
      .then((cleanup) => {
        if (active) unlisten = cleanup;
        else cleanup();
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });

    void TerminalSessionService.list()
      .then((sessions) => {
        if (!active) return;
        setSessions(sessions);
        const current = sessions.find((item) => item.id === sessionId) ?? null;
        setSession(current);
        if (!current) setError(translateRef.current("terminal.sessionMissing"));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId]);

  const selectSession = (nextSessionId: string) => {
    if (!nextSessionId || nextSessionId === sessionId) return;
    navigate(`/terminal?session=${encodeURIComponent(nextSessionId)}`);
  };

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  const statusLabel = useMemo(() => {
    if (loading) return t("terminal.loading");
    if (!session) return t("terminal.unavailable");
    if (session.status === "running") return t("terminal.running");
    return t("terminal.stopped", { status: session.status });
  }, [loading, session, t]);

  const sendCommand = async () => {
    const value = command;
    if (!sessionId || !value || busy || session?.status !== "running") return;
    setBusy(true);
    setError("");
    try {
      const result = await TerminalSessionService.write(sessionId, `${value}\r`);
      if (!result.success) setError(result.error || t("terminal.writeFailed"));
      else {
        const historyValue = value.trim();
        if (historyValue) {
          setCommandHistory((previous) => {
            const next = previous[previous.length - 1] === value ? previous : [...previous, value];
            return next.slice(-MAX_COMMAND_HISTORY);
          });
        }
        setHistoryIndex(-1);
        setCommand("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const result = await TerminalSessionService.stop(sessionId);
      if (!result.success) setError(result.error || t("terminal.stopFailed"));
      else setSession((previous) => (previous ? { ...previous, status: "stopped" } : previous));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="terminal-page">
      <header className="terminal-header">
        <div className="terminal-title-wrap">
          <span className="terminal-title-icon"><SquareTerminal size={18} /></span>
          <div>
            <div className="terminal-title">{session?.title ?? t("terminal.title")}</div>
            <div className="terminal-subtitle">{statusLabel}</div>
          </div>
        </div>
        {sessions.length > 0 && (
          <label className="terminal-session-picker">
            <span>{t("terminal.session")}</span>
            <select
              aria-label={t("terminal.session")}
              value={sessions.some((item) => item.id === sessionId) ? sessionId : ""}
              onChange={(event) => selectSession(event.target.value)}
              disabled={loading}
            >
              {!sessions.some((item) => item.id === sessionId) && (
                <option value="">{t("terminal.sessionMissing")}</option>
              )}
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
        )}
        <div className="row">
          <Button
            size="sm"
            variant="ghost"
            icon={<Eraser size={14} />}
            onClick={() => setOutput("")}
            disabled={!output}
          >
            {t("terminal.clear")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void stopSession()} disabled={!session || busy}>
            {t("terminal.stop")}
          </Button>
        </div>
      </header>

      <main className="terminal-body">
        <pre ref={outputRef} className="terminal-output" role="log" aria-live="polite">
          {output || t("terminal.waiting")}
        </pre>
        <form
          className="terminal-input-row"
          onSubmit={(event) => {
            event.preventDefault();
            void sendCommand();
          }}
        >
          <span className="terminal-prompt">›</span>
          <input
            aria-label={t("terminal.command")}
            className="terminal-input mono"
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void sendCommand();
                return;
              }
              if (event.key === "ArrowUp" && commandHistory.length > 0) {
                event.preventDefault();
                setHistoryIndex((previous) => {
                  const next = previous < 0 ? commandHistory.length - 1 : Math.max(0, previous - 1);
                  setCommand(commandHistory[next] ?? "");
                  return next;
                });
                return;
              }
              if (event.key === "ArrowDown" && historyIndex >= 0) {
                event.preventDefault();
                const next = historyIndex + 1;
                if (next >= commandHistory.length) {
                  setHistoryIndex(-1);
                  setCommand("");
                } else {
                  setHistoryIndex(next);
                  setCommand(commandHistory[next] ?? "");
                }
                return;
              }
              if (event.key === "c" && event.ctrlKey && !command) {
                event.preventDefault();
                void TerminalSessionService.write(sessionId, "\u0003");
              }
            }}
            placeholder={t("terminal.placeholder")}
            disabled={!session || session.status !== "running" || busy}
            autoFocus
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={<Send size={14} />}
            loading={busy}
            disabled={!command.trim() || !session || session.status !== "running"}
          >
            {t("terminal.send")}
          </Button>
        </form>
        {error && <div className="terminal-error" role="alert">{error}</div>}
      </main>
    </div>
  );
}
