import { useEffect, useRef, useState } from "react";
import { CircleStop, Clipboard, Play, Square, TerminalSquare, Trash2 } from "lucide-react";
import { DeviceService } from "../../services/deviceService";
import { Button } from "../ui/Button";
import type { TerminalSession } from "../../types";

interface Props {
  serial: string;
  online: boolean;
}

export function InteractiveTerminal({ serial, online }: Props) {
  const [kind, setKind] = useState<"device" | "local">("device");
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalGenerationRef = useRef(0);

  useEffect(() => {
    terminalGenerationRef.current += 1;
    return () => {
      terminalGenerationRef.current += 1;
    };
  }, [serial]);

  useEffect(() => {
    if (!session?.id) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await DeviceService.terminalRead(session.id);
        if (next.output) setOutput((current) => current + next.output);
        if (next.status !== "running") {
          setOutput((current) => `${current}${next.message ? `\n${next.message}` : "\n终端进程已退出"}\n`);
          setSession(null);
        }
      } catch (error) {
        setOutput((current) => `${current}\n${error instanceof Error ? error.message : String(error)}\n`);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [session?.id]);

  useEffect(() => {
    const element = terminalRef.current;
    if (!element || !session?.id || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const cols = Math.max(40, Math.min(240, Math.floor(element.clientWidth / 8)));
      const rows = Math.max(8, Math.min(80, Math.floor(element.clientHeight / 17)));
      void DeviceService.terminalResize(session.id, cols, rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [session?.id]);

  useEffect(() => {
    const activeId = session?.id;
    if (!activeId) return;
    return () => {
      // Capture the session id for this effect instance. Reading a mutable
      // ref here could stop the new device's terminal after a route switch.
      void DeviceService.terminalStop(activeId).catch(() => undefined);
    };
  }, [serial, session?.id]);

  const start = async () => {
    if (kind === "device" && !online) return;
    const generation = terminalGenerationRef.current;
    setBusy(true);
    setOutput("");
    try {
      const next = await DeviceService.terminalStart(kind, kind === "device" ? serial : "");
      if (terminalGenerationRef.current !== generation) {
        if (next.id) void DeviceService.terminalStop(next.id).catch(() => undefined);
        return;
      }
      setSession(next.status === "running" ? next : null);
      if (next.message) setOutput(next.message + "\n");
    } catch (error) {
      if (terminalGenerationRef.current !== generation) return;
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      if (terminalGenerationRef.current === generation) setBusy(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    const result = await DeviceService.terminalStop(session.id);
    setOutput((current) => `${current}\n${result.success ? "终端已停止" : result.stderr || result.stdout}\n`);
    if (result.success) setSession(null);
  };

  const write = async () => {
    if (!session || !input) return;
    const result = await DeviceService.terminalWrite(session.id, input + "\n");
    if (!result.success) setOutput((current) => `${current}\n${result.stderr || result.stdout}\n`);
    setInput("");
  };

  const interrupt = async () => {
    if (!session) return;
    const result = await DeviceService.terminalWrite(session.id, "\u0003");
    if (!result.success) setOutput((current) => `${current}\n${result.stderr || result.stdout || "发送中断失败"}\n`);
  };

  return (
    <section className="module interactive-terminal">
      <div className="module-head">
        <div className="row"><TerminalSquare size={14} /><div className="module-title">交互式终端</div></div>
        <div className="row">
          <select value={kind} onChange={(event) => setKind(event.target.value as "device" | "local")} disabled={Boolean(session) || busy} aria-label="终端类型">
            <option value="device">设备 ADB Shell</option>
            <option value="local">本机终端</option>
          </select>
          {session ? <Button size="sm" variant="danger" onClick={() => void stop()}><Square size={13} />停止</Button> : <Button size="sm" variant="primary" disabled={busy || (kind === "device" && !online)} loading={busy} onClick={() => void start()}><Play size={13} />启动</Button>}
          <Button size="sm" variant="ghost" disabled={!session} onClick={() => void interrupt()}><CircleStop size={13} />中断</Button>
          <Button size="sm" variant="ghost" onClick={() => setOutput("")}><Trash2 size={13} />清空</Button>
        </div>
      </div>
      <div className="interactive-terminal-body">
        <div ref={terminalRef} className="interactive-terminal-output" role="log" aria-live="polite">{output || (session ? "等待输入…" : "启动后可执行持续运行的命令，例如 top、logcat")}</div>
        <div className="row interactive-terminal-input">
          <span className="mono">{kind === "device" ? `${serial} $` : "local $"}</span>
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.ctrlKey && event.key.toLowerCase() === "c") { event.preventDefault(); void interrupt(); } else if (event.key === "Enter") void write(); }} disabled={!session} placeholder="输入命令并回车（Ctrl+C 中断）" aria-label="终端输入" />
          <Button size="sm" disabled={!session || !input} onClick={() => void write()}>发送</Button>
          <Button size="sm" variant="ghost" disabled={!output} onClick={() => void navigator.clipboard.writeText(output)}> <Clipboard size={13} />复制输出</Button>
        </div>
      </div>
    </section>
  );
}
