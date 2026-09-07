import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Monitor,
  MoreHorizontal,
  Camera,
  Package,
  Play,
  RefreshCw,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { askConfirm } from "../lib/dialogs";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { DeviceInfo } from "../types";

const FILTER_KEY = "rdc.devices.filter";
const QUERY_KEY = "rdc.devices.query";
const PICKED_KEY = "rdc.devices.picked";

function readFilter(): "all" | "online" | "offline" {
  try {
    const v = sessionStorage.getItem(FILTER_KEY);
    if (v === "online" || v === "offline" || v === "all") return v;
  } catch {
    /* ignore */
  }
  return "all";
}

export function Devices() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem(PICKED_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [filter, setFilter] = useState<"all" | "online" | "offline">(readFilter);
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(QUERY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [batchReport, setBatchReport] = useState<{
    title: string;
    kind: string;
    items: { id: string; name: string; ok: boolean; detail: string }[];
  } | null>(null);
  const navigate = useNavigate();
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const screenshotDir = useAppStore((s) => s.settings?.screenshotPath);
  const { t } = useI18n();

  const load = async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) setLoading(true);
    try {
      const list = await DeviceService.listDevices();
      setDevices(list);
      const ids = new Set(list.map((d) => d.id));
      setPicked((prev) => prev.filter((id) => ids.has(id)));
      await refreshDevices();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("devices.status.refreshFailedWith", { msg }));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The 15s layout tick refreshes the shared store even when this page has
  // its own list; without syncing, a transient backend hiccup at mount time
  // would keep a stale device list on screen until manual refresh.
  const storeDevices = useAppStore((s) => s.devices);
  const storeDevicesKey = storeDevices.map((d) => `${d.id}:${d.adbStatus}:${d.dockerStatus}`).join("|");
  useEffect(() => {
    if (storeDevices.length) setDevices(storeDevices);
  }, [storeDevicesKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(FILTER_KEY, filter);
      sessionStorage.setItem(QUERY_KEY, query);
      sessionStorage.setItem(PICKED_KEY, JSON.stringify(picked));
    } catch {
      /* ignore */
    }
  }, [filter, query, picked]);

  const run = async (
    id: string,
    action: () => Promise<unknown>,
    msg: string,
    okMsg = t("devices.status.ready"),
  ) => {
    setBusy(id);
    setStatusText(msg);
    try {
      await action();
      await load({ silent: true });
      setStatusText(okMsg);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setStatusText(err);
      void alert(err);
    } finally {
      setBusy(null);
    }
  };

  const togglePick = (id: string) => {
    setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const isOnline = (d: DeviceInfo) => d.online && d.adbStatus === "device";
  const q = query.trim().toLowerCase();
  const visible = devices.filter((d) => {
    if (filter === "online" && !isOnline(d)) return false;
    if (filter === "offline" && isOnline(d)) return false;
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.serial.toLowerCase().includes(q) ||
      d.image.toLowerCase().includes(q) ||
      (d.dataVolume || "").toLowerCase().includes(q) ||
      String(d.adbPort || "").includes(q)
    );
  });
  const selectedDevices = visible.filter((d) => picked.includes(d.id));

  const ensureOnline = async (d: DeviceInfo) => {
    if (d.online && d.adbStatus === "device") return null;
    setStatusText(t("devices.status.connecting", { name: d.name }));
    const conn = await DeviceService.connect(d.serial);
    if (!conn.success) {
      return {
        success: false,
        stderr: conn.stderr || t("devices.err.adbNotReady"),
        stdout: conn.stdout,
      };
    }
    return null;
  };

  const wakeDevice = async (d: DeviceInfo) => {
    const miss = await ensureOnline(d);
    if (miss) return miss;
    return DeviceService.wake(d.serial);
  };

  const batch = async (
    label: string,
    fn: (d: DeviceInfo) => Promise<{ success?: boolean; stderr?: string; stdout?: string } | unknown>,
    kind = "",
  ) => {
    if (selectedDevices.length === 0) {
      setStatusText(t("devices.pickFirst"));
      return;
    }
    setBusy("batch");
    setStatusText(label);
    const items: { id: string; name: string; ok: boolean; detail: string }[] = [];
    try {
      let i = 0;
      for (const d of selectedDevices) {
        i += 1;
        setStatusText(
          t("devices.batch.progress", { label, i, total: selectedDevices.length, name: d.name }),
        );
        try {
          const r = (await fn(d)) as { success?: boolean; stderr?: string; stdout?: string };
          const ok =
            r && typeof r === "object" && "success" in r
              ? !!r.success || `${r.stdout || ""}`.includes("Success")
              : true;
          const detail = ok
            ? (r.stdout || t("devices.success")).trim()
            : (r.stderr || r.stdout || t("devices.failed")).trim();
          items.push({ id: d.id, name: d.name, ok, detail });
        } catch (e) {
          items.push({
            id: d.id,
            name: d.name,
            ok: false,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await load({ silent: true });
      const okCount = items.filter((x) => x.ok).length;
      setBatchReport({
        title: t("devices.batch.resultTitle", { label, ok: okCount, total: items.length }),
        kind,
        items,
      });
      setStatusText(
        t("devices.batch.done", { label, ok: okCount, total: items.length }),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("devices.page.title")}</div>
          <div className="page-subtitle">{t("devices.page.subtitle")}</div>
        </div>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>
          {t("common.refresh")}
        </Button>
      </div>

      {devices.length > 0 && (
        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("devices.search.placeholder")}
            style={{ height: 30, minWidth: 200, padding: "0 10px", borderRadius: 8 }}
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "all" | "online" | "offline")}
            style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
          >
            <option value="all">{t("devices.filter.all", { n: devices.length })}</option>
            <option value="online">{t("devices.filter.online", { n: devices.filter(isOnline).length })}</option>
            <option value="offline">{t("devices.filter.offline", { n: devices.filter((d) => !isOnline(d)).length })}</option>
          </select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setPicked(
                visible.every((d) => picked.includes(d.id))
                  ? picked.filter((id) => !visible.some((d) => d.id === id))
                  : [...new Set([...picked, ...visible.map((d) => d.id)])],
              )
            }
          >
            {visible.length > 0 && visible.every((d) => picked.includes(d.id))
              ? t("devices.unselectAll")
              : t("devices.selectAll")}
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("devices.selectedCount", { n: picked.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={picked.length === 0}
            onClick={() => {
              const text = selectedDevices
                .map((d) => d.serial)
                .filter(Boolean)
                .join("\n");
              if (!text) {
                setStatusText(t("devices.nothingToCopy"));
                return;
              }
              void navigator.clipboard.writeText(text).then(
                () => setStatusText(t("devices.copiedSerials", { n: selectedDevices.length })),
                () => void alert(t("common.panel.copyFailed")),
              );
            }}
          >
            {t("devices.copySerials")}
          </Button>
          <Button
            size="sm"
            disabled={busy === "batch" || picked.length === 0}
            onClick={() =>
              void batch(t("devices.batch.connect"), (d) => DeviceService.connect(d.serial))
            }
          >
            {t("devices.batch.connectShort")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Package size={13} />}
            disabled={busy === "batch" || picked.length === 0}
            onClick={async () => {
              try {
                const apk = await open({
                  multiple: false,
                  directory: false,
                  filters: [{ name: "APK", extensions: ["apk"] }],
                });
                if (typeof apk !== "string" || !apk) return;
                const name = apk.split(/[/\\]/).pop() || apk;
                if (!(await askConfirm(t("devices.confirmInstall", { name, n: picked.length })))) return;
                await batch(t("devices.batch.installWith", { name }), async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  setStatusText(t("devices.installing", { name: d.name }));
                  return DeviceService.installApk(d.serial, apk, true);
                });
              } catch {
                /* cancelled */
              }
            }}
          >
            {t("devices.batch.installApk")}
          </Button>
          <Button
            size="sm"
            icon={<Camera size={13} />}
            disabled={busy === "batch" || picked.length === 0}
            onClick={() =>
              void batch(
                t("devices.batch.screenshot"),
                async (d) => {
                  const woke = await wakeDevice(d);
                  if (woke && woke.success === false) return woke;
                  const shot = await DeviceService.screenshot(d.serial);
                  return {
                    success: shot.success,
                    stdout: shot.path || "",
                    stderr: shot.success ? "" : (shot.error || t("devices.err.screenshot")),
                  };
                },
                "screenshot",
              )
            }
          >
            {t("devices.batch.screenshot")}
          </Button>
          <select
            disabled={busy === "batch" || picked.length === 0}
            defaultValue=""
            style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
            onChange={async (e) => {
              const v = e.target.value;
              e.target.value = "";
              if (!v) return;
              if (v === "disconnect") void batch(t("devices.batch.disconnect"), (d) => DeviceService.disconnect(d.serial));
              if (v === "restart") void batch(t("devices.batch.restart"), (d) => DeviceService.restart(d.id));
              if (v === "stop") {
                if (!(await askConfirm(t("devices.confirmStop", { n: picked.length })))) return;
                void batch(t("devices.batch.stop"), (d) => DeviceService.stop(d.id));
              }
              if (v === "wake") void batch(t("devices.batch.wake"), (d) => wakeDevice(d));
              if (v === "lock") {
                void batch(t("devices.batch.lock"), async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.lock(d.serial);
                });
              }
              if (v === "home") {
                void batch(t("devices.batch.home"), async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.home(d.serial);
                });
              }
              if (v === "back") {
                void batch(t("devices.batch.back"), async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.back(d.serial);
                });
              }
              if (v === "recent") {
                void batch(t("devices.batch.recent"), async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.recent(d.serial);
                });
              }
            }}
          >
            <option value="" disabled>
              {t("devices.moreActions")}
            </option>
            <option value="disconnect">{t("devices.batch.disconnect")}</option>
            <option value="restart">{t("devices.batch.restart")}</option>
            <option value="stop">{t("devices.batch.stop")}</option>
            <option value="wake">{t("devices.batch.wake")}</option>
            <option value="lock">{t("devices.batch.lock")}</option>
            <option value="home">{t("devices.batch.home")}</option>
            <option value="back">{t("devices.batch.back")}</option>
            <option value="recent">{t("devices.batch.recent")}</option>
          </select>
        </div>
      )}

      {batchReport && (
        <Card
          title={batchReport.title}
          action={
            <div className="row">
              {batchReport.kind === "screenshot" && screenshotDir && (
                <Button
                  size="sm"
                  onClick={() =>
                    void DeviceService.revealInFolder(screenshotDir).catch((e) =>
                      void alert(String(e)),
                    )
                  }
                >
                  {t("devices.batchScreenshotDir")}
                </Button>
              )}
              {batchReport.items.some((it) => !it.ok) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const ids = batchReport.items.filter((it) => !it.ok).map((it) => it.id);
                    setPicked(ids);
                    setStatusText(t("devices.selectedFailed", { n: ids.length }));
                  }}
                >
                  {t("devices.selectFailed")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const text = batchReport.items
                    .map((it) => `${it.name}\t${it.ok ? t("devices.success") : t("devices.failed")}\t${it.detail}`)
                    .join("\n");
                  void navigator.clipboard.writeText(text).then(
                    () => setStatusText(t("devices.copiedBatch")),
                    () => setStatusText(t("common.panel.copyFailed")),
                  );
                }}
              >
                {t("devices.copyResult")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBatchReport(null)}>
                {t("common.close")}
              </Button>
            </div>
          }
        >
          <table className="table">
            <thead>
              <tr>
                <th>{t("devices.table.device")}</th>
                <th>{t("devices.table.result")}</th>
                <th>{t("devices.table.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {batchReport.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <button
                      type="button"
                      title={t("devices.openDetail")}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        color: "inherit",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                      onClick={() => {
                        setSelected(it.id);
                        navigate(`/devices/${encodeURIComponent(it.id)}`);
                      }}
                    >
                      {it.name}
                    </button>
                  </td>
                  <td className={it.ok ? "ok" : "bad"}>{it.ok ? t("devices.success") : t("devices.failed")}</td>
                  <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                    {it.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {loading ? (
        <div className="device-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <Skeleton height={160} />
            </Card>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <Card>
          <div className="empty-state">
            {t("devices.empty.noDevices")}
            <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
              <Button size="sm" variant="primary" onClick={() => navigate("/docker")}>
                {t("common.panel.goCreate")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate("/adb")}>
                {t("devices.empty.goAdb")}
              </Button>
            </div>
          </div>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <div className="empty-state">
            {t("devices.empty.filtered")}
            <Button
              size="sm"
              variant="ghost"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              {t("devices.empty.clearFilter")}
            </Button>
          </div>
        </Card>
      ) : (
        <div className="device-grid">
          {visible.map((d) => {
            const online = d.online && d.adbStatus === "device";
            const offline = !online;
            const scrcpyOn = d.scrcpyStatus === "running";
            const hasContainer = Boolean(d.containerId) && d.dockerStatus !== "n/a";
            const cardBusy = busy === d.id || busy === `${d.id}-screen`;
            // 离线：ADB 连接 + 重启/停止；在线：投屏/关闭投屏 + 断开（重启/停止需先断开）
            const canConnect = offline && Boolean(d.serial) && !cardBusy;
            const canScreen = online && !cardBusy;
            const canDisconnect = online && !cardBusy;
            const canRestart = offline && hasContainer && !cardBusy;
            const canStop = offline && hasContainer && !cardBusy;
            const canDetail = !cardBusy;

            return (
            <Card key={d.id} hover>
              <div
                onClick={() => {
                  if (!canDetail) return;
                  setSelected(d.id);
                  navigate(`/devices/${encodeURIComponent(d.id)}`);
                }}
              >
                <div className="row-between">
                  <label className="row" onClick={(e) => e.stopPropagation()} style={{ marginRight: 8 }}>
                    <input
                      type="checkbox"
                      checked={picked.includes(d.id)}
                      onChange={() => togglePick(d.id)}
                    />
                  </label>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{d.name}</div>
                    <div className="muted mono" style={{ fontSize: 12, marginTop: 2 }}>
                      {d.serial || "—"}
                      {d.adbPort ? ` · ADB :${d.adbPort}` : ""}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      Android {d.androidVersion || "—"}
                      {d.image ? ` · ${d.image}` : ""}
                    </div>
                    {d.dataVolume ? (
                      <button
                        className="muted mono"
                        style={{ fontSize: 11, marginTop: 2, textAlign: "left" }}
                        title={t("devices.card.openVolumes")}
                        onClick={(e) => {
                          e.stopPropagation();
                          try {
                            sessionStorage.setItem("rdc.volumes.query", d.dataVolume || "");
                          } catch {
                            /* ignore */
                          }
                          navigate("/volumes");
                        }}
                      >
                        {t("devices.card.volumePrefix", { name: d.dataVolume })}
                      </button>
                    ) : null}
                    {hasContainer && !d.serial ? (
                      <span
                        className="badge warn"
                        style={{ marginTop: 4, alignSelf: "flex-start", cursor: "help" }}
                        title={t("devices.card.noAdbMappingHint")}
                      >
                        {t("devices.card.noAdbMapping")}
                      </span>
                    ) : null}
                  </div>
                  <StatusDot online={online} />
                </div>

                <div className="meta-grid">
                  <Meta label={t("devices.card.adbPort")} value={d.adbPort ? String(d.adbPort) : "—"} />
                  <Meta label="Serial" value={d.serial || "—"} />
                  <Meta label="IP" value={d.ip || "—"} />
                  <Meta label="CPU" value={d.cpu || "—"} />
                  <Meta label="ADB" value={d.adbStatus} />
                  <Meta label="Scrcpy" value={d.scrcpyStatus} />
                  <Meta label="Docker" value={d.dockerStatus || "—"} />
                  <Meta label={t("common.panel.volume")} value={d.dataVolume || "—"} />
                </div>
                {offline ? (
                  <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                    {t("devices.hint.offline")}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                    {scrcpyOn
                      ? t("devices.hint.scrcpyOn")
                      : t("devices.hint.connected")}
                  </div>
                )}
              </div>

              <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant={online && !scrcpyOn ? "primary" : "secondary"}
                  icon={<Monitor size={14} />}
                  loading={busy === `${d.id}-screen`}
                  disabled={!canScreen}
                  title={
                    offline
                      ? t("devices.title.connectFirst")
                      : scrcpyOn
                        ? t("devices.title.stopScrcpy")
                        : t("devices.title.startScrcpy")
                  }
                  onClick={() =>
                    void run(
                      `${d.id}-screen`,
                      async () => {
                        if (scrcpyOn) {
                          const r = await DeviceService.scrcpyStop(d.serial);
                          if (!r.success) {
                            throw new Error(r.stderr || r.stdout || t("devices.err.stopMirror"));
                          }
                        } else {
                          const r = await DeviceService.scrcpyStart(d.serial);
                          if (!r.success) {
                            throw new Error(r.stderr || r.stdout || t("devices.err.startScrcpy"));
                          }
                        }
                      },
                      scrcpyOn ? t("devices.status.mirrorOff", { name: d.name }) : t("devices.status.mirrorOn", { name: d.name }),
                      scrcpyOn ? t("devices.status.mirroringOff") : t("devices.status.mirroringOn"),
                    )
                  }
                >
                  {scrcpyOn ? t("devices.card.stopMirror") : t("devices.card.mirror")}
                </Button>
                <Button
                  size="sm"
                  variant={offline ? "primary" : "secondary"}
                  icon={<Play size={14} />}
                  loading={busy === d.id && offline}
                  disabled={!canConnect}
                  title={online ? t("devices.title.alreadyOnline") : "ADB connect"}
                  onClick={() =>
                    void run(
                      d.id,
                      async () => {
                        const r = await DeviceService.connect(d.serial);
                        if (!r.success) {
                          throw new Error(r.stderr || r.stdout || t("devices.err.adbConnect"));
                        }
                      },
                      t("devices.status.waitBoot", { name: d.name }),
                      t("devices.status.adbReady"),
                    )
                  }
                >
                  {t("devices.card.adbConnect")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<MoreHorizontal size={14} />}
                  disabled={!canDetail}
                  onClick={() => {
                    setSelected(d.id);
                    navigate(`/devices/${encodeURIComponent(d.id)}`);
                  }}
                >
                  {t("devices.card.detail")}
                </Button>
                <select
                  disabled={cardBusy}
                  defaultValue=""
                  style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    if (v === "disconnect") {
                      if (!canDisconnect) return;
                      void run(d.id, () => DeviceService.disconnect(d.serial), t("devices.status.disconnect", { name: d.name }));
                    }
                    if (v === "restart") {
                      if (!canRestart) return;
                      void run(d.id, () => DeviceService.restart(d.id), t("devices.status.restart", { name: d.name }));
                    }
                    if (v === "stop") {
                      if (!canStop) return;
                      void run(d.id, () => DeviceService.stop(d.id), t("devices.status.stop", { name: d.name }));
                    }
                    if (v === "copy" && d.serial) {
                      void navigator.clipboard.writeText(d.serial).then(
                        () => setStatusText(t("common.panel.copied", { value: d.serial })),
                        () => void alert(t("common.panel.copyFailed")),
                      );
                    }
                  }}
                >
                  <option value="" disabled>
                    {t("devices.card.more")}
                  </option>
                  <option value="disconnect" disabled={!canDisconnect}>
                    {t("devices.card.disconnect")}
                  </option>
                  <option value="restart" disabled={!canRestart}>
                    {t("devices.card.restart")}
                  </option>
                  <option value="stop" disabled={!canStop}>
                    {t("devices.card.stop")}
                  </option>
                  <option value="copy" disabled={!d.serial}>
                    {t("devices.card.copySerial")}
                  </option>
                </select>
              </div>
            </Card>
            );
          })}
        </div>
      )}

    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, fontWeight: 560, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}
