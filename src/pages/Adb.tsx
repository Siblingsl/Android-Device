import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cable, Link2, RefreshCw, Unplug, Wrench } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService } from "../services/deviceService";
import { askConfirm } from "../lib/dialogs";
import { createRequestSequence } from "../lib/requestSequence";
import { probeTool, type ProbeHit } from "../hooks/useToolProbe";
import { ToolStatus } from "../components/ui/ToolStatus";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { AdbInfo, LanScanResult } from "../types";

export function AdbPage() {
  const [info, setInfo] = useState<AdbInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState(() => {
    try {
      return sessionStorage.getItem("rdc.adb.address") || "127.0.0.1:5555";
    } catch {
      return "127.0.0.1:5555";
    }
  });
  const [tools, setTools] = useState<{ adb?: ProbeHit; docker?: ProbeHit }>({});
  const setStatusText = useAppStore((s) => s.setStatusText);
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const settings = useAppStore((s) => s.settings);
  const navigate = useNavigate();
  const { t } = useI18n();
  const adbOk = tools.adb?.ok !== false;
  const [lanSubnet, setLanSubnet] = useState("");
  const [lanPort, setLanPort] = useState("5555");
  const [lanAuto, setLanAuto] = useState(true);
  const [lanScanning, setLanScanning] = useState(false);
  const [lanResult, setLanResult] = useState<LanScanResult | null>(null);
  const loadSequence = useRef(createRequestSequence()).current;

  useEffect(() => {
    void DeviceService.getLocalSubnet()
      .then((sn) => setLanSubnet((prev) => prev || sn))
      .catch(() => {
        /* backend unavailable */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runLanScan = async () => {
    const subnet = lanSubnet.trim();
    const port = Number(lanPort);
    if (!subnet) {
      setStatusText(t("adb.lan.invalidSubnet"));
      void alert(t("adb.lan.invalidSubnet"));
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatusText(t("adb.lan.invalidPort"));
      void alert(t("adb.lan.invalidPort"));
      return;
    }
    setLanScanning(true);
    setStatusText(t("adb.lan.scanning", { subnet }));
    try {
      const r = await DeviceService.lanScan(subnet, port, lanAuto);
      setLanResult(r);
      if (r.message) {
        setStatusText(r.message);
        void alert(r.message);
      } else {
        setStatusText(
          t("adb.lan.done", {
            found: r.found.length,
            n: r.found.filter((d) => d.connected).length,
          }),
        );
      }
      if (r.connectedCount > 0) await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("adb.lan.scanFailed", { msg }));
      void alert(t("adb.lan.scanFailed", { msg }));
    } finally {
      setLanScanning(false);
    }
  };

  const connectLanDevice = async (addr: string) => {
    setStatusText(t("adb.connecting", { address: addr }));
    const r = await DeviceService.adbConnect(addr);
    setStatusText(r.success ? r.stdout || t("adb.connected") : r.stderr || r.stdout || t("adb.connectFailed"));
    if (!r.success) void alert(r.stderr || r.stdout || t("adb.connectFailed"));
    await load();
    setLanResult((prev) =>
      prev
        ? {
            ...prev,
            found: prev.found.map((d) =>
              d.address === addr
                ? { ...d, connected: r.success, message: (r.stdout || r.stderr || "").trim() }
                : d,
            ),
          }
        : prev,
    );
  };

  const load = async () => {
    const token = loadSequence.begin();
    setLoading(true);
    try {
      const [adb, docker] = await Promise.all([
        probeTool("adb", settings?.adbPath),
        probeTool("docker", settings?.dockerPath),
      ]);
      if (!loadSequence.isCurrent(token)) return;
      setTools({ adb, docker });
      if (adb.ok) {
        const nextInfo = await DeviceService.getAdbInfo();
        if (!loadSequence.isCurrent(token)) return;
        setInfo(nextInfo);
      } else {
        setInfo(null);
      }
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      setStatusText(e instanceof Error ? t("adb.refreshFailedWith", { msg: e.message }) : t("adb.refreshFailed"));
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => loadSequence.invalidate();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.adb.address", address);
    } catch {
      /* ignore */
    }
  }, [address]);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("adb.page.title")}</div>
          <div className="page-subtitle">{t("adb.page.subtitle")}</div>
        </div>
        <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>
          {t("adb.scan")}
        </Button>
      </div>

      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 16 }}>
        <ToolStatus kind="adb" hit={tools.adb} />
        <ToolStatus kind="docker" hit={tools.docker} />
      </div>

      <div className="grid-stats">
        <Card>
          <div className="muted">{t("adb.version")}</div>
          <div style={{ fontWeight: 700 }}>{loading ? "..." : info?.version || "—"}</div>
        </Card>
        <Card>
          <div className="muted">{t("adb.serverStatus")}</div>
          <div style={{ fontWeight: 700, color: info?.serverRunning ? "var(--success)" : "var(--danger)" }}>
            {loading ? "..." : info?.serverRunning ? t("common.status.dockerRunning") : t("adb.serverError")}
          </div>
        </Card>
        <Card>
          <div className="muted">{t("adb.deviceCount")}</div>
          <div style={{ fontWeight: 700 }}>{info?.devices.length ?? 0}</div>
        </Card>
      </div>

      <Card
        title={t("adb.lan.title")}
        action={
          <div className="row">
            <input
              value={lanSubnet}
              onChange={(e) => setLanSubnet(e.target.value)}
              placeholder="192.168.1.0/24"
              title={t("adb.lan.subnet")}
              style={{ height: 30, width: 170, padding: "0 10px", borderRadius: 8 }}
            />
            <input
              value={lanPort}
              onChange={(e) => setLanPort(e.target.value)}
              placeholder="5555"
              title={t("adb.lan.port")}
              style={{ height: 30, width: 76, padding: "0 10px", borderRadius: 8 }}
            />
            <Button
              variant="primary"
              loading={lanScanning}
              disabled={lanScanning}
              onClick={() => void runLanScan()}
            >
              {t("adb.lan.start")}
            </Button>
          </div>
        }
      >
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <label className="row" style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={lanAuto}
              onChange={(e) => setLanAuto(e.target.checked)}
            />
            {t("adb.lan.autoConnect")}
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("adb.lan.hint")}
          </span>
        </div>
        {lanResult && (
          <>
            {lanResult.found.length === 0 ? (
              <div className="empty-state">
                {lanResult.message || t("adb.lan.none", { subnet: lanResult.subnet, scanned: lanResult.scanned })}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("adb.lan.table.address")}</th>
                    <th>{t("adb.table.model")}</th>
                    <th>{t("devices.table.result")}</th>
                    <th>{t("volumes.table.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lanResult.found.map((d) => (
                    <tr key={d.address}>
                      <td className="mono">{d.address}</td>
                      <td>{d.model || "—"}</td>
                      <td className={d.connected ? "ok" : "bad"}>
                        {d.connected ? t("adb.lan.state.connected") : d.message || t("adb.lan.state.failed")}
                      </td>
                      <td>
                        <div className="row">
                          {!d.connected && (
                            <Button size="sm" onClick={() => void connectLanDevice(d.address)}>
                              {t("adb.connect")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSelected(d.address);
                              navigate(`/devices/${encodeURIComponent(d.address)}`);
                            }}
                          >
                            {t("common.open")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t("adb.lan.summary", {
                scanned: lanResult.scanned,
                found: lanResult.found.length,
                n: lanResult.found.filter((d) => d.connected).length,
                ms: lanResult.durationMs,
              })}
            </div>
          </>
        )}
      </Card>

      <div className="grid-2">
        <Card title={t("adb.connectManager")}>
          <div className="field">
            <label>{t("adb.manualAddress")}</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !adbOk) return;
                  e.preventDefault();
                  void (async () => {
                    setStatusText(t("adb.connecting", { address }));
                    const r = await DeviceService.adbConnect(address);
                    setStatusText(r.success ? r.stdout || t("adb.connected") : r.stderr || r.stdout || t("adb.connectFailed"));
                    if (!r.success) void alert(r.stderr || r.stdout || t("adb.connectFailed"));
                    await load();
                  })();
                }}
                placeholder="ip:port"
              />
              <Button
                variant="primary"
                icon={<Link2 size={14} />}
                disabled={!adbOk}
                title={tools.adb && !tools.adb.ok ? t("adb.unavailable", { text: tools.adb.text }) : undefined}
                onClick={async () => {
                  setStatusText(t("adb.connecting", { address }));
                  const r = await DeviceService.adbConnect(address);
                  setStatusText(r.success ? r.stdout || t("adb.connected") : r.stderr || r.stdout || t("adb.connectFailed"));
                  if (!r.success) void alert(r.stderr || r.stdout || t("adb.connectFailed"));
                  await load();
                }}
              >
                {t("adb.connect")}
              </Button>
              <Button
                disabled={!address.includes(":")}
                onClick={() => {
                  setSelected(address.trim());
                  navigate(`/devices/${encodeURIComponent(address.trim())}`);
                }}
              >
                {t("adb.openThis")}
              </Button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
            <Button
              icon={<Cable size={14} />}
              disabled={!adbOk}
              title={tools.adb && !tools.adb.ok ? t("adb.unavailable", { text: tools.adb.text }) : undefined}
              onClick={async () => {
                const r = await DeviceService.adbStartServer();
                setStatusText(r.success ? t("adb.serverStarted") : r.stderr || t("adb.startFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.startFailed"));
                await load();
              }}
            >
              {t("adb.startServer")}
            </Button>
            <Button
              disabled={!adbOk}
              onClick={async () => {
                if (!(await askConfirm(t("adb.confirmKillServer")))) return;
                const r = await DeviceService.adbKillServer();
                setStatusText(r.success ? t("adb.serverStopped") : r.stderr || t("adb.stopFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.stopFailed"));
                await load();
              }}
            >
              {t("adb.stopServer")}
            </Button>
            <Button
              icon={<RefreshCw size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                const r = await DeviceService.adbRestartServer();
                setStatusText(r.success ? t("adb.serverRestarted") : r.stderr || t("adb.restartFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.restartFailed"));
                await load();
              }}
            >
              {t("adb.restartServer")}
            </Button>
            <Button
              variant="secondary"
              icon={<Wrench size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                setStatusText(t("adb.fixing"));
                const r = await DeviceService.adbAutoFix();
                setStatusText(r.success ? r.stdout || t("adb.fixDone") : r.stderr || t("adb.fixFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.fixFailed"));
                await load();
              }}
            >
              {t("adb.autoFix")}
            </Button>
            <Button
              icon={<Unplug size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                if (!(await askConfirm(t("adb.confirmDisconnectAll")))) return;
                const r = await DeviceService.adbDisconnect("");
                setStatusText(r.success ? t("adb.disconnectedAll") : r.stderr || t("adb.disconnectFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.disconnectFailed"));
                await load();
              }}
            >
              {t("adb.disconnectAll")}
            </Button>
          </div>
        </Card>

        <Card title={t("adb.deviceList")}>
          {loading ? (
            <Skeleton count={4} height={32} />
          ) : info?.devices.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>{t("adb.table.state")}</th>
                  <th>{t("adb.table.model")}</th>
                  <th>{t("adb.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {info.devices.map((d) => (
                  <tr key={d.serial}>
                    <td className="mono">
                      <button
                        type="button"
                        title={t("adb.copySerial")}
                        style={{
                          textDecoration: "underline",
                          background: "none",
                          border: 0,
                          padding: 0,
                          color: "inherit",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          void copyText(d.serial).then(
                            () => setStatusText(t("common.panel.copied", { value: d.serial })),
                            () => setStatusText(t("common.panel.copyFailed")),
                          );
                        }}
                      >
                        {d.serial}
                      </button>
                    </td>
                    <td>
                      <span className={`badge ${d.state === "device" ? "online" : "warn"}`}>{d.state}</span>
                    </td>
                    <td>{d.model || d.product || "—"}</td>
                    <td>
                      <div className="row">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelected(d.serial);
                            navigate(`/devices/${encodeURIComponent(d.serial)}`);
                          }}
                        >
                          {t("common.open")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={!adbOk}
                          onClick={async () => {
                            const r = await DeviceService.adbReconnect(d.serial);
                            setStatusText(r.success ? t("adb.reconnected", { serial: d.serial }) : r.stderr || t("adb.restartFailed"));
                            if (!r.success) void alert(r.stderr || r.stdout || t("adb.restartFailed"));
                            await load();
                          }}
                        >
                          {t("adb.reconnect")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!adbOk}
                          onClick={async () => {
                            const r = await DeviceService.adbDisconnect(d.serial);
                            setStatusText(r.success ? t("adb.disconnected", { serial: d.serial }) : r.stderr || t("adb.disconnectFailed"));
                            if (!r.success) void alert(r.stderr || r.stdout || t("adb.disconnectFailed"));
                            await load();
                          }}
                        >
                          {t("adb.disconnect")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              {t("adb.noDevices")}
              <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
                <Button size="sm" variant="primary" onClick={() => navigate("/docker")}>
                  {t("common.panel.goCreate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate("/devices")}>
                  {t("devices.page.title")}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
