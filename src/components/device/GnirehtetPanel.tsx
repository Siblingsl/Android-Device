import { useEffect, useState } from "react";
import { Cable, CircleStop, RefreshCw, Wrench } from "lucide-react";
import { DeviceService } from "../../services/deviceService";
import type { GnirehtetSession } from "../../types";
import { Button } from "../ui/Button";

interface Props {
  serial: string;
  online: boolean;
  setStatusText: (text: string) => void;
}

export function GnirehtetPanel({ serial, online, setStatusText }: Props) {
  const [session, setSession] = useState<GnirehtetSession>({ serial, status: "stopped", message: "", relay: "", installed: false });
  const [dns, setDns] = useState("");
  const [relayPort, setRelayPort] = useState("31416");
  const [routes, setRoutes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      if (!online) return;
      try {
        const next = await DeviceService.gnirehtetStatus(serial);
        if (!disposed) setSession(next);
      } catch {
        // Status is intentionally best effort during device handoff.
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [serial, online]);

  const run = async (operation: () => Promise<GnirehtetSession | { success: boolean; stdout: string; stderr: string }>) => {
    setBusy(true);
    try {
      const result = await operation();
      if ("status" in result) setSession(result);
      else if (!result.success) setSession((current) => ({ ...current, status: "error", message: result.stderr || result.stdout || "操作失败" }));
      setStatusText("status" in result ? result.message : result.success ? result.stdout || "操作完成" : result.stderr || result.stdout || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const port = Number(relayPort);
  const running = session.status === "running";

  return (
    <section className="module gnirehtet-panel" aria-label="Gnirehtet 反向供网">
      <div className="module-head">
        <div className="row"><Cable size={14} /><div className="module-title">Gnirehtet 反向供网</div></div>
        <span className={`badge ${running ? "online" : session.status === "error" ? "offline" : "info"}`}>{running ? "供网中" : session.status === "error" ? "失败" : "已停止"}</span>
      </div>
      <div className="gnirehtet-body">
        <div className="form-grid gnirehtet-options">
          <label className="field">DNS（可选）<input value={dns} disabled={running || busy} onChange={(event) => setDns(event.target.value)} placeholder="8.8.8.8,1.1.1.1" /></label>
          <label className="field">Relay 端口<input type="number" min={1} max={65535} value={relayPort} disabled={running || busy} onChange={(event) => setRelayPort(event.target.value)} /></label>
          <label className="field">路由（可选）<input value={routes} disabled={running || busy} onChange={(event) => setRoutes(event.target.value)} placeholder="0.0.0.0/0" /></label>
        </div>
        <div className="row gnirehtet-actions">
          {!running ? <Button size="sm" variant="primary" disabled={!online || busy || !Number.isInteger(port) || port < 1 || port > 65535} loading={busy} onClick={() => void run(() => DeviceService.gnirehtetStart(serial, dns, port, routes))}>启动供网</Button> : <Button size="sm" variant="danger" disabled={busy} icon={<CircleStop size={13} />} onClick={() => void run(() => DeviceService.gnirehtetStop(serial))}>停止供网</Button>}
          <Button size="sm" variant="ghost" disabled={!online || busy} icon={<Wrench size={13} />} onClick={() => void run(() => DeviceService.gnirehtetRepair(serial, dns, port, routes))}>自动修复</Button>
          <Button size="sm" variant="ghost" disabled={!online || busy} icon={<RefreshCw size={13} />} onClick={() => void run(() => DeviceService.gnirehtetInstall(serial))}>安装 / 更新</Button>
          <span className="muted gnirehtet-message">{session.message || (online ? "依赖 Gnirehtet 可执行文件和设备授权" : "设备离线，需在线")}</span>
          {session.relay && <span className="mono muted">Relay {session.relay}</span>}
        </div>
      </div>
    </section>
  );
}
