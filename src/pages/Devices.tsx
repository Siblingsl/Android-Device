import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Monitor,
  MoreHorizontal,
  Camera,
  Package,
  Play,
  RefreshCw,
  Download,
  Upload,
  LayoutGrid,
  List,
  Pencil,
  Check,
  X,
  History,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { copyText } from "../lib/clipboard";
import { askConfirm } from "../lib/dialogs";
import { createRequestSequence } from "../lib/requestSequence";
import { batchFileName, batchRemotePath } from "../lib/batchOperations";
import {
  readDeviceNotes,
  persistDeviceNotes,
  updateDeviceNote,
  readOfflineDeviceHistory,
  persistOfflineDeviceHistory,
  rememberDevices,
  removeOfflineDevice,
  type DeviceNoteMap,
  type OfflineDeviceHistoryEntry,
} from "../lib/deviceMetadata";
import {
  DEFAULT_SCRCPY_LAYOUT,
  normalizeScrcpyLayout,
  scrcpyWindowPlacement,
  type ScrcpyLayoutConfig,
} from "../lib/scrcpyWindowLayout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DeviceBroadcastInput } from "../components/device/DeviceBroadcastInput";
import { DeviceHoverCard } from "../components/device/DeviceHoverCard";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { DeviceInfo } from "../types";

const FILTER_KEY = "rdc.devices.filter";
const QUERY_KEY = "rdc.devices.query";
const PICKED_KEY = "rdc.devices.picked";
const VIEW_KEY = "rdc.devices.view";
const BATCH_HISTORY_KEY = "rdc.devices.batchHistory";
const SCRCPY_LAYOUT_KEY = "rdc.devices.scrcpyLayout";
const MAX_BATCH_HISTORY = 10;
const BATCH_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type DevicesView = "table" | "cards";
type HoverPlacement = "bottom-left" | "bottom-right" | "top-left" | "top-right";

function getDeviceHoverPlacement(rect: DOMRect, viewportWidth: number, viewportHeight: number): HoverPlacement {
  const cardWidth = 300;
  const cardHeight = 310;
  const edgeGap = 14;
  const vertical = rect.bottom + cardHeight + edgeGap > viewportHeight && rect.top > cardHeight + edgeGap ? "top" : "bottom";
  const horizontal = rect.left + cardWidth + edgeGap > viewportWidth && rect.right - cardWidth > edgeGap ? "right" : "left";
  return `${vertical}-${horizontal}` as HoverPlacement;
}

function readDevicesView(): DevicesView {
  try {
    return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

function readScrcpyLayout(): ScrcpyLayoutConfig {
  try {
    const raw = localStorage.getItem(SCRCPY_LAYOUT_KEY);
    if (!raw) return DEFAULT_SCRCPY_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<ScrcpyLayoutConfig>;
    return normalizeScrcpyLayout(parsed);
  } catch {
    return DEFAULT_SCRCPY_LAYOUT;
  }
}

type BatchAction = (device: DeviceInfo) => Promise<unknown>;
type BatchReportItem = { id: string; name: string; ok: boolean; detail: string };
type BatchHistoryItem = {
  id: string;
  title: string;
  kind: string;
  items: BatchReportItem[];
  createdAt: number;
};
type BatchReport = BatchHistoryItem & {
  retry?: { label: string; kind: string; action: BatchAction };
};

type BatchResultFilter = "all" | "success" | "failed";
type BatchFailureReason = "offline" | "unauthorized" | "timeout" | "skipped" | "other";
type BatchReasonFilter = "all" | BatchFailureReason;

function classifyBatchFailure(detail: string): BatchFailureReason {
  const normalized = detail.trim().toLowerCase();
  if (/未执行|not executed|stopped by user/.test(normalized)) return "skipped";
  if (/unauthorized|unauth|未授权/.test(normalized)) return "unauthorized";
  if (/timeout|timed out|超时/.test(normalized)) return "timeout";
  if (
    /offline|not ready|未就绪|no devices|device not found|找不到设备|离线/.test(normalized)
  ) {
    return "offline";
  }
  return "other";
}

function isBatchReportItem(value: unknown): value is BatchReportItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.name === "string" &&
    typeof item.ok === "boolean" &&
    typeof item.detail === "string"
  );
}

function pruneBatchHistory(history: BatchHistoryItem[], now = Date.now()): BatchHistoryItem[] {
  const cutoff = now - BATCH_HISTORY_MAX_AGE_MS;
  return history.filter((entry) => entry.createdAt >= cutoff).slice(0, MAX_BATCH_HISTORY);
}

function readBatchHistory(): BatchHistoryItem[] {
  try {
    const raw = localStorage.getItem(BATCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((value): value is BatchHistoryItem => {
        if (!value || typeof value !== "object") return false;
        const item = value as Record<string, unknown>;
        return (
          typeof item.id === "string" &&
          item.id.length > 0 &&
          typeof item.title === "string" &&
          typeof item.kind === "string" &&
          typeof item.createdAt === "number" &&
          Number.isFinite(item.createdAt) &&
          Array.isArray(item.items) &&
          item.items.length > 0 &&
          item.items.every(isBatchReportItem)
        );
      });
    return pruneBatchHistory(valid);
  } catch {
    return [];
  }
}

function DeviceNoteEditor({
  deviceName,
  value,
  onSave,
}: {
  deviceName: string;
  value?: string;
  onSave: (value: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  const startEditing = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  if (editing) {
    return (
      <form
        className="device-note-editor"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
          setEditing(false);
        }}
      >
        <input
          autoFocus
          value={draft}
          maxLength={80}
          aria-label={`${t("devices.note.input")} ${deviceName}`}
          placeholder={t("devices.note.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" icon={<Check size={12} />} aria-label={t("devices.note.save")} />
        <Button
          size="sm"
          variant="ghost"
          icon={<X size={12} />}
          aria-label={t("devices.note.cancel")}
          onClick={() => setEditing(false)}
        />
      </form>
    );
  }

  return (
    <div className="device-note-line">
      {value ? <span className="device-note-value" title={value}>{value}</span> : <span className="device-note-empty">{t("devices.note.empty")}</span>}
      <button
        type="button"
        className="device-note-edit"
        aria-label={`${t("devices.note.edit")} ${deviceName}`}
        title={t("devices.note.edit")}
        onClick={startEditing}
      >
        <Pencil size={11} />
      </button>
    </div>
  );
}

function persistBatchHistory(history: BatchHistoryItem[]) {
  try {
    localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_BATCH_HISTORY)));
  } catch {
    /* ignore unavailable or full local storage */
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function serializeBatchResultsText(
  items: BatchReportItem[],
  headers: readonly [string, string, string],
  successLabel: string,
  failedLabel: string,
): string {
  return [
    headers.join("\t"),
    ...items.map((item) =>
      [item.name, item.ok ? successLabel : failedLabel, item.detail].join("\t"),
    ),
  ].join("\n");
}

function serializeBatchResultsCsv(
  items: BatchReportItem[],
  headers: readonly [string, string, string, string],
  successLabel: string,
  failedLabel: string,
): string {
  const rows = items.map((item) =>
    [item.name, item.id, item.ok ? successLabel : failedLabel, item.detail]
      .map(csvField)
      .join(","),
  );
  return `\uFEFF${headers.map(csvField).join(",")}\r\n${rows.join("\r\n")}`;
}

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
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
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
  const [devicesView, setDevicesView] = useState<DevicesView>(readDevicesView);
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const [hoverPlacement, setHoverPlacement] = useState<HoverPlacement>("bottom-left");
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(QUERY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const [batchHistory, setBatchHistory] = useState<BatchHistoryItem[]>(readBatchHistory);
  const [batchFilter, setBatchFilter] = useState<BatchResultFilter>("all");
  const [batchReasonFilter, setBatchReasonFilter] = useState<BatchReasonFilter>("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deviceNotes, setDeviceNotes] = useState<DeviceNoteMap>(readDeviceNotes);
  const [offlineHistory, setOfflineHistory] = useState<OfflineDeviceHistoryEntry[]>(readOfflineDeviceHistory);
  const [offlineHistoryOpen, setOfflineHistoryOpen] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    label: string;
    current: number;
    total: number;
    name: string;
    stopping: boolean;
  } | null>(null);
  const navigate = useNavigate();
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const screenshotDir = useAppStore((s) => s.settings?.screenshotPath);
  const [scrcpyLayout, setScrcpyLayout] = useState<ScrcpyLayoutConfig>(readScrcpyLayout);
  const { t } = useI18n();
  const loadSequence = useRef(createRequestSequence()).current;
  const localLoadActive = useRef(false);
  const loadingRequest = useRef<number | null>(null);
  const batchCancelRequested = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(SCRCPY_LAYOUT_KEY, JSON.stringify(scrcpyLayout));
    } catch {
      /* ignore unavailable or full local storage */
    }
  }, [scrcpyLayout]);

  const updateScrcpyLayout = (key: keyof ScrcpyLayoutConfig, value: string) => {
    setScrcpyLayout((current) => normalizeScrcpyLayout({ ...current, [key]: Number(value) }));
  };

  const load = async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    const token = loadSequence.begin();
    localLoadActive.current = true;
    if (!silent) {
      loadingRequest.current = token;
      setLoading(true);
    }
    try {
      const list = await DeviceService.listDevices();
      if (!loadSequence.isCurrent(token)) return;
      setDevices(list);
      const nextOfflineHistory = rememberDevices(readOfflineDeviceHistory(), list);
      setOfflineHistory(nextOfflineHistory);
      persistOfflineDeviceHistory(nextOfflineHistory);
      const ids = new Set(list.map((d) => d.id));
      setPicked((prev) => prev.filter((id) => ids.has(id)));
      await refreshDevices();
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("devices.status.refreshFailedWith", { msg }));
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      localLoadActive.current = false;
      if (loadingRequest.current !== null) {
        loadingRequest.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    loadSequence.invalidate();
    localLoadActive.current = false;
  }, [loadSequence]);

  // The 15s layout tick refreshes the shared store even when this page has
  // its own list; without syncing, a transient backend hiccup at mount time
  // would keep a stale device list on screen until manual refresh.
  const storeDevices = useAppStore((s) => s.devices);
  const storeDevicesKey = storeDevices.map((d) => `${d.id}:${d.adbStatus}:${d.dockerStatus}`).join("|");
  useEffect(() => {
    if (!localLoadActive.current && storeDevices.length) setDevices(storeDevices);
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

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, devicesView);
    } catch {
      /* ignore unavailable storage */
    }
  }, [devicesView]);

  useEffect(() => {
    persistBatchHistory(batchHistory);
  }, [batchHistory]);

  useEffect(() => {
    persistDeviceNotes(deviceNotes);
  }, [deviceNotes]);

  useEffect(() => {
    persistOfflineDeviceHistory(offlineHistory);
  }, [offlineHistory]);

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
      await load({ silent: true });
      if (
        result &&
        typeof result === "object" &&
        "success" in result &&
        (result as { success?: boolean }).success === false
      ) {
        const shellResult = result as { stderr?: string; stdout?: string };
        const err = shellResult.stderr?.trim() || shellResult.stdout?.trim() || t("devices.status.actionFailed");
        setStatusText(err);
        void alert(err);
        return;
      }
      setStatusText(okMsg);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setStatusText(err);
      void alert(err);
    } finally {
      setBusy(null);
    }
  };

  const confirmAndRun = async (
    id: string,
    confirmMessage: string,
    action: () => Promise<unknown>,
    statusMessage: string,
  ) => {
    setPendingConfirmation(id);
    try {
      if (!(await askConfirm(confirmMessage))) return;
      await run(id, action, statusMessage);
    } finally {
      setPendingConfirmation(null);
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
  const onlineVisible = visible.filter(isOnline);
  const allOnlineVisiblePicked =
    onlineVisible.length > 0 && onlineVisible.every((d) => picked.includes(d.id));

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
    fn: BatchAction,
    kind = "",
    targetDevices = selectedDevices,
  ): Promise<boolean> => {
    if (targetDevices.length === 0) {
      setStatusText(t("devices.pickFirst"));
      return false;
    }
    batchCancelRequested.current = false;
    setBusy("batch");
    setBatchProgress({ label, current: 0, total: targetDevices.length, name: "", stopping: false });
    setStatusText(label);
    const items: BatchReportItem[] = [];
    try {
      for (let i = 0; i < targetDevices.length; i += 1) {
        const d = targetDevices[i];
        if (batchCancelRequested.current) {
          items.push({
            id: d.id,
            name: d.name,
            ok: false,
            detail: t("devices.batch.skipped"),
          });
          continue;
        }
        setBatchProgress({
          label,
          current: i + 1,
          total: targetDevices.length,
          name: d.name,
          stopping: false,
        });
        setStatusText(
          t("devices.batch.progress", { label, i: i + 1, total: targetDevices.length, name: d.name }),
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
      const stopped = batchCancelRequested.current;
      const createdAt = Date.now();
      const historyEntry: BatchHistoryItem = {
        id: `${createdAt}-${items.length}`,
        title: t(stopped ? "devices.batch.cancelledTitle" : "devices.batch.resultTitle", {
          label,
          ok: okCount,
          total: items.length,
        }),
        kind,
        items,
        createdAt,
      };
      setBatchReport({
        ...historyEntry,
        retry: { label, kind, action: fn },
      });
      setBatchFilter("all");
      setBatchReasonFilter("all");
      setBatchHistory((history) => [
        historyEntry,
        ...history.filter((entry) => entry.id !== historyEntry.id),
      ].slice(0, MAX_BATCH_HISTORY));
      setStatusText(
        t(stopped ? "devices.batch.cancelled" : "devices.batch.done", {
          label,
          ok: okCount,
          total: items.length,
        }),
      );
      return okCount === items.length;
    } finally {
      setBusy(null);
      setBatchProgress(null);
      batchCancelRequested.current = false;
    }
  };

  const retryBatchItems = (items: BatchReportItem[]) => {
    if (!batchReport?.retry || busy === "batch") return;
    const failedIds = new Set(items.filter((item) => !item.ok).map((item) => item.id));
    const retryDevices = devices.filter((device) => failedIds.has(device.id));
    if (retryDevices.length === 0) {
      setStatusText(t("devices.batch.retryUnavailable"));
      return;
    }
    const { label, kind, action } = batchReport.retry;
    setBatchReport(null);
    setBatchFilter("all");
    setBatchReasonFilter("all");
    void batch(label, action, kind, retryDevices);
  };

  const retryFailedBatch = () => {
    retryBatchItems(batchReport?.items.filter((item) => !item.ok) ?? []);
  };

  const retrySelectedBatchReason = () => {
    if (batchReasonFilter === "all") {
      retryFailedBatch();
      return;
    }
    retryBatchItems(
      batchReport?.items.filter(
        (item) => !item.ok && classifyBatchFailure(item.detail) === batchReasonFilter,
      ) ?? [],
    );
  };

  const exportBatchCsv = async (
    items = batchReport?.items ?? [],
    defaultName = "redroid-batch-results",
    successKey = "devices.exportedBatch",
  ) => {
    if (!batchReport || items.length === 0) return;
    try {
      const path = await save({
        defaultPath: `${defaultName}-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      const saved = await DeviceService.exportLogs(
        path,
        serializeBatchResultsCsv(
          items,
          [
            t("devices.table.device"),
            t("devices.table.id"),
            t("devices.table.result"),
            t("devices.table.detail"),
          ],
          t("devices.success"),
          t("devices.failed"),
        ),
      );
      const outputPath = saved || path;
      setStatusText(t(successKey, { path: outputPath }));
      if (await askConfirm(t("devices.revealExportConfirm", { path: outputPath }))) {
        await DeviceService.revealInFolder(outputPath);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setStatusText(t("devices.exportFailed", { error }));
      void alert(error);
    }
  };

  const copyBatchResults = (items: BatchReportItem[], successKey: string) => {
    const text = serializeBatchResultsText(
      items,
      [t("devices.table.device"), t("devices.table.result"), t("devices.table.detail")],
      t("devices.success"),
      t("devices.failed"),
    );
    void copyText(text).then(
      () => setStatusText(t(successKey)),
      () => setStatusText(t("common.panel.copyFailed")),
    );
  };

  const deleteBatchHistory = async (entry: BatchHistoryItem) => {
    if (!(await askConfirm(t("devices.batch.confirmDelete", { title: entry.title })))) return;
    setBatchHistory((history) => history.filter((item) => item.id !== entry.id));
  };

  const clearBatchHistory = async () => {
    if (!(await askConfirm(t("devices.batch.confirmClear")))) return;
    setBatchHistory([]);
    setHistoryOpen(false);
  };

  const cancelBatch = () => {
    if (busy !== "batch" || batchCancelRequested.current) return;
    batchCancelRequested.current = true;
    setBatchProgress((progress) => progress ? { ...progress, stopping: true } : progress);
    setStatusText(t("devices.batch.stopping"));
  };

  const visibleBatchItems = batchReport
    ? batchReport.items.filter((item) => {
        const statusMatches =
          batchFilter === "all" || (batchFilter === "success" ? item.ok : !item.ok);
        const reasonMatches =
          batchReasonFilter === "all" ||
          (!item.ok && classifyBatchFailure(item.detail) === batchReasonFilter);
        return statusMatches && reasonMatches;
      })
    : [];
  const failedBatchItems = batchReport?.items.filter((item) => !item.ok) ?? [];
  const successfulBatchCount = batchReport?.items.filter((item) => item.ok).length ?? 0;
  const batchFailureReasonLabel = (reason: BatchFailureReason) => {
    switch (reason) {
      case "offline":
        return t("devices.batch.reasonOffline");
      case "unauthorized":
        return t("devices.batch.reasonUnauthorized");
      case "timeout":
        return t("devices.batch.reasonTimeout");
      case "skipped":
        return t("devices.batch.reasonSkipped");
      default:
        return t("devices.batch.reasonOther");
    }
  };
  const batchFailureReasonHint = (reason: BatchFailureReason) => {
    switch (reason) {
      case "offline":
        return t("devices.batch.reasonOfflineHint");
      case "unauthorized":
        return t("devices.batch.reasonUnauthorizedHint");
      case "timeout":
        return t("devices.batch.reasonTimeoutHint");
      case "skipped":
        return t("devices.batch.reasonSkippedHint");
      default:
        return t("devices.batch.reasonOtherHint");
    }
  };
  const batchFailureReasonCount = (reason: BatchFailureReason) =>
    failedBatchItems.filter((item) => classifyBatchFailure(item.detail) === reason).length;
  const selectedReasonFailedCount =
    batchReasonFilter === "all" ? 0 : batchFailureReasonCount(batchReasonFilter);
  const historicalOffline = offlineHistory
    .filter((entry) => !devices.some((device) => device.id === entry.device.id))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const saveDeviceNote = (id: string, value: string) => {
    setDeviceNotes((current) => updateDeviceNote(current, id, value));
  };
  const removeOfflineHistory = (id: string) => {
    setOfflineHistory((current) => removeOfflineDevice(current, id));
  };
  const clearOfflineHistory = async () => {
    if (!(await askConfirm(t("devices.offlineHistory.confirmClear")))) return;
    setOfflineHistory([]);
    setOfflineHistoryOpen(false);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("devices.page.title")}</div>
          <div className="page-subtitle">{t("devices.page.subtitle")}</div>
        </div>
        <div className="row">
          {historicalOffline.length > 0 && (
            <Button
              variant="ghost"
              icon={<History size={15} />}
              aria-expanded={offlineHistoryOpen}
              onClick={() => setOfflineHistoryOpen((open) => !open)}
            >
              {t("devices.offlineHistory.button", { n: historicalOffline.length })}
            </Button>
          )}
          {batchHistory.length > 0 && (
            <Button
              variant="ghost"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {t("devices.batch.history")}
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<RefreshCw size={15} />}
            loading={loading}
            onClick={() => void load()}
          >
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      {offlineHistoryOpen && historicalOffline.length > 0 && (
        <Card
          className="offline-device-history-card"
          title={t("devices.offlineHistory.title")}
          action={
            <div className="row">
              <Button size="sm" variant="danger" onClick={() => void clearOfflineHistory()}>
                {t("devices.offlineHistory.clear")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOfflineHistoryOpen(false)}>
                {t("common.close")}
              </Button>
            </div>
          }
        >
          <div className="offline-device-history-list">
            {historicalOffline.map((entry) => {
              const historicalDevice = entry.device;
              const historicalBusy = busy === historicalDevice.id;
              return (
                <div className="offline-device-history-item" key={historicalDevice.id}>
                  <div className="offline-device-history-identity">
                    <div className="offline-device-history-name">{historicalDevice.name}</div>
                    <div className="muted mono">{historicalDevice.serial || "—"}</div>
                    <div className="muted offline-device-history-time">
                      {t("devices.offlineHistory.lastSeen", { time: new Date(entry.lastSeenAt).toLocaleString() })}
                    </div>
                    {deviceNotes[historicalDevice.id] ? (
                      <div className="device-note-history">{deviceNotes[historicalDevice.id]}</div>
                    ) : null}
                  </div>
                  <div className="offline-device-history-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<RotateCcw size={12} />}
                      loading={historicalBusy}
                      disabled={!historicalDevice.serial}
                      title={!historicalDevice.serial ? t("devices.offlineHistory.noSerial") : undefined}
                      onClick={() =>
                        void run(
                          historicalDevice.id,
                          () => DeviceService.connect(historicalDevice.serial),
                          t("devices.status.connecting", { name: historicalDevice.name }),
                          t("devices.status.adbReady"),
                        )
                      }
                    >
                      {t("devices.offlineHistory.reconnect")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      aria-label={`${t("devices.offlineHistory.remove")} ${historicalDevice.name}`}
                      onClick={() => removeOfflineHistory(historicalDevice.id)}
                    >
                      {t("devices.offlineHistory.remove")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {historyOpen && (
        <Card
          title={t("devices.batch.historyTitle")}
          action={
            <div className="row">
              <Button size="sm" variant="danger" onClick={() => void clearBatchHistory()}>
                {t("devices.batch.historyClear")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(false)}>
                {t("common.close")}
              </Button>
            </div>
          }
        >
          <div style={{ display: "grid", gap: 8 }}>
            {batchHistory.map((entry) => {
              const ok = entry.items.filter((item) => item.ok).length;
              return (
                <div key={entry.id} className="row" style={{ justifyContent: "space-between" }}>
                  <div style={{ minWidth: 0 }}>
                    <div>{entry.title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t("devices.batch.historySummary", {
                        ok,
                        total: entry.items.length,
                        time: new Date(entry.createdAt).toLocaleString(),
                      })}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setBatchReport(entry);
                      setBatchFilter("all");
                      setBatchReasonFilter("all");
                      setHistoryOpen(false);
                    }}
                  >
                    {t("devices.batch.historyOpen")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void deleteBatchHistory(entry)}
                  >
                    {t("devices.batch.historyDelete")}
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

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
          <div className="devices-view-toggle" role="group" aria-label={t("devices.view.label")}>
            <Button
              size="sm"
              variant={devicesView === "table" ? "primary" : "ghost"}
              icon={<List size={13} />}
              aria-pressed={devicesView === "table"}
              onClick={() => setDevicesView("table")}
            >
              {t("devices.view.table")}
            </Button>
            <Button
              size="sm"
              variant={devicesView === "cards" ? "primary" : "ghost"}
              icon={<LayoutGrid size={13} />}
              aria-pressed={devicesView === "cards"}
              onClick={() => setDevicesView("cards")}
            >
              {t("devices.view.cards")}
            </Button>
          </div>
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
          <Button
            size="sm"
            variant="ghost"
            disabled={onlineVisible.length === 0}
            onClick={() => {
              const onlineIds = new Set(onlineVisible.map((d) => d.id));
              setPicked((current) =>
                allOnlineVisiblePicked
                  ? current.filter((id) => !onlineIds.has(id))
                  : [...new Set([...current, ...onlineVisible.map((d) => d.id)])],
              );
            }}
          >
            {allOnlineVisiblePicked ? t("devices.unselectOnline") : t("devices.selectAllOnline")}
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("devices.selectedCount", { n: picked.length })}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("devices.visibleSelectedCount", { n: selectedDevices.length })}
          </span>
          <details className="batch-layout-details">
            <summary>{t("devices.layout.title")}</summary>
            <div className="batch-layout-fields">
              <label>
                {t("devices.layout.columns")}
                <input
                  aria-label={t("devices.layout.columns")}
                  type="number"
                  min={1}
                  max={8}
                  value={scrcpyLayout.columns}
                  onChange={(event) => updateScrcpyLayout("columns", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <label>
                {t("devices.layout.width")}
                <input
                  aria-label={t("devices.layout.width")}
                  type="number"
                  min={240}
                  max={1600}
                  value={scrcpyLayout.width}
                  onChange={(event) => updateScrcpyLayout("width", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <label>
                {t("devices.layout.height")}
                <input
                  aria-label={t("devices.layout.height")}
                  type="number"
                  min={240}
                  max={1600}
                  value={scrcpyLayout.height}
                  onChange={(event) => updateScrcpyLayout("height", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <label>
                {t("devices.layout.gap")}
                <input
                  aria-label={t("devices.layout.gap")}
                  type="number"
                  min={0}
                  max={120}
                  value={scrcpyLayout.gap}
                  onChange={(event) => updateScrcpyLayout("gap", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <label>
                {t("devices.layout.originX")}
                <input
                  aria-label={t("devices.layout.originX")}
                  type="number"
                  min={-10000}
                  max={10000}
                  value={scrcpyLayout.originX}
                  onChange={(event) => updateScrcpyLayout("originX", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <label>
                {t("devices.layout.originY")}
                <input
                  aria-label={t("devices.layout.originY")}
                  type="number"
                  min={-10000}
                  max={10000}
                  value={scrcpyLayout.originY}
                  onChange={(event) => updateScrcpyLayout("originY", event.target.value)}
                  disabled={busy === "batch"}
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === "batch"}
                onClick={() => setScrcpyLayout(DEFAULT_SCRCPY_LAYOUT)}
              >
                {t("devices.layout.reset")}
              </Button>
            </div>
            <div className="muted batch-layout-hint">{t("devices.layout.hint")}</div>
          </details>
          <DeviceBroadcastInput
            disabled={selectedDevices.length === 0}
            busy={busy}
            onText={(text) =>
              batch(
                t("devices.broadcast.textAction"),
                async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.text(d.serial, text);
                },
                "broadcast-text",
              )
            }
            onKey={(code) =>
              batch(
                t("devices.broadcast.keyAction"),
                async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.keyevent(d.serial, code);
                },
                "broadcast-key",
              )
            }
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedDevices.length === 0}
            onClick={() => {
              const text = selectedDevices
                .map((d) => d.serial)
                .filter(Boolean)
                .join("\n");
              if (!text) {
                setStatusText(t("devices.nothingToCopy"));
                return;
              }
              void copyText(text).then(
                () => setStatusText(t("devices.copiedSerials", { n: selectedDevices.length })),
                () => void alert(t("common.panel.copyFailed")),
              );
            }}
          >
            {t("devices.copySerials")}
          </Button>
          <Button
            size="sm"
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
            onClick={() =>
              void batch(t("devices.batch.connect"), (d) => DeviceService.connect(d.serial))
            }
          >
            {t("devices.batch.connectShort")}
          </Button>
          <Button
            size="sm"
            icon={<Monitor size={13} />}
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
            onClick={() =>
              void batch(
                t("devices.batch.mirror"),
                async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  return DeviceService.scrcpyStart(d.serial);
                },
                "scrcpy",
              )
            }
          >
            {t("devices.batch.mirrorShort")}
          </Button>
          <Button
            size="sm"
            icon={<LayoutGrid size={13} />}
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
            onClick={() => {
              const layoutDevices = selectedDevices;
              void batch(
                t("devices.batch.layoutMirror"),
                async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  const index = layoutDevices.findIndex((item) => item.id === d.id);
                  return DeviceService.scrcpyStartLayout(
                    d.serial,
                    scrcpyWindowPlacement(index, scrcpyLayout),
                  );
                },
                "scrcpy-layout",
                layoutDevices,
              );
            }}
          >
            {t("devices.batch.layoutMirrorShort")}
          </Button>
          <Button
            size="sm"
            icon={<Upload size={13} />}
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
            onClick={async () => {
              try {
                const pickedFiles = await open({ multiple: true, directory: false });
                const files = (Array.isArray(pickedFiles) ? pickedFiles : pickedFiles ? [pickedFiles] : [])
                  .filter((path): path is string => typeof path === "string" && path.length > 0);
                if (files.length === 0) return;
                const target = prompt(t("devices.batch.pushPathPrompt"), "/sdcard/Download");
                if (target === null) return;
                const remoteDirectory = target.trim() || "/sdcard/Download";
                if (!(await askConfirm(t("devices.batch.confirmPush", {
                  n: files.length,
                  target: remoteDirectory,
                  devices: selectedDevices.length,
                })))) return;
                await batch(
                  t("devices.batch.pushMany", { n: files.length }),
                  async (d) => {
                    const miss = await ensureOnline(d);
                    if (miss) return miss;
                    for (const file of files) {
                      const result = await DeviceService.uploadFile(
                        d.serial,
                        file,
                        batchRemotePath(remoteDirectory, file),
                      );
                      if (!result.success) return result;
                    }
                    return {
                      success: true,
                      stdout: t("devices.batch.pushedCount", { n: files.length }),
                      stderr: "",
                    };
                  },
                  "upload",
                );
              } catch {
                /* cancelled */
              }
            }}
          >
            {t("devices.batch.pushShort")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Package size={13} />}
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
            onClick={async () => {
              try {
                const apk = await open({
                  multiple: true,
                  directory: false,
                  filters: [{ name: "APK", extensions: ["apk"] }],
                });
                const apks = (Array.isArray(apk) ? apk : apk ? [apk] : [])
                  .filter((path): path is string => typeof path === "string" && path.toLowerCase().endsWith(".apk"));
                if (apks.length === 0) return;
                const name = batchFileName(apks[0]);
                const label = apks.length === 1
                  ? t("devices.batch.installWith", { name })
                  : t("devices.batch.installMany", { n: apks.length });
                const confirmMessage = apks.length === 1
                  ? t("devices.confirmInstall", { name, n: selectedDevices.length })
                  : t("devices.batch.confirmInstallMany", { n: apks.length, devices: selectedDevices.length });
                if (!(await askConfirm(confirmMessage))) return;
                await batch(label, async (d) => {
                  const miss = await ensureOnline(d);
                  if (miss) return miss;
                  for (const path of apks) {
                    setStatusText(t("devices.installing", { name: d.name }));
                    const result = await DeviceService.installApk(d.serial, path, true);
                    if (!result.success) return result;
                  }
                  return {
                    success: true,
                    stdout: t("devices.batch.installedCount", { n: apks.length }),
                    stderr: "",
                  };
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
            loading={busy === "batch"}
            disabled={busy === "batch" || selectedDevices.length === 0}
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
            disabled={busy === "batch" || selectedDevices.length === 0}
            defaultValue=""
            style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
            onChange={async (e) => {
              const v = e.target.value;
              e.target.value = "";
              if (!v) return;
              if (v === "disconnect") void batch(t("devices.batch.disconnect"), (d) => DeviceService.disconnect(d.serial));
              if (v === "restart") void batch(t("devices.batch.restart"), (d) => DeviceService.restart(d.id));
              if (v === "stop") {
                if (!(await askConfirm(t("devices.confirmStop", { n: selectedDevices.length })))) return;
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

      {batchProgress && (
        <div
          className="row"
          role="status"
          aria-live="polite"
          style={{ marginBottom: 12, flexWrap: "wrap", fontSize: 12 }}
        >
          <span className="muted">
            {batchProgress.stopping
              ? t("devices.batch.stopping")
              : t("devices.batch.progress", {
                  label: batchProgress.label,
                  i: batchProgress.current || 1,
                  total: batchProgress.total,
                  name: batchProgress.name,
                })}
          </span>
          <span className="muted">
            {t("devices.batch.counter", {
              current: batchProgress.current,
              total: batchProgress.total,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={batchProgress.stopping}
            onClick={cancelBatch}
          >
            {batchProgress.stopping ? t("devices.batch.stopping") : t("devices.batch.cancel")}
          </Button>
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
              {batchReport.retry && batchReport.items.some((it) => !it.ok) && (
                <>
                  <Button
                    size="sm"
                    onClick={retryFailedBatch}
                    disabled={busy === "batch"}
                  >
                    {t("devices.retryFailed")}
                  </Button>
                  {batchReasonFilter !== "all" && selectedReasonFailedCount > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={retrySelectedBatchReason}
                      disabled={busy === "batch"}
                    >
                      {t("devices.batch.retryReason")}
                    </Button>
                  )}
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
              {failedBatchItems.length > 0 && (
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      void exportBatchCsv(
                        failedBatchItems,
                        "redroid-batch-failed",
                        "devices.exportedBatchFailed",
                      )
                    }
                  >
                    {t("devices.exportFailedItems")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => copyBatchResults(failedBatchItems, "devices.copiedBatchFailed")}
                  >
                    {t("devices.copyFailed")}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                icon={<Download size={14} />}
                onClick={() => void exportBatchCsv()}
              >
                {t("devices.exportCsv")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copyBatchResults(batchReport.items, "devices.copiedBatch")}
              >
                {t("devices.copyResult")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBatchReport(null)}>
                {t("common.close")}
              </Button>
            </div>
          }
        >
          <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {t("devices.batch.resultSummary", {
                total: batchReport.items.length,
                ok: successfulBatchCount,
                failed: failedBatchItems.length,
              })}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {t("devices.batch.visibleCount", {
                current: visibleBatchItems.length,
                total: batchReport.items.length,
              })}
            </span>
            <select
              aria-label={t("devices.batch.resultFilter")}
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value as BatchResultFilter)}
              style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
            >
              <option value="all">{t("devices.batch.resultAll")}</option>
              <option value="success">{t("devices.batch.resultSuccess")}</option>
              <option value="failed">{t("devices.batch.resultFailed")}</option>
            </select>
            {failedBatchItems.length > 0 && (
              <select
                aria-label={t("devices.batch.reasonFilter")}
                value={batchReasonFilter}
                onChange={(e) => setBatchReasonFilter(e.target.value as BatchReasonFilter)}
                style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
              >
                <option value="all">{t("devices.batch.reasonAll")}</option>
                <option value="offline">
                  {t("devices.batch.reasonOfflineCount", { n: batchFailureReasonCount("offline") })}
                </option>
                <option value="unauthorized">
                  {t("devices.batch.reasonUnauthorizedCount", {
                    n: batchFailureReasonCount("unauthorized"),
                  })}
                </option>
                <option value="timeout">
                  {t("devices.batch.reasonTimeoutCount", { n: batchFailureReasonCount("timeout") })}
                </option>
                <option value="skipped">
                  {t("devices.batch.reasonSkippedCount", { n: batchFailureReasonCount("skipped") })}
                </option>
                <option value="other">
                  {t("devices.batch.reasonOtherCount", { n: batchFailureReasonCount("other") })}
                </option>
              </select>
            )}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t("devices.table.device")}</th>
                <th>{t("devices.table.result")}</th>
                <th>{t("devices.table.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleBatchItems.length > 0 ? (
                visibleBatchItems.map((it) => (
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
                      <div>{it.detail}</div>
                      {!it.ok && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {batchFailureReasonLabel(classifyBatchFailure(it.detail))} · {batchFailureReasonHint(classifyBatchFailure(it.detail))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="muted">
                    {t("devices.batch.noMatches")}
                  </td>
                </tr>
              )}
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
        devicesView === "table" ? (
          <div className="devices-table-shell devices-table-responsive">
            <table className="table devices-table">
              <thead>
                <tr>
                  <th aria-label={t("devices.table.select")} />
                  <th>{t("devices.table.device")}</th>
                  <th>{t("devices.table.status")}</th>
                  <th>{t("devices.table.services")}</th>
                  <th>{t("devices.table.runtime")}</th>
                  <th className="devices-table-action-cell">{t("devices.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => {
                  const online = d.online && d.adbStatus === "device";
                  const offline = !online;
                  const scrcpyOn = d.scrcpyStatus === "running";
                  const hasContainer = Boolean(d.containerId) && d.dockerStatus !== "n/a";
                  const rowActionBusy = busy === d.id || busy === `${d.id}-screen` || pendingConfirmation === d.id;
                  const rowBusy = busy === "batch" || rowActionBusy;
                  const canConnect = offline && Boolean(d.serial) && !rowBusy;
                  const canScreen = online && !rowBusy;
                  const canDisconnect = online && !rowBusy;
                  const canRestart = offline && hasContainer && !rowBusy;
                  const canStop = offline && hasContainer && !rowBusy;
                  const canDetail = !rowBusy;

                  return (
                    <tr key={d.id} className="devices-table-row">
                      <td className="devices-table-check">
                        <input
                          type="checkbox"
                          aria-label={`${t("devices.table.select")} ${d.name}`}
                          checked={picked.includes(d.id)}
                          onChange={() => togglePick(d.id)}
                        />
                      </td>
                      <td>
                        <div
                          className="devices-table-identity devices-table-hover-anchor"
                          data-hover-placement={hoveredDeviceId === d.id ? hoverPlacement : undefined}
                          onMouseEnter={(event) => {
                            setHoveredDeviceId(d.id);
                            setHoverPlacement(getDeviceHoverPlacement(event.currentTarget.getBoundingClientRect(), window.innerWidth, window.innerHeight));
                          }}
                          onMouseLeave={() => setHoveredDeviceId(null)}
                          onFocus={(event) => {
                            setHoveredDeviceId(d.id);
                            setHoverPlacement(getDeviceHoverPlacement(event.currentTarget.getBoundingClientRect(), window.innerWidth, window.innerHeight));
                          }}
                          onBlur={(event) => {
                            const next = event.relatedTarget;
                            if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                              setHoveredDeviceId(null);
                            }
                          }}
                        >
                          <button
                            type="button"
                            className="devices-table-name"
                            title={t("devices.openDetail")}
                            onClick={() => {
                              setSelected(d.id);
                              navigate(`/devices/${encodeURIComponent(d.id)}`);
                            }}
                          >
                            {d.name}
                          </button>
                          <DeviceNoteEditor
                            deviceName={d.name}
                            value={deviceNotes[d.id]}
                            onSave={(value) => saveDeviceNote(d.id, value)}
                          />
                          <span className="devices-table-serial mono">
                            {d.serial || "—"}{d.adbPort ? ` · :${d.adbPort}` : ""}
                          </span>
                          <span className="devices-table-meta">
                            Android {d.androidVersion || "—"} · {d.cpu || "—"} CPU · {d.ram || "—"} RAM
                          </span>
                          {d.dataVolume ? (
                            <button
                              type="button"
                              className="devices-table-link mono"
                              title={t("devices.card.openVolumes")}
                              onClick={() => {
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
                            <span className="badge warn devices-table-warning" title={t("devices.card.noAdbMappingHint")}>
                              {t("devices.card.noAdbMapping")}
                            </span>
                          ) : null}
                          {hoveredDeviceId === d.id ? <DeviceHoverCard device={d} /> : null}
                        </div>
                      </td>
                      <td className="devices-table-action-cell">
                        <div className="devices-table-status">
                          <StatusDot online={online} />
                          <span className="muted mono">{d.adbStatus}</span>
                        </div>
                      </td>
                      <td>
                        <div className="devices-table-services">
                          <span className={scrcpyOn ? "devices-table-service active" : "devices-table-service"}>
                            scrcpy · {d.scrcpyStatus}
                          </span>
                          <span className="devices-table-service">Docker · {d.dockerStatus || "—"}</span>
                        </div>
                      </td>
                      <td className="devices-table-runtime">
                        <span className="mono">{d.ip || "—"}</span>
                        <span className="muted">{d.resolution || "—"}</span>
                        <span className="muted">{d.uptime || "—"}</span>
                      </td>
                      <td>
                        <div className="devices-table-actions" aria-busy={rowActionBusy}>
                          <Button
                            size="sm"
                            variant={online && !scrcpyOn ? "primary" : "secondary"}
                            className="device-row-action"
                            icon={<Monitor size={13} />}
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
                                  const result = scrcpyOn
                                    ? await DeviceService.scrcpyStop(d.serial)
                                    : await DeviceService.scrcpyStart(d.serial);
                                  if (!result.success) {
                                    throw new Error(result.stderr || result.stdout || t(scrcpyOn ? "devices.err.stopMirror" : "devices.err.startScrcpy"));
                                  }
                                },
                                scrcpyOn ? t("devices.status.mirrorOff", { name: d.name }) : t("devices.status.mirrorOn", { name: d.name }),
                                scrcpyOn ? t("devices.status.mirroringOff") : t("devices.status.mirroringOn"),
                              )
                            }
                          >
                            <span className="device-action-label">{scrcpyOn ? t("devices.card.stopMirror") : t("devices.card.mirror")}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant={offline ? "primary" : "secondary"}
                            className="device-row-action"
                            icon={<Play size={13} />}
                            loading={busy === d.id && offline}
                            disabled={!canConnect}
                            title={online ? t("devices.title.alreadyOnline") : "ADB connect"}
                            onClick={() =>
                              void run(
                                d.id,
                                async () => {
                                  const result = await DeviceService.connect(d.serial);
                                  if (!result.success) {
                                    throw new Error(result.stderr || result.stdout || t("devices.err.adbConnect"));
                                  }
                                },
                                t("devices.status.waitBoot", { name: d.name }),
                                t("devices.status.adbReady"),
                              )
                            }
                          >
                            <span className="device-action-label">{t("devices.card.adbConnect")}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="device-row-action"
                            icon={<MoreHorizontal size={13} />}
                            disabled={!canDetail}
                            title={t("devices.card.detail")}
                            onClick={() => {
                              setSelected(d.id);
                              navigate(`/devices/${encodeURIComponent(d.id)}`);
                            }}
                          >
                            <span className="device-action-label">{t("devices.card.detail")}</span>
                          </Button>
                          <select
                            aria-label={t("devices.table.actions")}
                            disabled={rowBusy}
                            defaultValue=""
                            onChange={(e) => {
                              const value = e.target.value;
                              e.target.value = "";
                              if (value === "disconnect" && canDisconnect) {
                                void confirmAndRun(
                                  d.id,
                                  t("devices.confirmDisconnectOne", { name: d.name }),
                                  () => DeviceService.disconnect(d.serial),
                                  t("devices.status.disconnect", { name: d.name }),
                                );
                              }
                              if (value === "restart" && canRestart) {
                                void confirmAndRun(
                                  d.id,
                                  t("devices.confirmRestartOne", { name: d.name }),
                                  () => DeviceService.restart(d.id),
                                  t("devices.status.restart", { name: d.name }),
                                );
                              }
                              if (value === "stop" && canStop) {
                                void confirmAndRun(
                                  d.id,
                                  t("devices.confirmStopOne", { name: d.name }),
                                  () => DeviceService.stop(d.id),
                                  t("devices.status.stop", { name: d.name }),
                                );
                              }
                              if (value === "copy" && d.serial) {
                                void copyText(d.serial).then(
                                  () => setStatusText(t("common.panel.copied", { value: d.serial })),
                                  () => {
                                    const error = t("common.panel.copyFailed");
                                    setStatusText(error);
                                    void alert(error);
                                  },
                                );
                              }
                            }}
                          >
                            <option value="" disabled>{t("devices.card.more")}</option>
                            <option value="disconnect" disabled={!canDisconnect}>{t("devices.card.disconnect")}</option>
                            <option value="restart" disabled={!canRestart}>{t("devices.card.restart")}</option>
                            <option value="stop" disabled={!canStop}>{t("devices.card.stop")}</option>
                            <option value="copy" disabled={!d.serial}>{t("devices.card.copySerial")}</option>
                          </select>
                          {rowActionBusy ? (
                            <span className="muted" role="status" aria-live="polite" style={{ fontSize: 11 }}>
                              {t("devices.card.operationInProgress")}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
        <div className="device-grid">
          {visible.map((d) => {
            const online = d.online && d.adbStatus === "device";
            const offline = !online;
            const scrcpyOn = d.scrcpyStatus === "running";
            const hasContainer = Boolean(d.containerId) && d.dockerStatus !== "n/a";
            const cardActionBusy = busy === d.id || busy === `${d.id}-screen` || pendingConfirmation === d.id;
            const cardBusy = busy === "batch" || cardActionBusy;
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
                    <DeviceNoteEditor
                      deviceName={d.name}
                      value={deviceNotes[d.id]}
                      onSave={(value) => saveDeviceNote(d.id, value)}
                    />
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

              <div
                className="row"
                style={{ marginTop: 14, flexWrap: "wrap" }}
                aria-busy={cardActionBusy}
                onClick={(e) => e.stopPropagation()}
              >
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
                {cardActionBusy ? (
                  <span className="muted" role="status" aria-live="polite" style={{ fontSize: 12 }}>
                    {t("devices.card.operationInProgress")}
                  </span>
                ) : null}
                <select
                  disabled={cardBusy}
                  defaultValue=""
                  style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    if (v === "disconnect") {
                      if (!canDisconnect) return;
                      void confirmAndRun(
                        d.id,
                        t("devices.confirmDisconnectOne", { name: d.name }),
                        () => DeviceService.disconnect(d.serial),
                        t("devices.status.disconnect", { name: d.name }),
                      );
                    }
                    if (v === "restart") {
                      if (!canRestart) return;
                      void confirmAndRun(
                        d.id,
                        t("devices.confirmRestartOne", { name: d.name }),
                        () => DeviceService.restart(d.id),
                        t("devices.status.restart", { name: d.name }),
                      );
                    }
                    if (v === "stop") {
                      if (!canStop) return;
                      void confirmAndRun(
                        d.id,
                        t("devices.confirmStopOne", { name: d.name }),
                        () => DeviceService.stop(d.id),
                        t("devices.status.stop", { name: d.name }),
                      );
                    }
                    if (v === "copy" && d.serial) {
                      void copyText(d.serial).then(
                        () => setStatusText(t("common.panel.copied", { value: d.serial })),
                        () => {
                          const error = t("common.panel.copyFailed");
                          setStatusText(error);
                          void alert(error);
                        },
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
        )
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
