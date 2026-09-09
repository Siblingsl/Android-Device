import { useState } from "react";
import { ArrowUpRight, ChevronRight, CircleAlert, FileText, FolderOpen, Play, RotateCw, Smartphone, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import { DeviceService } from "../../services/deviceService";
import type { DeviceInfo, ShellResult } from "../../types";
import { groupDevicesForBoard, isDeviceOnline, type DeviceBoardLane } from "../../lib/deviceBoard";
import { DeviceHoverCard } from "./DeviceHoverCard";

type DeviceStatusBoardProps = {
  devices: DeviceInfo[];
  loading?: boolean;
};

type LaneMeta = {
  titleKey: string;
  descriptionKey: string;
  tone: string;
};

const laneMeta: Record<DeviceBoardLane, LaneMeta> = {
  online: { titleKey: "dashboard.board.lane.online", descriptionKey: "dashboard.board.lane.onlineHint", tone: "online" },
  attention: { titleKey: "dashboard.board.lane.attention", descriptionKey: "dashboard.board.lane.attentionHint", tone: "attention" },
  offline: { titleKey: "dashboard.board.lane.offline", descriptionKey: "dashboard.board.lane.offlineHint", tone: "offline" },
};

export function DeviceStatusBoard({ devices, loading = false }: DeviceStatusBoardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const setSelected = useAppStore((state) => state.setSelectedDeviceId);
  const setStatusText = useAppStore((state) => state.setStatusText);
  const groups = groupDevicesForBoard(devices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const detail = (device: DeviceInfo, tab?: string) => {
    setSelected(device.id);
    if (tab) {
      try {
        sessionStorage.setItem(`rdc.detail.tab.${device.id}`, tab);
      } catch {
        /* storage is optional */
      }
    }
    navigate(`/devices/${encodeURIComponent(device.id)}`);
  };

  const runResult = async (
    device: DeviceInfo,
    action: string,
    operation: () => Promise<ShellResult>,
    success: string,
  ) => {
    if (busyId) return;
    setBusyId(`${device.id}:${action}`);
    setErrorById((current) => ({ ...current, [device.id]: "" }));
    setStatusText(action);
    try {
      const result = await operation();
      if (!result.success) {
        const reason = result.stderr.trim() || result.stdout.trim() || t("dashboard.board.actionFailed");
        setErrorById((current) => ({ ...current, [device.id]: reason }));
        setStatusText(reason);
        return;
      }
      setStatusText(success);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setErrorById((current) => ({ ...current, [device.id]: reason }));
      setStatusText(reason);
    } finally {
      setBusyId(null);
    }
  };

  const openMirror = (device: DeviceInfo) => {
    if (!isDeviceOnline(device)) return;
    void runResult(
      device,
      t("dashboard.board.openMirrorBusy"),
      () => DeviceService.scrcpyStart(device.serial),
      t("dashboard.board.openMirrorDone"),
    );
  };

  const connect = (device: DeviceInfo) => {
    if (!device.serial || busyId) return;
    void runResult(
      device,
      t("dashboard.board.connectBusy"),
      () => DeviceService.connect(device.serial),
      t("dashboard.board.connectDone", { name: device.name }),
    );
  };

  return (
    <section className="device-board" aria-labelledby="device-board-title">
      <div className="device-board-heading">
        <div>
          <div className="device-board-eyebrow"><span className="device-board-eyebrow-dot" /> {t("dashboard.board.eyebrow")}</div>
          <h1 id="device-board-title" className="device-board-title">{t("dashboard.board.title")}</h1>
          <p className="device-board-subtitle">{t("dashboard.board.subtitle")}</p>
        </div>
        <div className="device-board-summary">
          <SummaryChip tone="online" value={groups.online.length} label={t("dashboard.board.lane.online")} />
          <SummaryChip tone="attention" value={groups.attention.length} label={t("dashboard.board.lane.attention")} />
          <SummaryChip tone="offline" value={groups.offline.length} label={t("dashboard.board.lane.offline")} />
          <button type="button" className="device-board-open-all" onClick={() => navigate("/devices")}>
            {t("dashboard.board.openAll")} <ArrowUpRight size={14} />
          </button>
        </div>
      </div>

      <div className="device-board-lanes">
        {(["online", "attention", "offline"] as DeviceBoardLane[]).map((lane) => (
          <DeviceLane
            key={lane}
            lane={lane}
            devices={groups[lane]}
            loading={loading}
            busyId={busyId}
            hoveredId={hoveredId}
            errorById={errorById}
            meta={laneMeta[lane]}
            onHover={setHoveredId}
            onOpenMirror={openMirror}
            onConnect={connect}
            onDetail={detail}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

function DeviceLane({ lane, devices, loading, busyId, hoveredId, errorById, meta, onHover, onOpenMirror, onConnect, onDetail, t }: {
  lane: DeviceBoardLane;
  devices: DeviceInfo[];
  loading: boolean;
  busyId: string | null;
  hoveredId: string | null;
  errorById: Record<string, string>;
  meta: LaneMeta;
  onHover: (id: string | null) => void;
  onOpenMirror: (device: DeviceInfo) => void;
  onConnect: (device: DeviceInfo) => void;
  onDetail: (device: DeviceInfo, tab?: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className={`device-lane ${meta.tone}`} aria-label={t(meta.titleKey)}>
      <div className="device-lane-heading">
        <div className="device-lane-title"><span className="device-lane-mark" />{t(meta.titleKey)}<span className="device-lane-count">{devices.length}</span></div>
        <span className="device-lane-description">{t(meta.descriptionKey)}</span>
      </div>
      <div className="device-lane-list">
        {loading && devices.length === 0 ? (
          <div className="device-board-skeleton"><span /><span /><span /></div>
        ) : devices.length === 0 ? (
          <div className="device-lane-empty"><Smartphone size={18} /><span>{t("dashboard.board.emptyLane")}</span></div>
        ) : (
          devices.map((device) => (
            <DeviceBoardCard
              key={device.id}
              lane={lane}
              device={device}
              busy={busyId?.startsWith(`${device.id}:`) ?? false}
              error={errorById[device.id] || ""}
              hovered={hoveredId === device.id}
              onHover={onHover}
              onOpenMirror={onOpenMirror}
              onConnect={onConnect}
              onDetail={onDetail}
              t={t}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DeviceBoardCard({ lane, device, busy, error, hovered, onHover, onOpenMirror, onConnect, onDetail, t }: {
  lane: DeviceBoardLane;
  device: DeviceInfo;
  busy: boolean;
  error: string;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onOpenMirror: (device: DeviceInfo) => void;
  onConnect: (device: DeviceInfo) => void;
  onDetail: (device: DeviceInfo, tab?: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const online = isDeviceOnline(device);
  const disabledConnect = !device.serial || busy;
  return (
    <article
      className={`device-board-card ${online ? "is-online" : ""} ${error ? "has-error" : ""}`}
      tabIndex={0}
      onMouseEnter={() => onHover(device.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(device.id)}
      onBlur={() => onHover(null)}
    >
      <div className="device-board-card-main">
        <div className={`device-board-card-icon ${lane}`}><Smartphone size={17} /></div>
        <div className="device-board-card-identity">
          <button type="button" className="device-board-card-name" onClick={() => onDetail(device)}>{device.name}</button>
          <span className="device-board-card-serial mono">{device.serial || device.containerId || "—"}</span>
        </div>
        <span className={`device-board-status ${online ? "online" : lane === "attention" ? "attention" : "offline"}`}>
          {online ? t("common.online") : lane === "attention" ? t("dashboard.board.status.attention") : t("common.offline")}
        </span>
      </div>

      <div className="device-board-card-meta">
        <span>Android {device.androidVersion || "—"}</span>
        <span>{device.resolution || "—"}</span>
        <span>CPU {typeof device.cpuUsage === "number" ? `${device.cpuUsage.toFixed(0)}%` : "—"}</span>
        <span>{t("dashboard.board.card.fps", { value: device.fps || 0 })}</span>
      </div>

      {device.dataVolume ? <div className="device-board-card-volume mono">{device.dataVolume}</div> : null}

      <div className="device-board-card-actions">
        {online ? (
          <>
            <button type="button" className="device-card-action primary" disabled={busy} onClick={() => onOpenMirror(device)}>
              {device.scrcpyStatus === "running" ? <Square size={13} /> : <Play size={13} />}
              {busy ? t("dashboard.board.working") : device.scrcpyStatus === "running" ? t("dashboard.board.mirrorRunning") : t("dashboard.board.openMirror")}
            </button>
            <button type="button" className="device-card-action" disabled={busy} onClick={() => onDetail(device, "control")}><RotateCw size={13} />{t("dashboard.board.control")}</button>
            <button type="button" className="device-card-action" disabled={busy} onClick={() => onDetail(device, "files")}><FolderOpen size={13} />{t("dashboard.board.files")}</button>
            <button type="button" className="device-card-action" disabled={busy} onClick={() => onDetail(device, "apps")}><FileText size={13} />{t("dashboard.board.apps")}</button>
          </>
        ) : (
          <>
            <button type="button" className="device-card-action primary" disabled={disabledConnect} onClick={() => onConnect(device)}>
              {lane === "attention" ? <CircleAlert size={13} /> : <RotateCw size={13} />}
              {busy ? t("dashboard.board.working") : lane === "attention" ? t("dashboard.board.retryAuthorize") : t("dashboard.board.connect")}
            </button>
            <button type="button" className="device-card-action" disabled={busy} onClick={() => onDetail(device)}><ChevronRight size={13} />{t("dashboard.board.details")}</button>
          </>
        )}
        <select aria-label={`${device.name} ${t("dashboard.board.more")}`} className="device-card-more" defaultValue="" disabled={busy} onChange={(event) => {
          const value = event.target.value;
          event.target.value = "";
          if (value === "control") onDetail(device, "control");
          if (value === "files") onDetail(device, "files");
          if (value === "apps") onDetail(device, "apps");
          if (value === "logs") onDetail(device, "logs");
        }}>
          <option value="" disabled>{t("dashboard.board.more")}</option>
          <option value="control">{t("dashboard.board.control")}</option>
          <option value="files">{t("dashboard.board.files")}</option>
          <option value="apps">{t("dashboard.board.apps")}</option>
          <option value="logs">{t("dashboard.board.logcat")}</option>
        </select>
        <button type="button" className="device-card-open" title={t("dashboard.board.details")} onClick={() => onDetail(device)}><ArrowUpRight size={14} /></button>
      </div>

      {error ? <div className="device-board-card-error" role="alert"><CircleAlert size={13} /> <span>{error}</span><button type="button" onClick={() => onOpenMirror(device)}>{t("dashboard.board.retryMirror")}</button></div> : null}
      {hovered ? <DeviceHoverCard device={device} /> : null}
    </article>
  );
}

function SummaryChip({ tone, value, label }: { tone: string; value: number; label: string }) {
  return <span className={`device-board-summary-chip ${tone}`}><strong>{value}</strong><span>{label}</span></span>;
}
