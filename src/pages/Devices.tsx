import { useEffect, useMemo, useRef, useState } from "react";
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
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import { normalizeGroupResult } from "../lib/groupControl";
import { runTaskQueue } from "../lib/taskQueue";
import type { DeviceInfo, QueueHandle } from "../types";
import { GroupControlPanel } from "../components/device/GroupControlPanel";
import { ArrangementDialog } from "../components/layout/ArrangementDialog";
import { getAllDeviceMetadata, removeDeviceMetadata } from "../lib/deviceMetadata";

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
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(QUERY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [arrangementOpen, setArrangementOpen] = useState(false);
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [batchReport, setBatchReport] = useState<{
    title: string;
    kind: string;
    items: { id: string; name: string; ok: boolean; detail: string; state: "success" | "failed" | "cancelled" }[];
  } | null>(null);
  const batchHandle = useRef<QueueHandle<DeviceInfo, unknown> | null>(null);
  const retryBatch = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const screenshotDir = useAppStore((s) => s.settings?.screenshotPath);
  const { t } = useI18n();

  useEffect(() => () => {
    // Batch work belongs to this page. Leaving it should cancel queued
    // devices instead of continuing a group action with no visible report.
    batchHandle.current?.cancel();
    batchHandle.current = null;
  }, []);

  const load = async (opts?: { silent?: boolean }): Promise<boolean> => {
    const silent = opts?.silent ?? false;
    if (!silent) setLoading(true);
    try {
      const list = await DeviceService.listDevices();
      setDevices(list);
      const ids = new Set(list.map((d) => d.id));
      setPicked((prev) => prev.filter((id) => ids.has(id)));
      await refreshDevices();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("devices.status.refreshFailedWith", { msg }));
      return false;
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
      const result = await action();
      if (typeof result === "object" && result !== null && "success" in result
        && (result as { success?: unknown }).success !== true) {
        const output = result as { stderr?: unknown; stdout?: unknown };
        throw new Error(String(output.stderr || output.stdout || "操作失败"));
      }
      if (await load({ silent: true })) setStatusText(okMsg);
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
  const metadata = useMemo(() => getAllDeviceMetadata(), [metadataVersion]);
  const currentDeviceKeys = new Set(devices.flatMap((device) => [device.id, device.serial]).filter(Boolean));
  const staleMetadataIds = Object.keys(metadata).filter((id) => !currentDeviceKeys.has(id));
  const groups = [...new Set(Object.values(metadata).map((item) => item.group.trim()).filter(Boolean))].sort();
  const q = query.trim().toLowerCase();
  const visible = devices.filter((d) => {
    if (filter === "online" && !isOnline(d)) return false;
    if (filter === "offline" && isOnline(d)) return false;
    const info = metadata[d.id] || metadata[d.serial];
    if (groupFilter && info?.group !== groupFilter) return false;
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.serial.toLowerCase().includes(q) ||
      d.image.toLowerCase().includes(q) ||
      (d.dataVolume || "").toLowerCase().includes(q) ||
      String(d.adbPort || "").includes(q) ||
      info?.group.toLowerCase().includes(q) ||
      info?.labels.some((label) => label.toLowerCase().includes(q))
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
    targets = selectedDevices,
  ) => {
    if (targets.length === 0) {
      setStatusText(t("devices.pickFirst"));
      return;
    }
    setBusy("batch");
    setStatusText(label);
    try {
      const handle = runTaskQueue<DeviceInfo, unknown>(
        targets,
        async (d, index) => {
          setStatusText(
            t("devices.batch.progress", {
              label,
              i: index + 1,
              total: targets.length,
              name: d.name,
            }),
          );
          return fn(d);
        },
        { concurrency: 2 },
      );
      batchHandle.current = handle;
      const summary = await handle.done;
      const items = summary.results.map((result) => normalizeGroupResult(result.item, result));
      const refreshed = await load({ silent: true });
      const okCount = items.filter((x) => x.ok).length;
      setBatchReport({
        title: t("devices.batch.resultTitle", { label, ok: okCount, total: items.length }),
        kind,
        items,
      });
      retryBatch.current = items.some((item) => !item.ok)
        ? () => {
          const failedIds = new Set(items.filter((item) => !item.ok).map((item) => item.id));
          setPicked([...failedIds]);
          void batch(label, fn, kind, targets.filter((device) => failedIds.has(device.id)));
        }
        : null;
      if (refreshed) {
        setStatusText(summary.cancelled
          ? `${label} 已取消：完成 ${okCount}/${items.length}`
          : t("devices.batch.done", { label, ok: okCount, total: items.length }));
      }
    } finally {
      batchHandle.current = null;
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
        <div className="device-list-toolbar">
          <div className="device-list-toolbar-top">
            <div className="device-list-toolbar-filters">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("devices.search.placeholder")}
                aria-label={t("devices.search.placeholder")}
              />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as "all" | "online" | "offline")}
                aria-label={t("devices.overview.filter")}
              >
                <option value="all">{t("devices.filter.all", { n: devices.length })}</option>
                <option value="online">{t("devices.filter.online", { n: devices.filter(isOnline).length })}</option>
                <option value="offline">{t("devices.filter.offline", { n: devices.filter((d) => !isOnline(d)).length })}</option>
              </select>
              {groups.length > 0 && (
                <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="设备分组过滤">
                  <option value="">全部分组</option>
                  {groups.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              )}
            </div>
          </div>
          <div className="device-list-selection-bar">
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
           {picked.length > 0 && <div className="device-list-bulk-actions">
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
           </div>}
           <div className="device-list-secondary-actions">
           <Button size="sm" variant="ghost" disabled={!visible.length} onClick={() => setArrangementOpen(true)}>
             多设备编排
           </Button>
          {staleMetadataIds.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || busy === "batch"}
              onClick={async () => {
                if (!(await askConfirm(`确定清理 ${staleMetadataIds.length} 条已不存在设备的历史记录吗？`))) return;
                staleMetadataIds.forEach((id) => removeDeviceMetadata(id));
                setMetadataVersion((value) => value + 1);
                setStatusText(`已清理 ${staleMetadataIds.length} 条历史设备记录`);
              }}
            >
               清理失效记录（{staleMetadataIds.length}）
             </Button>
           )}
           </div>
           {picked.length > 0 && <div className="device-list-bulk-actions">
           {busy === "batch" && (
             <Button size="sm" variant="danger" onClick={() => batchHandle.current?.cancel()}>
              取消批量
            </Button>
          )}
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
          </div>}
          </div>
        </div>
      )}

      <GroupControlPanel devices={selectedDevices} disabled={busy === "batch"} onBatch={(label, worker, kind) => batch(label, worker, kind)} />

      {arrangementOpen && <ArrangementDialog devices={visible} setStatusText={setStatusText} onClose={() => setArrangementOpen(false)} />}

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
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!retryBatch.current}
                    onClick={() => retryBatch.current?.()}
                  >
                    重试失败项
                  </Button>
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
                </>
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
                  <td className={it.ok ? "ok" : it.state === "cancelled" ? "muted" : "bad"}>
                    {it.ok ? t("devices.success") : it.state === "cancelled" ? "已取消" : t("devices.failed")}
                  </td>
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
        <section className="device-list-module module" aria-busy="true">
          <div className="device-list-head">
            <span className="device-list-heading">{t("devices.page.title")}</span>
            <span className="muted">…</span>
          </div>
          <div className="device-list-scroll">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="device-list-row device-list-skeleton" key={i}>
                <span className="device-list-row-status" />
                <Skeleton width={14} height={14} />
                <div className="device-list-skeleton-main">
                  <Skeleton width="42%" height={14} />
                  <Skeleton width="68%" height={10} />
                </div>
                <div><Skeleton width="72%" height={10} /></div>
                <div><Skeleton width="82%" height={10} /></div>
                <Skeleton width={116} height={26} />
              </div>
            ))}
          </div>
        </section>
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
        <section className="device-list-module module" aria-label={t("devices.page.title")}>
          <div className="device-list-head">
            <div className="row">
              <span className="device-list-heading">{t("devices.list.registry")}</span>
              <span className="device-list-count">{visible.length} / {devices.length}</span>
            </div>
          </div>
          <div className="device-list-table-head" aria-hidden="true">
            <span />
            <span />
            <span>{t("devices.table.device")}</span>
            <span>{t("devices.table.connection")}</span>
            <span>{t("devices.table.runtime")}</span>
            <span>{t("devices.table.actions")}</span>
          </div>
          <div className="device-list-scroll">
            {visible.map((d) => {
              const online = d.online && d.adbStatus === "device";
              const offline = !online;
              const scrcpyOn = d.scrcpyStatus === "running";
              const hasContainer = Boolean(d.containerId) && d.dockerStatus !== "n/a";
              const deviceMetadata = metadata[d.id] || metadata[d.serial];
              const cardBusy = busy === d.id || busy === `${d.id}-screen`;
              // 离线：ADB 连接 + 重启/停止；在线：投屏/关闭投屏 + 断开（重启/停止需先断开）
              const canConnect = offline && Boolean(d.serial) && !cardBusy;
              const canScreen = online && !cardBusy;
              const canDisconnect = online && !cardBusy;
              const canRestart = offline && hasContainer && !cardBusy;
              const canStop = offline && hasContainer && !cardBusy;
              const canDetail = !cardBusy;

              return (
                <div
                  className={`device-list-row${picked.includes(d.id) ? " is-selected" : ""}`}
                  key={d.id}
                  role="button"
                  tabIndex={canDetail ? 0 : -1}
                  onClick={() => {
                    if (!canDetail) return;
                    setSelected(d.id);
                    navigate(`/devices/${encodeURIComponent(d.id)}`);
                  }}
                  onKeyDown={(e) => {
                    if (canDetail && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setSelected(d.id);
                      navigate(`/devices/${encodeURIComponent(d.id)}`);
                    }
                  }}
                >
                  <span className={`device-list-row-status ${cardBusy ? "is-busy" : online ? "is-online" : "is-offline"}`} aria-hidden="true" />
                  <label className="device-list-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={picked.includes(d.id)}
                      onChange={() => togglePick(d.id)}
                    />
                  </label>
                  <div className="device-list-main">
                    <div className="device-list-name">
                      <strong>{deviceMetadata?.remark || d.name}</strong>
                      {deviceMetadata?.remark && <span className="muted device-list-original-name">{d.name}</span>}
                      <span className={`device-list-state ${online ? "is-online" : "is-offline"}`}>
                        <span className="device-list-state-dot" />
                        {online ? t("common.online") : t("common.offline")}
                      </span>
                    </div>
                    <div className="device-list-serial mono">{d.serial || "—"}{d.adbPort ? ` · :${d.adbPort}` : ""}</div>
                    <div className="device-list-context muted">
                      Android {d.androidVersion || "—"}{d.image ? ` · ${d.image}` : ""}
                    </div>
                    <div className="device-list-subline">
                      {deviceMetadata?.labels.map((label) => <span className="badge info" key={label}>{label}</span>)}
                      {d.dataVolume ? (
                        <button
                          className="device-list-volume muted mono"
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
                        <span className="badge warn" title={t("devices.card.noAdbMappingHint")}>
                          {t("devices.card.noAdbMapping")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="device-list-connection">
                    <strong className={online ? "ok" : "muted"}>{d.adbStatus || (online ? "device" : "offline")}</strong>
                    <span className="mono">{d.adbPort ? `:${d.adbPort}` : t("devices.field.noPort")}</span>
                  </div>
                  <div className="device-list-runtime" aria-label={t("devices.table.runtime")}>
                    <div className="device-list-runtime-cell">
                      <span>{t("devices.field.ip")}</span>
                      <strong className="mono">{d.ip || "—"}</strong>
                    </div>
                    <div className="device-list-runtime-cell">
                      <span>{t("devices.field.cpu")}</span>
                      <strong>{d.cpu || "—"}</strong>
                    </div>
                    <div className="device-list-runtime-cell">
                      <span>{t("devices.field.mirror")}</span>
                      <strong className={scrcpyOn ? "ok" : "muted"}>{scrcpyOn ? "Running" : "—"}</strong>
                    </div>
                  </div>
                  <div className="device-list-actions" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  className="device-list-action-button"
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
                  aria-label={scrcpyOn ? t("devices.card.stopMirror") : t("devices.card.mirror")}
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
                  className="device-list-action-button"
                  variant={offline ? "primary" : "secondary"}
                  icon={<Play size={14} />}
                  loading={busy === d.id && offline}
                  disabled={!canConnect}
                  title={online ? t("devices.title.alreadyOnline") : "ADB connect"}
                  aria-label={t("devices.card.adbConnect")}
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
                  className="device-list-action-button"
                  variant="ghost"
                  icon={<MoreHorizontal size={14} />}
                  disabled={!canDetail}
                  title={t("devices.card.detail")}
                  aria-label={t("devices.card.detail")}
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
                  className="device-list-more"
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
                </div>
              );
            })}
          </div>
        </section>
      )}

    </div>
  );
}
