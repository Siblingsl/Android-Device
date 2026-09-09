import { useEffect, useRef, useState } from "react";
import { Activity, Box, Cpu, MemoryStick, Smartphone, Wifi } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { DeviceStatusBoard } from "../components/device/DeviceStatusBoard";
import { DeviceService } from "../services/deviceService";
import type { DashboardData } from "../types";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import { createRequestSequence } from "../lib/requestSequence";

export function Dashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const navigate = useNavigate();
  const loadSequence = useRef(createRequestSequence()).current;
  const loadingRequest = useRef<number | null>(null);

  const load = async (soft = false) => {
    const token = loadSequence.begin();
    if (!soft) {
      loadingRequest.current = token;
      setLoading(true);
    }
    try {
      const d = await DeviceService.getDashboard();
      if (!loadSequence.isCurrent(token)) return;
      setData(d);
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      if (!soft) setData(null);
      setStatusText(
        e instanceof Error ? t("dashboard.refreshFailed", { msg: e.message }) : t("dashboard.refreshFailedShort"),
      );
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      if (loadingRequest.current !== null) loadingRequest.current = null;
      setLoading(false);
    }
  };

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    };
    void load(false);
    const timer = setInterval(tick, 20000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      loadSequence.invalidate();
    };
  }, []);

  return (
    <div className="dashboard-page">
      <DeviceStatusBoard devices={data?.devices ?? []} loading={loading && !data} />
      <SystemHealthStrip data={data} loading={loading} onNavigate={navigate} t={t} />
      <DashboardActivity data={data} onNavigate={navigate} t={t} />
    </div>
  );
}

function SystemHealthStrip({ data, loading, onNavigate, t }: {
  data: DashboardData | null;
  loading: boolean;
  onNavigate: (to: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="dashboard-health-strip" aria-label={t("dashboard.health.label")}>
      {loading && !data ? (
        Array.from({ length: 5 }).map((_, index) => <Card key={index}><Skeleton height={40} /></Card>)
      ) : (
        <>
          <StatCard compact icon={<Box size={16} />} label="Docker" value={data?.status.dockerRunning ? t("common.status.dockerRunning") : t("common.status.dockerOff")} hint={data?.status.dockerVersion} ok={data?.status.dockerRunning} onClick={() => onNavigate("/docker")} />
          <StatCard compact icon={<Wifi size={16} />} label="ADB" value={data?.status.adbRunning ? t("common.status.adbOk") : t("dashboard.adbError")} hint={data?.status.adbVersion} ok={data?.status.adbRunning} onClick={() => onNavigate("/adb")} />
          <StatCard compact icon={<Smartphone size={16} />} label={t("common.panel.onlineDevices")} value={String((data?.devices ?? []).filter((d) => d.online && d.adbStatus === "device").length)} hint="ADB device" ok onClick={() => onNavigate("/devices")} />
          <StatCard compact icon={<Cpu size={16} />} label="CPU" value={`${(data?.status.cpuUsage ?? 0).toFixed(1)}%`} hint={t("dashboard.hint.localUsage")} />
          <StatCard compact icon={<MemoryStick size={16} />} label={t("common.panel.memory")} value={`${(data?.status.memoryUsage ?? 0).toFixed(1)}%`} hint={data?.status.memoryTotalMb ? `${data.status.memoryUsedMb} / ${data.status.memoryTotalMb} MB` : t("dashboard.hint.localUsage")} />
          <StatCard compact icon={<Activity size={16} />} label={t("dashboard.casting")} value={String((data?.devices ?? []).filter((d) => d.scrcpyStatus === "running").length)} hint="Scrcpy running" onClick={() => onNavigate("/devices")} />
        </>
      )}
    </section>
  );
}

function DashboardActivity({ data, onNavigate, t }: {
  data: DashboardData | null;
  onNavigate: (to: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="dashboard-activity-grid">
      <Card title={t("dashboard.card.notifications")}>
        {data?.notifications?.length ? (
          <div className="stack">
            {data.notifications.map((notification, index) => (
              <button key={index} className="notice" style={{ width: "100%", textAlign: "left" }} onClick={() => {
                if (notification.includes("Docker")) onNavigate("/docker");
                else if (notification.includes("ADB")) onNavigate("/adb");
                else if (notification.includes("设备")) onNavigate("/devices");
                else onNavigate("/logs");
              }}>{notification}</button>
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("dashboard.empty.noNotifications")} <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => onNavigate("/logs")}>{t("dashboard.openLogs")}</Button></div>
        )}
      </Card>

      <Card title={t("dashboard.card.recentLogs")} action={<Button size="sm" variant="ghost" onClick={() => {
        try {
          sessionStorage.setItem("rdc.logs.source", "all");
          sessionStorage.setItem("rdc.logs.level", "all");
          sessionStorage.setItem("rdc.logs.keyword", "");
        } catch { /* storage is optional */ }
        onNavigate("/logs");
      }}>{t("dashboard.openLogs")}</Button>}>
        {data?.recentLogs?.length ? data.recentLogs.slice(0, 8).map((log) => (
          <button key={log.id} className={`log-line ${log.level}`} style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => {
            try {
              sessionStorage.setItem("rdc.logs.source", log.source || "all");
              sessionStorage.setItem("rdc.logs.level", log.level || "all");
              sessionStorage.setItem("rdc.logs.keyword", "");
            } catch { /* storage is optional */ }
            onNavigate("/logs");
          }}>[{log.timestamp}] [{log.source}] {log.message}</button>
        )) : <div className="empty-state">{t("dashboard.empty.noLogs")}</div>}
      </Card>

      <Card title={t("dashboard.card.recentScreenshots")} action={data?.recentScreenshots?.[0] ? <Button size="sm" variant="ghost" onClick={() => void DeviceService.revealInFolder(data.recentScreenshots[0]).catch((error) => alert(String(error)))}>{t("dashboard.openFolder")}</Button> : null}>
        {data?.recentScreenshots?.length ? data.recentScreenshots.map((path) => (
          <button key={path} className="mono muted" style={{ padding: "4px 0", fontSize: 12, textAlign: "left", display: "block" }} onClick={() => void DeviceService.revealInFolder(path).catch((error) => alert(String(error)))}>{path.split(/[/\\]/).pop()}</button>
        )) : <div className="empty-state">{t("dashboard.empty.noScreenshots")} <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => onNavigate("/devices")}>{t("dashboard.goScreenshot")}</Button></div>}
      </Card>

      <Card title={t("dashboard.card.recentApks")} action={data?.recentApks?.[0] ? <Button size="sm" variant="ghost" onClick={() => void DeviceService.revealInFolder(data.recentApks[0]).catch((error) => alert(String(error)))}>{t("dashboard.openFolder")}</Button> : null}>
        {data?.recentApks?.length ? data.recentApks.map((path) => (
          <button key={path} className="mono muted" style={{ padding: "4px 0", fontSize: 12, textAlign: "left", display: "block" }} onClick={() => {
            try { sessionStorage.setItem("rdc.apk.path", path); } catch { /* storage is optional */ }
            onNavigate("/apk");
          }}>{path.split(/[/\\]/).pop()}</button>
        )) : <div className="empty-state">{t("dashboard.empty.noApks")} <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => onNavigate("/apk")}>{t("dashboard.goInstall")}</Button></div>}
      </Card>
    </section>
  );
}

function StatCard({ icon, label, value, hint, ok, onClick, compact = false }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  ok?: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <Card hover className={compact ? "stat-card-compact" : undefined}>
      <button type="button" onClick={onClick} disabled={!onClick} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, padding: 0, color: "inherit", cursor: onClick ? "pointer" : "default" }}>
        <div className="row-between">
          <div className="stat-icon">{icon}</div>
          {ok !== undefined && <StatusDot online={!!ok} label={ok ? "OK" : "ERR"} />}
        </div>
        <div style={{ marginTop: compact ? 7 : 12, color: "var(--text-secondary)", fontSize: 11 }}>{label}</div>
        <div style={{ fontSize: compact ? 16 : 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
        {hint && <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{hint}</div>}
      </button>
    </Card>
  );
}
