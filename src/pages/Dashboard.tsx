import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, Box, Cpu, MemoryStick, Smartphone, Wifi } from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { DeviceService } from "../services/deviceService";
import type { DashboardData } from "../types";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";

export function Dashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const navigate = useNavigate();

  const load = async (soft = false) => {
    if (!soft) setLoading(true);
    try {
      const d = await DeviceService.getDashboard();
      setData(d);
    } catch (e) {
      if (!soft) setData(null);
      setStatusText(
        e instanceof Error ? t("dashboard.refreshFailed", { msg: e.message }) : t("dashboard.refreshFailedShort"),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    };
    void load(false);
    const t = setInterval(tick, 20000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">{t("dashboard.subtitle")}</div>
        </div>
      </div>

      <div className="grid-stats">
        {loading && !data ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <Skeleton height={54} />
            </Card>
          ))
        ) : (
          <>
            <StatCard icon={<Box size={18} />} label="Docker" value={data?.status.dockerRunning ? t("common.status.dockerRunning") : t("common.status.dockerOff")} hint={data?.status.dockerVersion} ok={data?.status.dockerRunning} onClick={() => navigate("/docker")} />
            <StatCard icon={<Wifi size={18} />} label="ADB" value={data?.status.adbRunning ? t("common.status.adbOk") : t("dashboard.adbError")} hint={data?.status.adbVersion} ok={data?.status.adbRunning} onClick={() => navigate("/adb")} />
            <StatCard
              icon={<Smartphone size={18} />}
              label={t("common.panel.onlineDevices")}
              value={String((data?.devices ?? []).filter((d) => d.online && d.adbStatus === "device").length)}
              hint="ADB device"
              ok
              onClick={() => navigate("/devices")}
            />
            <StatCard icon={<Cpu size={18} />} label="CPU" value={`${(data?.status.cpuUsage ?? 0).toFixed(1)}%`} hint={t("dashboard.hint.localUsage")} />
            <StatCard
              icon={<MemoryStick size={18} />}
              label={t("common.panel.memory")}
              value={`${(data?.status.memoryUsage ?? 0).toFixed(1)}%`}
              hint={
                data?.status.memoryTotalMb
                  ? `${data.status.memoryUsedMb} / ${data.status.memoryTotalMb} MB`
                  : t("dashboard.hint.localUsage")
              }
            />
            <StatCard
              icon={<Activity size={18} />}
              label={t("dashboard.casting")}
              value={String((data?.devices ?? []).filter((d) => d.scrcpyStatus === "running").length)}
              hint="Scrcpy running"
              onClick={() => navigate("/devices")}
            />
          </>
        )}
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <Card
          title={t("dashboard.card.deviceStatus")}
          action={
            <Button size="sm" variant="ghost" onClick={() => navigate("/devices")}>
              {t("dashboard.viewAll", { n: data?.devices.length ? ` (${data.devices.length})` : "" })}
            </Button>
          }
        >
          {loading && !data ? (
            <Skeleton count={4} height={42} />
          ) : data?.devices.length ? (
            <div className="stack">
              {data.devices.slice(0, 6).map((d) => (
                <div
                  key={d.id}
                  className="row-between device-row"
                  onClick={() => {
                    setSelected(d.id);
                    navigate(`/devices/${encodeURIComponent(d.id)}`);
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{d.name}</div>
                    <div className="muted mono" style={{ fontSize: 12 }}>
                      {d.serial ? `${d.serial} · ` : ""}
                      Android {d.androidVersion || "?"}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      ADB {d.adbStatus || "—"}
                      {d.dataVolume ? ` · ${d.dataVolume}` : ""}
                    </div>
                  </div>
                  <StatusDot online={d.online && d.adbStatus === "device"} />
                </div>
              ))}
              {data.devices.length > 6 && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {t("dashboard.moreDevices", { n: data.devices.length - 6 })}
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              {t("dashboard.empty.noDevices")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/docker")}>
                {t("common.panel.goCreate")}
              </Button>
            </div>
          )}
        </Card>

        <Card title={t("dashboard.card.notifications")}>
          {data?.notifications?.length ? (
            <div className="stack">
              {data.notifications.map((n, i) => (
                <button
                  key={i}
                  className="notice"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => {
                    if (n.includes("Docker")) navigate("/docker");
                    else if (n.includes("ADB")) navigate("/adb");
                    else if (n.includes("设备")) navigate("/devices");
                    else navigate("/logs");
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              {t("dashboard.empty.noNotifications")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/logs")}>
                {t("dashboard.openLogs")}
              </Button>
            </div>
          )}
        </Card>
      </div>

      <div className="grid-3">
        <Card
          title={t("dashboard.card.recentLogs")}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  sessionStorage.setItem("rdc.logs.source", "all");
                  sessionStorage.setItem("rdc.logs.level", "all");
                  sessionStorage.setItem("rdc.logs.keyword", "");
                } catch {
                  /* ignore */
                }
                navigate("/logs");
              }}
            >
              {t("dashboard.openLogs")}
            </Button>
          }
        >
          {data?.recentLogs?.length ? (
            data.recentLogs.slice(0, 8).map((l) => (
              <button
                key={l.id}
                className={`log-line ${l.level}`}
                style={{ display: "block", width: "100%", textAlign: "left" }}
                onClick={() => {
                  try {
                    sessionStorage.setItem("rdc.logs.source", l.source || "all");
                    sessionStorage.setItem("rdc.logs.level", l.level || "all");
                    sessionStorage.setItem("rdc.logs.keyword", "");
                  } catch {
                    /* ignore */
                  }
                  navigate("/logs");
                }}
              >
                [{l.timestamp}] [{l.source}] {l.message}
              </button>
            ))
          ) : (
            <div className="empty-state">{t("dashboard.empty.noLogs")}</div>
          )}
        </Card>
        <Card
          title={t("dashboard.card.recentScreenshots")}
          action={
            data?.recentScreenshots?.[0] ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void DeviceService.revealInFolder(data.recentScreenshots[0]).catch((e) =>
                    alert(String(e)),
                  )
                }
              >
                {t("dashboard.openFolder")}
              </Button>
            ) : null
          }
        >
          {data?.recentScreenshots?.length ? (
            data.recentScreenshots.map((p) => (
              <button
                key={p}
                className="mono muted"
                style={{ padding: "4px 0", fontSize: 12, textAlign: "left", display: "block" }}
                onClick={() => void DeviceService.revealInFolder(p).catch((e) => alert(String(e)))}
              >
                {p.split(/[/\\]/).pop()}
              </button>
            ))
          ) : (
            <div className="empty-state">
              {t("dashboard.empty.noScreenshots")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/devices")}>
                {t("dashboard.goScreenshot")}
              </Button>
            </div>
          )}
        </Card>
        <Card
          title={t("dashboard.card.recentApks")}
          action={
            data?.recentApks?.[0] ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void DeviceService.revealInFolder(data.recentApks[0]).catch((e) => alert(String(e)))
                }
              >
                {t("dashboard.openFolder")}
              </Button>
            ) : null
          }
        >
          {data?.recentApks?.length ? (
            data.recentApks.map((p) => (
              <button
                key={p}
                className="mono muted"
                style={{ padding: "4px 0", fontSize: 12, textAlign: "left", display: "block" }}
                onClick={() => {
                  try {
                    sessionStorage.setItem("rdc.apk.path", p);
                  } catch {
                    /* ignore */
                  }
                  navigate("/apk");
                }}
              >
                {p.split(/[/\\]/).pop()}
              </button>
            ))
          ) : (
            <div className="empty-state">
              {t("dashboard.empty.noApks")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/apk")}>
                {t("dashboard.goInstall")}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  ok,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  ok?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card hover>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: 0,
          padding: 0,
          color: "inherit",
          cursor: onClick ? "pointer" : "default",
        }}
      >
        <div className="row-between">
          <div className="stat-icon">{icon}</div>
          {ok !== undefined && <StatusDot online={!!ok} label={ok ? "OK" : "ERR"} />}
        </div>
        <div style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
        {hint && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {hint}
          </div>
        )}
      </button>
    </Card>
  );
}
