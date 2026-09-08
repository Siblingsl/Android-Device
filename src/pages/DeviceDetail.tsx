import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../lib/dialogs";
import { useNavigate, useParams } from "react-router-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  RefreshCw,
  FolderPlus,
  Trash2,
  Upload,
  Download,
  Play,
  Square,
  Search,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { DeviceService } from "../services/deviceService";
import { DPI_PRESETS, RES_PRESETS, validDpi, validResolution } from "../lib/displaySpec";
import { formatShellOutput, runDeviceAction, scrcpyStateFromResult } from "../lib/deviceActions";
import {
  canRefreshPreview,
  emptyPreview,
  failPreviewRequest,
  finishPreviewRequest,
  startPreviewRequest,
  type PreviewState,
} from "../lib/devicePreview";
import { shortcutForScreenKey } from "../lib/deviceInput";
import {
  isRetryableControlAction,
  prependControlFeedback,
  type ControlFeedback,
  type ControlFeedbackStatus,
} from "../lib/controlFeedback";
import { appendResourceSample, type ResourceSample } from "../lib/resourceMetrics";
import { DevicePreview } from "../components/device/DevicePreview";
import { DeviceHealthPanel } from "../components/device/DeviceHealthPanel";
import { DeviceControlPanel, type DeviceControlAction } from "../components/device/DeviceControlPanel";
import { DeviceShell } from "../components/device/DeviceShell";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type {
  AppInfo,
  DeviceInfo,
  FileEntry,
  LsposedScopeReport,
  RootStatus,
  SuPolicyEntry,
} from "../types";

type Tab = "overview" | "control" | "files" | "apps" | "logs" | "settings";
type ControlBusyAction = DeviceControlAction | "screenshot" | "gesture";
type PreviewOutcome = { success: boolean; message: string };

export function DeviceDetail() {
  const { id = "" } = useParams();
  const deviceId = decodeURIComponent(id);
  const navigate = useNavigate();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const { t } = useI18n();
  const tabs: Tab[] = ["overview", "control", "files", "apps", "logs", "settings"];
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = sessionStorage.getItem(`rdc.detail.tab.${deviceId}`);
      return tabs.includes(saved as Tab) ? (saved as Tab) : "overview";
    } catch {
      return "overview";
    }
  });
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [metricHistory, setMetricHistory] = useState<ResourceSample[]>([]);
  const [connecting, setConnecting] = useState(false);
  const autoTried = useRef("");
  const refreshInFlight = useRef(false);

  const load = async (silent = false) => {
    if (refreshInFlight.current) return device;
    refreshInFlight.current = true;
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      let d = await DeviceService.getDevice(deviceId);
      if (!d && deviceId.includes(":")) {
        const list = await DeviceService.listDevices();
        const hit = list.find((x) => x.serial === deviceId || x.id === deviceId);
        if (hit) d = await DeviceService.getDevice(hit.id);
      }
      setDevice(d);
      setRefreshError(null);
      const updatedAt = Date.now();
      setLastUpdatedAt(updatedAt);
      if (d && (typeof d.cpuUsage === "number" || typeof d.memoryUsage === "number")) {
        setMetricHistory((samples) =>
          appendResourceSample(samples, {
            at: updatedAt,
            cpuUsage: d.cpuUsage ?? 0,
            memoryUsage: d.memoryUsage ?? 0,
          }),
        );
      }
      return d;
    } catch (e) {
      const message = e instanceof Error ? e.message : t("detail.load.failed");
      setRefreshError(message);
      setStatusText(t("detail.load.failedWith", { msg: message }));
      return null;
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
      refreshInFlight.current = false;
    }
  };

  const connectIfNeeded = async (d: DeviceInfo | null) => {
    if (!d) return;
    const serial = d.serial || deviceId;
    const online = d.online && d.adbStatus === "device";
    if (online || !serial.includes(":") || autoTried.current === serial) return;
    autoTried.current = serial;
    setConnecting(true);
    setStatusText(t("detail.status.waitingBoot", { name: d.name || serial }));
    try {
      const r = await DeviceService.connect(serial);
      await load();
      setStatusText(r.success ? t("detail.status.adbReady") : r.stderr || t("detail.status.adbNotReady"));
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : t("detail.status.connectFailed"));
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`rdc.detail.tab.${deviceId}`);
      if (tabs.includes(saved as Tab)) setTab(saved as Tab);
      else setTab("overview");
    } catch {
      setTab("overview");
    }
  }, [deviceId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`rdc.detail.tab.${deviceId}`, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  useEffect(() => {
    autoTried.current = "";
    setMetricHistory([]);
    void load().then((d) => {
      if (d) return connectIfNeeded(d);
      if (deviceId.includes(":")) {
        return connectIfNeeded({
          id: deviceId,
          name: deviceId,
          serial: deviceId,
          online: false,
          adbStatus: "disconnected",
        } as DeviceInfo);
      }
    });
  }, [deviceId]);

  useEffect(() => {
    if (!device || !autoRefresh) return;
    const timer = window.setInterval(() => void load(true), 10000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, deviceId, device !== null]);

  if (loading && !device) {
    return (
      <div>
        <Skeleton height={32} width={240} />
        <div style={{ marginTop: 20 }}>
          <Skeleton height={400} />
        </div>
      </div>
    );
  }

  if (!device) {
    return (
      <Card>
        <div className="empty-state">
          {connecting ? t("detail.connecting") : t("detail.deviceNotFound")}
        </div>
        <div className="row" style={{ justifyContent: "center" }}>
          {deviceId.includes(":") && (
            <Button
              variant="primary"
              loading={connecting}
              onClick={() =>
                void connectIfNeeded({
                  id: deviceId,
                  name: deviceId,
                  serial: deviceId,
                  online: false,
                  adbStatus: "disconnected",
                } as DeviceInfo)
              }
            >
              {t("detail.tryConnect")}
            </Button>
          )}
          <Button onClick={() => navigate("/devices")}>{t("detail.backToList")}</Button>
        </div>
      </Card>
    );
  }

  const serial = device.serial;

  return (
    <div>
      <div className="page-header">
        <div className="row">
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => navigate("/devices")}>
            {t("detail.back")}
          </Button>
          <div>
            <div className="page-title" style={{ fontSize: 22 }}>
              {device.name}
            </div>
            <div className="page-subtitle mono">{device.serial}</div>
          </div>
          <StatusDot online={device.online && device.adbStatus === "device"} />
        </div>
        <div className="row">
          {!(device.online && device.adbStatus === "device") && device.containerId && (
            <Button
              variant="primary"
              loading={connecting}
              disabled={connecting}
              onClick={() => {
                void (async () => {
                  setConnecting(true);
                  setStatusText(t("detail.status.startingContainer"));
                  try {
                    const r = await DeviceService.startContainer(device.containerId);
                    if (!r.success) {
                      setStatusText(r.stderr || t("detail.status.startFailed"));
                      void alert(r.stderr || r.stdout || t("detail.status.startFailed"));
                      return;
                    }
                    autoTried.current = "";
                    const d = await load();
                    await connectIfNeeded(d ?? device);
                  } finally {
                    setConnecting(false);
                  }
                })();
              }}
            >
              {t("detail.startContainer")}
            </Button>
          )}
          {!(device.online && device.adbStatus === "device") && device.serial.includes(":") && (
            <Button
              variant="primary"
              loading={connecting}
              onClick={() => {
                autoTried.current = "";
                void connectIfNeeded(device);
              }}
            >
              {connecting ? t("detail.connectingShort") : t("detail.adbConnect")}
            </Button>
          )}
          <Button icon={<RefreshCw size={15} />} onClick={() => void load()} loading={refreshing} disabled={connecting}>
            {t("common.refresh")}
          </Button>
          <select
            disabled={connecting}
            defaultValue=""
            style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
            onChange={async (e) => {
              const v = e.target.value;
              e.target.value = "";
              if (v === "restart") {
                if (!(await askConfirm(t("detail.confirm.restart", { name: device.name })))) return;
                void (async () => {
                  setStatusText(t("detail.status.restarting"));
                  const r = await DeviceService.restart(deviceId);
                  setStatusText(r.success ? t("detail.status.restartSent") : r.stderr || t("detail.status.restartFailed"));
                  if (r.success) {
                    autoTried.current = "";
                    window.setTimeout(() => void load(), 3000);
                  }
                })();
              }
              if (v === "stop") {
                if (!(await askConfirm(t("detail.confirm.stop", { name: device.name })))) return;
                void (async () => {
                  setStatusText(t("detail.status.stopping"));
                  const r = await DeviceService.stop(deviceId);
                  setStatusText(r.success ? t("detail.status.stopped") : r.stderr || t("detail.status.stopFailed"));
                  await load();
                })();
              }
            }}
          >
            <option value="" disabled>
              {t("detail.more")}
            </option>
            <option value="restart">{t("detail.restart")}</option>
            <option value="stop">{t("detail.stop")}</option>
          </select>
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ["overview", "detail.tab.overview", false],
            ["control", "detail.tab.control", true],
            ["files", "detail.tab.files", true],
            ["apps", "detail.tab.apps", true],
            ["logs", "detail.tab.logs", true],
            ["settings", "detail.tab.settings", true],
          ] as const
        ).map(([k, labelKey, needsOnline]) => {
          const offlineTab = needsOnline && !(device.online && device.adbStatus === "device");
          const label = t(labelKey);
          return (
            <button
              key={k}
              className={`tab ${tab === k ? "active" : ""}`}
              title={offlineTab ? t("detail.title.needsAdb") : undefined}
              style={offlineTab ? { opacity: 0.55 } : undefined}
              onClick={() => setTab(k)}
            >
              {offlineTab ? t("detail.tab.offline", { label }) : label}
            </button>
          );
        })}
      </div>

      {!(device.online && device.adbStatus === "device") && tab !== "overview" && (
        <div className="notice" style={{ marginBottom: 12 }}>
          {t("detail.notice.offline")}
        </div>
      )}
      {tab === "overview" && (
        <>
          <DeviceHealthPanel
            device={device}
            refreshing={refreshing}
            lastUpdatedAt={lastUpdatedAt}
            refreshError={refreshError}
            metricHistory={metricHistory}
            autoRefresh={autoRefresh}
            onAutoRefreshChange={setAutoRefresh}
            onRefresh={() => void load()}
          />
          <Overview device={device} onOpenTab={setTab} />
          <RootPanel device={device} />
        </>
      )}
      {tab === "control" && (
        <Control
          serial={serial}
          resolution={device.resolution}
          setStatusText={setStatusText}
          disabled={!(device.online && device.adbStatus === "device")}
        />
      )}
      {tab === "files" && (
        <Files
          serial={serial}
          setStatusText={setStatusText}
          disabled={!(device.online && device.adbStatus === "device")}
        />
      )}
      {tab === "apps" && (
        <Apps
          serial={serial}
          setStatusText={setStatusText}
          disabled={!(device.online && device.adbStatus === "device")}
        />
      )}
      {tab === "logs" && (
        <DeviceLogs serial={serial} disabled={!(device.online && device.adbStatus === "device")} />
      )}
      {tab === "settings" && (
        <DeviceSettings
          serial={serial}
          initialResolution={device.resolution}
          initialDpi={device.dpi}
          setStatusText={setStatusText}
          onApplied={() => void load()}
          deviceId={deviceId}
          disabled={!(device.online && device.adbStatus === "device")}
        />
      )}
    </div>
  );
}

function RootPanel({ device }: { device: DeviceInfo }) {
  const setStatusText = useAppStore((s) => s.setStatusText);
  const { t } = useI18n();
  const [status, setStatus] = useState<RootStatus | null>(null);
  const [scope, setScope] = useState<LsposedScopeReport | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [suPolicies, setSuPolicies] = useState<SuPolicyEntry[] | null>(null);
  const [suLoading, setSuLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [pkgInput, setPkgInput] = useState("");
  const online = device.online && device.adbStatus === "device";

  const loadStatus = async () => {
    if (!online) return;
    setLoading(true);
    try {
      setStatus(await DeviceService.getRootStatus(device.serial));
    } catch (e) {
      setStatusText(e instanceof Error ? t("detail.root.statusFailedWith", { msg: e.message }) : t("detail.root.statusFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.serial, online]);

  const loadScope = async () => {
    setScopeLoading(true);
    try {
      setScope(await DeviceService.getLsposedScope(device.serial));
    } catch {
      setScope({ modules: [], message: t("detail.root.scope.loadFailed") });
    } finally {
      setScopeLoading(false);
    }
  };

  useEffect(() => {
    if (status?.lsposedActive) void loadScope();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.lsposedActive, device.serial]);

  const loadSuPolicies = async () => {
    setSuLoading(true);
    try {
      setSuPolicies(await DeviceService.getSuPolicies(device.serial));
    } catch {
      setSuPolicies([]);
    } finally {
      setSuLoading(false);
    }
  };

  useEffect(() => {
    if (status?.magisk) void loadSuPolicies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.magisk, device.serial]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    if (acting) return;
    setActing(true);
    setStatusText(t("detail.root.doing", { msg }));
    try {
      const r = await fn();
      // ShellResult-style failures resolve (not reject) — surface them.
      if (
        r &&
        typeof r === "object" &&
        "success" in r &&
        (r as { success?: boolean }).success === false
      ) {
        const sr = r as { stderr?: string; stdout?: string };
        const reason = (sr.stderr || sr.stdout || t("detail.root.unknownFailure")).trim();
        setStatusText(t("detail.root.failed", { msg, reason }));
        void alert(t("detail.root.failed", { msg, reason }));
        await loadStatus();
        return;
      }
      setStatusText(t("detail.root.done", { msg }));
      await loadStatus();
      // The scope / su sections load independently of root status — refresh
      // them too so actions that touch their data reflect immediately.
      if (status?.lsposedActive) void loadScope();
      void loadSuPolicies();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setStatusText(t("detail.root.failed", { msg, reason }));
      void alert(t("detail.root.failed", { msg, reason }));
    } finally {
      setActing(false);
    }
  };

  if (!online) {
    return null;
  }

  const propRows: Array<[string, string]> = status
    ? Object.entries(status.props).map(([k, v]) => [k, v || "—"])
    : [];

  return (
    <Card
      title={t("detail.root.title")}
      action={
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Button
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={loading}
            disabled={acting}
            onClick={() => void loadStatus()}
          >
            {t("common.refresh")}
          </Button>
          <Button
            size="sm"
            disabled={!status?.magisk || acting}
            onClick={() =>
              void run(
                () => DeviceService.magiskApplySpoof(device.serial),
                t("detail.root.action.replaySpoof"),
              )
            }
            title={t("detail.root.title.applySpoof")}
          >
            {t("detail.root.applySpoof")}
          </Button>
          <Button
            size="sm"
            disabled={!status?.magisk || acting}
            onClick={async () => {
              if (await askConfirm(t("detail.root.confirm.whitelist"))) {
                void run(
                  () => DeviceService.magiskSetShamikoMode(device.serial, true),
                  t("detail.root.action.shamikoWhitelist"),
                );
              }
            }}
          >
            {t("detail.root.whitelistMode")}
          </Button>
          <Button
            size="sm"
            disabled={!status?.magisk || acting}
            onClick={async () => {
              if (await askConfirm(t("detail.root.confirm.blacklist"))) {
                void run(
                  () => DeviceService.magiskSetShamikoMode(device.serial, false),
                  t("detail.root.action.shamikoBlacklist"),
                );
              }
            }}
          >
            {t("detail.root.blacklistMode")}
          </Button>
          {status && status.magisk && (!status.magiskApp || !status.lsposedManager) && (
            <Button
              size="sm"
              disabled={acting}
              onClick={() =>
                void run(
                  () => DeviceService.magiskRepairManagers(device.serial),
                  t("detail.root.action.repairManagers"),
                )
              }
              title={t("detail.root.repairManagersHint")}
            >
              {t("detail.root.repairManagers")}
            </Button>
          )}
        </div>
      }
    >
      {!status ? (
        loading ? (
          <Skeleton count={3} height={16} />
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            {t("detail.root.noMagisk")}
          </div>
        )
      ) : (
        <>
          {!status.magisk && (
            <div className="bad" style={{ fontSize: 13, marginBottom: 8 }}>
              {status.message || t("detail.root.noMagiskShort")}
            </div>
          )}
          <div className="form-grid" style={{ marginBottom: 10 }}>
            <div className="field">
              <label>Magisk</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.magisk ? status.version || t("detail.root.installed") : t("detail.root.notDetected")}
              </div>
            </div>
            <div className="field">
              <label>Zygisk</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.zygiskEnabled
                  ? status.zygiskActive
                    ? t("detail.root.zygiskActive")
                    : t("detail.root.zygiskPendingReboot")
                  : t("detail.root.disabled")}
              </div>
            </div>
            <div className="field">
              <label>LSPosed</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.lsposedActive
                  ? t("detail.root.activated")
                  : t("detail.root.notActive")}
                {status.lsposedManager ? ` · ${t("detail.root.managerInstalled")}` : ""}
              </div>
            </div>
            <div className="field">
              <label>Shamiko</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.shamikoWhitelist === undefined
                  ? t("detail.root.notDetected")
                  : status.shamikoWhitelist
                    ? t("detail.root.whitelistActive")
                    : t("detail.root.blacklistActive")}
              </div>
            </div>
            <div className="field">
              <label>{t("detail.root.managerApps")}</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.magiskApp ? "Magisk ✓" : "Magisk ✗"} ·{" "}
                {status.lsposedManager ? "LSPosed ✓" : "LSPosed ✗"}
              </div>
            </div>
            <div className="field">
              <label>Denylist</label>
              <div className="mono" style={{ padding: "8px 0" }}>
                {status.denylistEnforced ? t("detail.root.enabled") : t("detail.root.disabled")} · {t("detail.root.packageCount", { count: status.denylist.length })}
              </div>
            </div>
            {propRows.map(([k, v]) => (
              <div key={k} className="field">
                <label>{k}</label>
                <div className="mono" style={{ padding: "8px 0", wordBreak: "break-all" }}>
                  {v}
                </div>
              </div>
            ))}
          </div>

          {status.modules.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {t("detail.root.modules")}
              </div>
              {status.modules.map((m) => (
                <div
                  key={m.id}
                  className="row"
                  style={{ fontSize: 12, marginBottom: 2, alignItems: "center", flexWrap: "wrap" }}
                >
                  <span className="mono" style={{ flex: 1, minWidth: 200 }}>
                    {m.id} · {m.version || "—"} ·{" "}
                    {m.state === "enabled"
                      ? t("detail.root.moduleEnabled")
                      : t("detail.root.moduleDisabled")}
                  </span>
                  <Button
                    size="sm"
                    disabled={acting}
                    onClick={() =>
                      void run(
                        () =>
                          DeviceService.magiskModuleSetEnabled(
                            device.serial,
                            m.id,
                            m.state !== "enabled",
                          ),
                        t("detail.root.action.moduleToggle", { id: m.id }),
                      )
                    }
                  >
                    {m.state === "enabled"
                      ? t("detail.root.moduleDisable")
                      : t("detail.root.moduleEnable")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={acting}
                    onClick={async () => {
                      if (await askConfirm(t("detail.root.confirm.moduleRemove", { id: m.id }))) {
                        void run(
                          () => DeviceService.magiskModuleRemove(device.serial, m.id),
                          t("detail.root.action.moduleRemove", { id: m.id }),
                        );
                      }
                    }}
                  >
                    {t("detail.root.moduleRemove")}
                  </Button>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 11 }}>
                {t("detail.root.moduleHint")}
              </div>
            </div>
          )}

          {status.lsposedActive && (
            <div style={{ marginBottom: 10 }}>
              <div className="row" style={{ alignItems: "center", marginBottom: 2 }}>
                <div className="muted" style={{ fontSize: 12, flex: 1 }}>
                  {t("detail.root.scope.title")}
                </div>
                <Button size="sm" loading={scopeLoading} disabled={acting} onClick={() => void loadScope()}>
                  {t("common.refresh")}
                </Button>
              </div>
              {scope && scope.modules.length === 0 && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {scope.message || t("detail.root.scope.empty")}
                </div>
              )}
              {scope?.modules.map((m) => (
                <div key={m.pkg} className="mono" style={{ fontSize: 12, marginBottom: 2, wordBreak: "break-all" }}>
                  {m.pkg}
                  {m.enabled ? "" : ` (${t("detail.root.moduleDisabled")})`}
                  {" → "}
                  {m.scope.length > 0 ? m.scope.join(", ") : t("detail.root.scope.empty")}
                </div>
              ))}
            </div>
          )}

          {status.magisk && (
            <div style={{ marginBottom: 10 }}>
              <div className="row" style={{ alignItems: "center", marginBottom: 2 }}>
                <div className="muted" style={{ fontSize: 12, flex: 1 }}>
                  {t("detail.root.su.title")}
                </div>
                <Button size="sm" loading={suLoading} disabled={acting} onClick={() => void loadSuPolicies()}>
                  {t("common.refresh")}
                </Button>
              </div>
              {suPolicies && suPolicies.length === 0 && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {t("detail.root.su.empty")}
                </div>
              )}
              {suPolicies?.map((p) => (
                <div
                  key={p.uid}
                  className="row"
                  style={{ fontSize: 12, marginBottom: 2, alignItems: "center", flexWrap: "wrap" }}
                >
                  <span className="mono" style={{ flex: 1, minWidth: 200 }}>
                    {p.package || t("detail.root.su.unknownPkg")} · uid {p.uid} ·{" "}
                    {p.policy === "allow"
                      ? t("detail.root.su.allowed")
                      : t("detail.root.su.denied")}
                  </span>
                  <Button
                    size="sm"
                    disabled={acting}
                    onClick={() =>
                      void run(
                        () =>
                          DeviceService.magiskSetSuPolicy(
                            device.serial,
                            p.uid,
                            p.policy !== "allow",
                          ),
                        t("detail.root.action.suSet", { pkg: p.package || String(p.uid) }),
                      )
                    }
                  >
                    {p.policy === "allow"
                      ? t("detail.root.su.deny")
                      : t("detail.root.su.allow")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={acting}
                    onClick={() =>
                      void run(
                        () => DeviceService.magiskRemoveSuPolicy(device.serial, p.uid),
                        t("detail.root.action.suRemove", { pkg: p.package || String(p.uid) }),
                      )
                    }
                  >
                    {t("detail.root.su.remove")}
                  </Button>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 11 }}>
                {t("detail.root.su.hint")}
              </div>
            </div>
          )}

          <div className="row" style={{ marginBottom: 10 }}>
            <input
              style={{ flex: 1 }}
              value={pkgInput}
              onChange={(e) => setPkgInput(e.target.value)}
              placeholder={t("detail.root.pkgPlaceholder")}
            />
            <Button
              size="sm"
              disabled={!status.magisk || acting || !pkgInput.trim()}
              onClick={() =>
                void run(
                  () => DeviceService.magiskDenylistAdd(device.serial, pkgInput.trim()),
                  t("detail.root.action.denylistAdd", { pkg: pkgInput.trim() }),
                ).then(() => setPkgInput(""))
              }
            >
              {t("detail.root.denylistAddBtn")}
            </Button>
            <Button
              size="sm"
              disabled={!status.magisk || acting || !pkgInput.trim()}
              onClick={() =>
                void run(
                  () => DeviceService.magiskDenylistRemove(device.serial, pkgInput.trim()),
                  t("detail.root.action.denylistRemove", { pkg: pkgInput.trim() }),
                ).then(() => setPkgInput(""))
              }
            >
              {t("detail.root.denylistRemoveBtn")}
            </Button>
          </div>

          {status.denylist.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {status.denylist.map((d) => {
                const [pkg, process] = d.split("|", 2);
                return (
                  <div key={d} className="mono" style={{ fontSize: 12 }}>
                    {pkg}
                    {process ? ` (${process})` : ""}
                  </div>
                );
              })}
            </div>
          )}

          {status.presetLogTail && (
            <details>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                {t("detail.root.presetLog")}
              </summary>
              <pre
                className="mono"
                style={{ fontSize: 11, whiteSpace: "pre-wrap", marginTop: 6 }}
              >
                {status.presetLogTail}
              </pre>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

function Overview({ device, onOpenTab }: { device: DeviceInfo; onOpenTab: (tab: Tab) => void }) {
  const navigate = useNavigate();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const { t } = useI18n();
  const items = [
    [t("detail.field.name"), device.name],
    ["Serial", device.serial],
    [t("common.panel.resolution"), device.resolution || "—"],
    [t("detail.field.androidVersion"), device.androidVersion || "—"],
    ["CPU", device.cpu || "—"],
    ["RAM", device.ram || "—"],
    ["IP", device.ip || "—"],
    ["MAC", device.mac || "—"],
    ["ADB", device.adbStatus],
    ["Scrcpy", device.scrcpyStatus],
    ["Docker", device.dockerStatus || "—"],
    [t("detail.field.containerId"), device.containerId || "—"],
    [t("common.panel.volume"), device.dataVolume || "—"],
    [t("detail.field.image"), device.image || "—"],
    [t("detail.field.uptime"), device.uptime || "—"],
    [t("detail.field.startedAt"), device.startedAt || "—"],
    ["DPI", device.dpi || "—"],
  ];
  return (
    <Card
      title={t("detail.overview.title")}
      action={
        <div className="row" style={{ flexWrap: "wrap" }}>
          {device.serial && (
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(device.serial).then(
                  () => setStatusText(t("common.panel.copied", { value: device.serial })),
                  () => void alert(t("common.panel.copyFailed")),
                );
              }}
            >
              {t("common.panel.copySerial")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const text = items.map(([k, v]) => `${k}: ${v}`).join("\n");
              void navigator.clipboard.writeText(text).then(
                () => setStatusText(t("detail.overview.copiedAll")),
                () => void alert(t("common.panel.copyFailed")),
              );
            }}
          >
            {t("detail.overview.copyAll")}
          </Button>
          {device.dataVolume ? (
            <Button
              size="sm"
              onClick={() => {
                try {
                  sessionStorage.setItem("rdc.volumes.query", device.dataVolume || "");
                } catch {
                  /* ignore */
                }
                navigate("/volumes");
              }}
            >
              {t("detail.overview.openVolume")}
            </Button>
          ) : null}
          {device.containerId || device.name ? (
            <Button
              size="sm"
              onClick={() => {
                try {
                  sessionStorage.setItem(
                    "rdc.docker.instQuery",
                    device.name.replace(/^rdc-/, "") || device.containerId.slice(0, 12),
                  );
                } catch {
                  /* ignore */
                }
                navigate("/docker");
              }}
            >
              {t("detail.overview.openContainer")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={!(device.online && device.adbStatus === "device")}
            title={device.online && device.adbStatus === "device" ? undefined : t("detail.title.needsAdb")}
            onClick={() => onOpenTab("control")}
          >
            {t("detail.overview.openControl")}
          </Button>
          <Button
            size="sm"
            disabled={!(device.online && device.adbStatus === "device")}
            title={device.online && device.adbStatus === "device" ? undefined : t("detail.title.needsAdb")}
            onClick={() => onOpenTab("files")}
          >
            {t("detail.overview.openFiles")}
          </Button>
          <Button
            size="sm"
            disabled={!(device.online && device.adbStatus === "device")}
            title={device.online && device.adbStatus === "device" ? undefined : t("detail.title.needsAdb")}
            onClick={() => onOpenTab("apps")}
          >
            {t("detail.overview.openApps")}
          </Button>
          <Button
            size="sm"
            disabled={!(device.online && device.adbStatus === "device")}
            title={device.online && device.adbStatus === "device" ? undefined : t("detail.title.needsAdb")}
            onClick={() => onOpenTab("logs")}
          >
            {t("detail.overview.openLogs")}
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        {items.map(([k, v]) => (
          <div key={k} className="field">
            <label>{k}</label>
            <div className="mono" style={{ padding: "8px 0" }}>
              {v}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function parseResolution(raw?: string): { w: number; h: number } {
  const m = (raw || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: 1080, h: 1920 };
}

function Control({
  serial,
  resolution,
  setStatusText,
  disabled = false,
}: {
  serial: string;
  resolution?: string;
  setStatusText: (s: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [actionBusy, setActionBusy] = useState<ControlBusyAction | null>(null);
  const [feedback, setFeedback] = useState<ControlFeedback[]>([]);
  const [retryingFeedbackId, setRetryingFeedbackId] = useState<number | null>(null);
  const [shellDiagnostic, setShellDiagnostic] = useState<{ id: number; message: string } | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>(() => emptyPreview());
  const [previewFlash, setPreviewFlash] = useState(false);
  const [livePreview, setLivePreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [hideChrome, setHideChrome] = useState(false);
  const [scrcpyLabel, setScrcpyLabel] = useState("stopped");
  const [scrcpyBusy, setScrcpyBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const swipedRef = useRef(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef(false);
  const livePreviewRef = useRef(true);
  const refreshTimer = useRef(0);
  const previewRequesting = useRef(false);
  const diagnosticId = useRef(0);
  const feedbackId = useRef(0);
  const chromeTimer = useRef(0);
  const { w: screenW, h: screenH } = parseResolution(resolution);
  previewRef.current = Boolean(previewState.image);
  livePreviewRef.current = livePreview;

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimer.current);
      window.clearTimeout(chromeTimer.current);
    },
    [],
  );

  const syncScrcpy = async () => {
    try {
      const s = await DeviceService.scrcpyStatus(serial);
      setScrcpyLabel(s || "stopped");
    } catch {
      setScrcpyLabel("unknown");
    }
  };

  useEffect(() => {
    void syncScrcpy();
    const t = setInterval(() => void syncScrcpy(), 4000);
    return () => clearInterval(t);
  }, [serial]);

  useEffect(() => {
    const onFs = () => {
      const on = document.fullscreenElement === screenRef.current;
      setFullscreen(on);
      setHideChrome(false);
      window.clearTimeout(chromeTimer.current);
      if (on) {
        chromeTimer.current = window.setTimeout(() => setHideChrome(true), 1600);
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const bumpChrome = (e: React.MouseEvent) => {
    if (!fullscreen) return;
    const el = screenRef.current;
    if (!el) return;
    const y = e.clientY - el.getBoundingClientRect().top;
    const show = y < 80;
    setHideChrome(!show);
    window.clearTimeout(chromeTimer.current);
    if (show) {
      chromeTimer.current = window.setTimeout(() => setHideChrome(true), 1600);
    }
  };

  const appendDiagnostic = (message: string) => {
    const detail = message.trim();
    if (!detail) return;
    setShellDiagnostic({ id: ++diagnosticId.current, message: detail });
  };

  const recordFeedback = (
    action: ControlBusyAction,
    label: string,
    status: ControlFeedbackStatus,
    message: string,
    retry?: () => void | Promise<void>,
  ) => {
    const item: ControlFeedback = {
      id: ++feedbackId.current,
      action: label,
      status,
      message: message.trim() || label,
      at: Date.now(),
      retryable: isRetryableControlAction(action),
      retry,
    };
    setFeedback((items) => prependControlFeedback(items, item));
  };

  const retryFeedback = (item: ControlFeedback) => {
    if (!item.retry || actionBusy) return;
    setRetryingFeedbackId(item.id);
    void Promise.resolve(item.retry()).finally(() => setRetryingFeedbackId(null));
  };

  const requestPreview = async (announce: boolean): Promise<PreviewOutcome | null> => {
    if (!canRefreshPreview({ disabled, visible: document.visibilityState === "visible" })) return null;
    if (previewRequesting.current) return null;
    previewRequesting.current = true;
    setPreviewState((previous) => startPreviewRequest(previous));
    if (announce) setStatusText(t("detail.control.shooting"));
    try {
      const r = await DeviceService.screenshot(serial);
      if (r.success) {
        setPreviewState((previous) => finishPreviewRequest(previous, r, Date.now()));
        setPreviewFlash(true);
        window.setTimeout(() => setPreviewFlash(false), 1600);
        const message = t("detail.control.shotSaved", { path: r.path });
        if (announce) setStatusText(message);
        return { success: true, message };
      } else {
        const reason = (r.error || t("detail.control.shotFailed")).trim();
        setPreviewState((previous) => failPreviewRequest(previous, reason));
        setStatusText(reason);
        appendDiagnostic(reason);
        return { success: false, message: reason };
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setPreviewState((previous) => failPreviewRequest(previous, reason));
      setStatusText(reason || t("detail.control.shotFailed"));
      appendDiagnostic(reason);
      return { success: false, message: reason || t("detail.control.shotFailed") };
    } finally {
      previewRequesting.current = false;
    }
  };

  const refreshPreview = () => {
    if (
      !previewRef.current ||
      !livePreviewRef.current ||
      !canRefreshPreview({ disabled, visible: document.visibilityState === "visible" })
    ) return;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void requestPreview(false), 800);
  };

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        window.clearTimeout(refreshTimer.current);
        return;
      }
      if (previewRef.current && livePreviewRef.current) refreshPreview();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [disabled, livePreview]);

  const act = async (
    label: string,
    fn: () => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>,
    busyAction: ControlBusyAction = "gesture",
  ) => {
    if (disabled) {
      setStatusText(t("detail.status.deviceOffline"));
      return;
    }
    if (actionBusy) return;
    setActionBusy(busyAction);
    setStatusText(label);
    try {
      await runDeviceAction(fn, {
        fallback: t("detail.control.actionFailed"),
        onSuccess: (result) => {
          const output = formatShellOutput(result.stdout || "", result.stderr || "", result.exitCode);
          recordFeedback(busyAction, label, "success", output || t("detail.control.actionCompleted"));
          refreshPreview();
        },
        onError: (error) => {
          recordFeedback(busyAction, label, "error", error.message, () => act(label, fn, busyAction));
          setStatusText(error.message);
          appendDiagnostic(error.message);
        },
      });
      setStatusText(t("detail.status.ready"));
    } catch {
      // Error feedback is handled by onError; keep the rejected Promise local
      // so mouse/keyboard handlers do not create an unhandled rejection.
    } finally {
      setActionBusy(null);
    }
  };

  const toDevicePoint = (e: { clientX: number; clientY: number }) => {
    const el = frameRef.current ?? screenRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / Math.max(rect.width, 1);
    const ny = (e.clientY - rect.top) / Math.max(rect.height, 1);
    const x = Math.round(Math.min(1, Math.max(0, nx)) * screenW);
    const y = Math.round(Math.min(1, Math.max(0, ny)) * screenH);
    return { x, y };
  };

  const onScreenClick = (e: React.MouseEvent) => {
    if (e.detail === 2) return;
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    const { x, y } = toDevicePoint(e);
    void act(t("detail.control.tap", { x, y }), () => DeviceService.tap(serial, x, y));
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    void act(t("detail.control.back"), () => DeviceService.back(serial), "back");
  };

  const onAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      void act("HOME", () => DeviceService.home(serial), "home");
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = toDevicePoint(e);
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!dragRef.current || e.button !== 0) return;
    const end = toDevicePoint(e);
    const start = dragRef.current;
    dragRef.current = null;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist > 20) {
      swipedRef.current = true;
      void act(t("detail.control.swipe"), () =>
        DeviceService.swipe(serial, start.x, start.y, end.x, end.y, 300)
      );
    }
  };

  const takeShot = async () => {
    if (disabled || actionBusy) return;
    setActionBusy("screenshot");
    try {
      const outcome = await requestPreview(true);
      if (outcome) {
        recordFeedback(
          "screenshot",
          t("detail.control.screenshot"),
          outcome.success ? "success" : "error",
          outcome.message,
          outcome.success ? undefined : () => takeShot(),
        );
      }
    } finally {
      setActionBusy(null);
    }
  };

  const runControlAction = (action: DeviceControlAction, value?: string | boolean) => {
    if (action === "text") {
      void act(t("detail.control.inputText"), () => DeviceService.text(serial, String(value ?? "")), "text");
      return;
    }
    if (action === "clipboard") {
      void act(t("detail.control.clipboard"), () =>
        DeviceService.sendClipboard(serial, String(value ?? "")),
        "clipboard",
      );
      return;
    }
    const labels: Record<Exclude<DeviceControlAction, "text" | "clipboard">, string> = {
      home: "HOME",
      back: "BACK",
      recent: "RECENT",
      power: "POWER",
      volup: t("detail.control.volUp"),
      voldown: t("detail.control.volDown"),
      lock: t("detail.control.lock"),
      wake: t("detail.control.wake"),
      rotate: t("detail.control.rotate"),
      notify: t("detail.control.notify"),
      settings: t("detail.control.settings"),
    };
    const operations: Record<Exclude<DeviceControlAction, "text" | "clipboard">, () => Promise<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
    }>> = {
      home: () => DeviceService.home(serial),
      back: () => DeviceService.back(serial),
      recent: () => DeviceService.recent(serial),
      power: () => DeviceService.power(serial),
      volup: () => DeviceService.volumeUp(serial),
      voldown: () => DeviceService.volumeDown(serial),
      lock: () => DeviceService.lock(serial),
      wake: () => DeviceService.wake(serial),
      rotate: () => DeviceService.rotate(serial, Boolean(value)),
      notify: () => DeviceService.openNotifications(serial),
      settings: () => DeviceService.openSettings(serial),
    };
    void act(labels[action], operations[action], action);
  };

  const onScreenKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const shortcut = shortcutForScreenKey(event.nativeEvent);
    if (!shortcut) return;
    event.preventDefault();
    runControlAction(shortcut);
  };

  const startScrcpy = async () => {
    if (disabled || scrcpyBusy) return;
    setScrcpyBusy("start");
    setStatusText(t("detail.control.startingScrcpy"));
    try {
      // Ensure network devices are connected first
      if (serial.includes(":")) {
        const c = await DeviceService.connect(serial);
        if (!c.success) {
          const reason = c.stderr || c.stdout || t("detail.control.scrcpyStartFailed");
          setScrcpyLabel("error");
          setStatusText(reason);
          appendDiagnostic(`[scrcpy]\n${c.stdout || ""}\n${c.stderr || reason}`);
          return;
        }
      }
      let extra = "";
      try {
        const raw = sessionStorage.getItem(`rdc.settings.draft.${serial}`);
        extra = raw ? String((JSON.parse(raw) as { scrcpyArgs?: string }).scrcpyArgs || "") : "";
      } catch {
        extra = "";
      }
      const sizeHit = extra.match(/--max-size[=\s]+(\d+)/);
      const rateHit = extra.match(/--video-bit-rate[=\s]+(\d+)/);
      const maxSize = sizeHit ? Number(sizeHit[1]) : 1080;
      const bitRate = rateHit ? Number(rateHit[1]) : 8;
      const r = await DeviceService.scrcpyStart(serial, maxSize || 1080, bitRate || 8, extra);
      const state = scrcpyStateFromResult(r, "start");
      setScrcpyLabel(state);
      if (state === "running") {
        setStatusText(t("detail.control.scrcpyStarted"));
        void syncScrcpy();
      } else {
        const reason = r.stderr || r.stdout || t("detail.control.scrcpyStartFailed");
        setStatusText(reason);
        appendDiagnostic(`[scrcpy]\n${reason}`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setScrcpyLabel("error");
      setStatusText(reason || t("detail.control.scrcpyStartFailed"));
      appendDiagnostic(`[scrcpy]\n${reason || t("detail.control.scrcpyStartFailed")}`);
    } finally {
      setScrcpyBusy(null);
    }
  };

  const stopScrcpy = async () => {
    if (scrcpyBusy) return;
    setScrcpyBusy("stop");
    try {
      const r = await DeviceService.scrcpyStop(serial);
      const state = scrcpyStateFromResult(r, "stop");
      setScrcpyLabel(state);
      if (state === "stopped") {
        setStatusText(t("detail.control.scrcpyStopped"));
      } else {
        const reason = r.stderr || r.stdout || t("detail.control.scrcpyStopFailed");
        setStatusText(reason);
        appendDiagnostic(`[scrcpy stop]\n${reason}`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setScrcpyLabel("error");
      setStatusText(reason || t("detail.control.scrcpyStopFailed"));
      appendDiagnostic(`[scrcpy stop]\n${reason || t("detail.control.scrcpyStopFailed")}`);
    } finally {
      setScrcpyBusy(null);
    }
  };

  const restartScrcpy = async () => {
    if (disabled || scrcpyBusy) return;
    setScrcpyBusy("restart");
    setStatusText(t("detail.control.reconnectingScrcpy"));
    try {
      const r = await DeviceService.scrcpyRestart(serial);
      const state = scrcpyStateFromResult(r, "restart");
      setScrcpyLabel(state);
      if (state === "running") {
        setStatusText(t("detail.control.scrcpyReconnected"));
        void syncScrcpy();
      } else {
        const reason = r.stderr || r.stdout || t("detail.control.scrcpyReconnectFailed");
        setStatusText(reason);
        appendDiagnostic(`[scrcpy restart]\n${reason}`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setScrcpyLabel("error");
      setStatusText(reason || t("detail.control.scrcpyReconnectFailed"));
      appendDiagnostic(`[scrcpy restart]\n${reason || t("detail.control.scrcpyReconnectFailed")}`);
    } finally {
      setScrcpyBusy(null);
    }
  };

  return (
    <div className="split-control">
      <DevicePreview
        serial={serial}
        disabled={disabled}
        controlBusyAction={actionBusy}
        scrcpyStatus={scrcpyLabel}
        scrcpyBusy={scrcpyBusy}
        preview={previewState}
        previewFlash={previewFlash}
        livePreview={livePreview}
        fullscreen={fullscreen}
        hideChrome={hideChrome}
        screenRef={screenRef}
        frameRef={frameRef}
        onMouseMove={bumpChrome}
        onKeyDown={onScreenKeyDown}
        onClick={onScreenClick}
        onDoubleClick={(e) => {
          const { x, y } = toDevicePoint(e);
          void act(t("detail.control.doubleClick"), async () => {
            await DeviceService.tap(serial, x, y);
            return DeviceService.tap(serial, x, y);
          });
        }}
        onContextMenu={onContextMenu}
        onAuxClick={onAuxClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={(e) => {
          const { x, y } = toDevicePoint(e);
          const dy = e.deltaY > 0 ? 300 : -300;
          void act(t("detail.control.swipe"), () => DeviceService.swipe(serial, x, y, x, y + dy, 200));
        }}
        onStartScrcpy={() => void startScrcpy()}
        onStopScrcpy={() => void stopScrcpy()}
        onRestartScrcpy={() => void restartScrcpy()}
        onTakeShot={takeShot}
        onRefreshPreview={takeShot}
        onToggleLivePreview={() => {
          setLivePreview((value) => {
            const next = !value;
            if (next) refreshPreview();
            else window.clearTimeout(refreshTimer.current);
            return next;
          });
        }}
        onClosePreview={() => {
          window.clearTimeout(refreshTimer.current);
          setPreviewState(emptyPreview());
          setPreviewFlash(false);
        }}
        onOpenFolder={() => {
          if (previewState.path) {
            void DeviceService.revealInFolder(previewState.path).catch((e) =>
              setStatusText(e instanceof Error ? e.message : String(e)),
            );
          }
        }}
        onFullscreen={() => {
          const el = screenRef.current;
          if (!el) return;
          if (document.fullscreenElement === el) {
            void document.exitFullscreen();
          } else {
            void el.requestFullscreen().catch((e) => setStatusText(String(e)));
          }
        }}
        onRotate={() => void act(t("detail.control.rotate"), () => DeviceService.rotate(serial, true), "rotate")}
      />

      <div className="control-panel">
        <DeviceControlPanel
          disabled={disabled}
          busyAction={actionBusy}
          feedback={feedback}
          retryingFeedbackId={retryingFeedbackId}
          onRetryFeedback={retryFeedback}
          onAction={runControlAction}
          onScreenshot={takeShot}
          onValidationError={(message) => {
            setStatusText(message);
            appendDiagnostic(message);
          }}
        />

        <DeviceShell
          serial={serial}
          disabled={disabled}
          diagnostic={shellDiagnostic}
          onStatus={setStatusText}
        />
      </div>
    </div>
  );
}

function Files({
  serial,
  setStatusText,
  disabled = false,
}: {
  serial: string;
  setStatusText: (s: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const defaults = ["/sdcard", "/sdcard/Download", "/data/local/tmp", "/sdcard/Pictures"];
  const [path, setPath] = useState(() => {
    try {
      return sessionStorage.getItem(`rdc.files.path.${serial}`) || "/sdcard";
    } catch {
      return "/sdcard";
    }
  });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [storage, setStorage] = useState("");
  const [loading, setLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("rdc.files.bookmarks");
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length
        ? parsed
        : defaults;
    } catch {
      return defaults;
    }
  });
  const [fileQuery, setFileQuery] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "size" | "modified">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const visibleFiles = files
    .filter(
      (f) => !fileQuery.trim() || f.name.toLowerCase().includes(fileQuery.trim().toLowerCase()),
    )
    .slice()
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (sortKey === "size") cmp = (Number(a.size) || 0) - (Number(b.size) || 0);
      else if (sortKey === "modified") cmp = a.modified.localeCompare(b.modified);
      else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      return sortAsc ? cmp : -cmp;
    });

  const toggleSort = (key: "name" | "size" | "modified") => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortMark = (key: "name" | "size" | "modified") =>
    sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";

  const load = async (p = path) => {
    setLoading(true);
    try {
      setFiles(await DeviceService.listFiles(serial, p));
      setStorage(await DeviceService.storageInfo(serial));
    } catch (e) {
      setStatusText(e instanceof Error ? t("detail.files.listFailedWith", { msg: e.message }) : t("detail.files.listFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!disabled) void load();
  }, [serial, disabled]);

  useEffect(() => {
    try {
      localStorage.setItem("rdc.files.bookmarks", JSON.stringify(bookmarks));
    } catch {
      /* ignore */
    }
  }, [bookmarks]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`rdc.files.path.${serial}`, path);
    } catch {
      /* ignore */
    }
  }, [serial, path]);

  const go = (p: string) => {
    const next = p.trim() || "/";
    setPath(next);
    setFileQuery("");
    void load(next);
  };

  const openEntry = (f: FileEntry) => {
    if (f.isDir) go(f.path);
  };

  const up = () => {
    go(path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");
  };

  return (
    <div className="stack">
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Card>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="row" style={{ flex: 1 }}>
            <Button size="sm" onClick={up}>
              {t("detail.files.up")}
            </Button>
            <input style={{ flex: 1 }} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go(path)} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!path}
              onClick={() => {
                void navigator.clipboard.writeText(path).then(
                  () => setStatusText(t("common.panel.copied", { value: path })),
                  () => void alert(t("common.panel.copyFailed")),
                );
              }}
            >
              {t("detail.files.copyPath")}
            </Button>
            <Button size="sm" onClick={() => load()}>
              {t("common.refresh")}
            </Button>
          </div>
          <div className="row">
            <Button
              size="sm"
              icon={<FolderPlus size={14} />}
              onClick={async () => {
                const name = prompt(t("detail.files.folderNamePrompt"));
                if (!name) return;
                const r = await DeviceService.mkdir(serial, `${path.replace(/\/+$/, "")}/${name}`);
                if (!r.success) {
                  const reason = (r.stderr || r.stdout || t("detail.files.createFailed")).trim();
                  setStatusText(reason);
                  void alert(reason);
                  return;
                }
                setStatusText(t("detail.files.created", { name }));
                await load();
              }}
            >
              {t("detail.files.newFolder")}
            </Button>
            <Button
              size="sm"
              icon={<Upload size={14} />}
              onClick={async () => {
                try {
                  const local = await open({ multiple: false, directory: false });
                  if (typeof local !== "string" || !local) return;
                  setStatusText(t("detail.files.uploading"));
                  const name = local.split(/[/\\]/).pop() || "file";
                  const r = await DeviceService.uploadFile(
                    serial,
                    local,
                    `${path.replace(/\/+$/, "")}/${name}`,
                  );
                  if (!r.success) {
                    const reason = (r.stderr || r.stdout || t("detail.files.uploadFailed")).trim();
                    setStatusText(reason);
                    void alert(reason);
                    return;
                  }
                  setStatusText(t("detail.files.uploadDone"));
                  await load();
                } catch {
                  /* cancelled */
                }
              }}
            >
              {t("detail.files.upload")}
            </Button>
          </div>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 10, fontSize: 12 }}>
          <button type="button" className="muted" onClick={() => go("/")}>
            /
          </button>
          {path
            .split("/")
            .filter(Boolean)
            .map((seg, i, arr) => {
              const target = "/" + arr.slice(0, i + 1).join("/");
              const last = i === arr.length - 1;
              return (
                <span key={target} className="row" style={{ gap: 4 }}>
                  <span className="muted">/</span>
                  <button
                    type="button"
                    style={{ fontWeight: last ? 600 : 400 }}
                    onClick={() => go(target)}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
        </div>
        <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          {bookmarks.map((b) => (
            <span key={b} className="row" style={{ gap: 0 }}>
              <Button
                size="sm"
                variant={path.replace(/\/+$/, "") === b.replace(/\/+$/, "") ? "primary" : "ghost"}
                title={b}
                onClick={() => go(b)}
              >
                {b}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t("detail.files.removeBookmark")}
                onClick={() => setBookmarks((x) => x.filter((p) => p !== b))}
              >
                ×
              </Button>
            </span>
          ))}
          <Button
            size="sm"
            variant="secondary"
            disabled={!path.trim() || bookmarks.includes(path.trim())}
            onClick={() => setBookmarks((x) => [path.trim(), ...x.filter((p) => p !== path.trim())].slice(0, 16))}
          >
            {t("detail.files.bookmarkPath")}
          </Button>
        </div>
        <div className="muted mono" style={{ fontSize: 12, marginBottom: 10, whiteSpace: "pre-wrap" }}>
          {storage || t("detail.files.storagePlaceholder")}
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            style={{ flex: 1, minWidth: 160 }}
            placeholder={t("detail.files.filterPlaceholder")}
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
          />
          {fileQuery && (
            <Button size="sm" variant="ghost" onClick={() => setFileQuery("")}>
              {t("detail.clear")}
            </Button>
          )}
          <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {fileQuery ? t("detail.files.matchCount", { m: visibleFiles.length, n: files.length }) : t("detail.files.totalCount", { n: files.length })}
          </span>
        </div>
        {loading ? (
          <Skeleton count={6} height={28} />
        ) : files.length === 0 ? (
          <div className="empty-state">{t("detail.files.empty")}</div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            {t("detail.files.noMatch")}
            <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setFileQuery("")}>
              {t("detail.files.clearFilter")}
            </Button>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>
                  <button type="button" onClick={() => toggleSort("name")}>
                    {t("detail.files.colName")}{sortMark("name")}
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => toggleSort("size")}>
                    {t("detail.files.colSize")}{sortMark("size")}
                  </button>
                </th>
                <th>{t("detail.files.colPerm")}</th>
                <th>
                  <button type="button" onClick={() => toggleSort("modified")}>
                    {t("detail.files.colModified")}{sortMark("modified")}
                  </button>
                </th>
                <th>{t("detail.files.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleFiles.map((f) => (
                <tr key={f.path}>
                  <td>
                    <button onClick={() => openEntry(f)} style={{ fontWeight: f.isDir ? 600 : 400 }}>
                      {f.isDir ? "📁 " : "📄 "}
                      {f.name}
                    </button>
                  </td>
                  <td>{f.size}</td>
                  <td className="mono">{f.permissions}</td>
                  <td>{f.modified}</td>
                  <td>
                    <div className="row">
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("detail.files.copyPath")}
                        onClick={() => {
                          void navigator.clipboard.writeText(f.path).then(
                            () => setStatusText(t("common.panel.copied", { value: f.path })),
                            () => void alert(t("common.panel.copyFailed")),
                          );
                        }}
                      >
                        {t("common.copy")}
                      </Button>
                      {!f.isDir && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Download size={14} />}
                          onClick={async () => {
                            try {
                              const local = await save({ defaultPath: f.name });
                              if (!local) return;
                              setStatusText(t("detail.files.downloading"));
                              const r = await DeviceService.downloadFile(serial, f.path, local);
                              if (!r.success) {
                                const reason = (r.stderr || r.stdout || t("detail.files.downloadFailed")).trim();
                                setStatusText(reason);
                                void alert(reason);
                                return;
                              }
                              setStatusText(t("detail.files.downloadDone"));
                              if (await askConfirm(t("detail.files.confirmReveal"))) {
                                await DeviceService.revealInFolder(local);
                              }
                            } catch {
                              /* cancelled */
                            }
                          }}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={14} />}
                        onClick={async () => {
                          if (!(await askConfirm(t("detail.files.confirmDelete", { name: f.name })))) return;
                          const r = await DeviceService.deleteFile(serial, f.path);
                          if (!r.success) {
                            const reason = (r.stderr || r.stdout || t("detail.files.deleteFailed")).trim();
                            setStatusText(reason);
                            void alert(reason);
                            return;
                          }
                          setStatusText(t("detail.files.deleted", { name: f.name }));
                          await load();
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      </fieldset>
    </div>
  );
}

function Apps({
  serial,
  setStatusText,
  disabled = false,
}: {
  serial: string;
  setStatusText: (s: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState(() => {
    try {
      return sessionStorage.getItem(`rdc.apps.keyword.${serial}`) || "";
    } catch {
      return "";
    }
  });
  const [includeSystem, setIncludeSystem] = useState(() => {
    try {
      return sessionStorage.getItem(`rdc.apps.system.${serial}`) === "1";
    } catch {
      return false;
    }
  });
  const [detail, setDetail] = useState("");
  const [detailBusy, setDetailBusy] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setApps(await DeviceService.listApps(serial, includeSystem));
    } catch (e) {
      setStatusText(e instanceof Error ? t("detail.apps.listFailedWith", { msg: e.message }) : t("detail.apps.listFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!disabled) void load();
  }, [serial, includeSystem, disabled]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`rdc.apps.keyword.${serial}`, keyword);
      sessionStorage.setItem(`rdc.apps.system.${serial}`, includeSystem ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [serial, keyword, includeSystem]);

  const filtered = apps.filter(
    (a) =>
      a.packageName.toLowerCase().includes(keyword.toLowerCase()) ||
      a.label.toLowerCase().includes(keyword.toLowerCase())
  );

  return (
    <div className="stack">
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Card>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="row" style={{ flex: 1 }}>
            <Search size={16} className="muted" />
            <input
              style={{ flex: 1 }}
              placeholder={t("detail.apps.searchPlaceholder")}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            {keyword && (
              <Button size="sm" variant="ghost" onClick={() => setKeyword("")}>
                {t("detail.clear")}
              </Button>
            )}
            <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {keyword ? t("detail.files.matchCount", { m: filtered.length, n: apps.length }) : t("detail.apps.totalCount", { n: apps.length })}
            </span>
            <label className="row muted" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} />
              {t("detail.apps.includeSystem")}
            </label>
            <Button size="sm" onClick={load}>
              {t("common.refresh")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Upload size={14} />}
              loading={installing}
              disabled={installing}
              onClick={async () => {
                try {
                  const path = await open({
                    multiple: false,
                    directory: false,
                    filters: [{ name: "APK", extensions: ["apk"] }],
                  });
                  if (typeof path !== "string" || !path) return;
                  const name = path.split(/[/\\]/).pop() || path;
                  setInstalling(true);
                  setStatusText(t("detail.apps.installing", { name }));
                  const r = await DeviceService.installApk(serial, path, true);
                  const ok = r.success || /success/i.test(r.stdout);
                  if (ok) {
                    setStatusText(t("detail.apps.installSuccess", { name }));
                    await load();
                  } else {
                    const reason = (r.stderr || r.stdout || t("detail.apps.installFailed")).trim();
                    setStatusText(reason);
                    void alert(reason);
                  }
                } catch (e) {
                  if (e) void alert(String(e));
                } finally {
                  setInstalling(false);
                }
              }}
            >
              {installing ? t("detail.apps.installingShort") : t("detail.apps.installApk")}
            </Button>
          </div>
        </div>

        {loading ? (
          <Skeleton count={8} height={28} />
        ) : apps.length === 0 ? (
          <div className="empty-state">
            {t("detail.apps.empty")}
            {!disabled && (
              <span className="muted" style={{ marginLeft: 8 }}>
                {t("detail.apps.emptyHint")}
              </span>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {t("detail.apps.noMatch")}
            <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setKeyword("")}>
              {t("detail.apps.clearSearch")}
            </Button>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("detail.apps.colApp")}</th>
                <th>{t("detail.apps.colVersion")}</th>
                <th>{t("detail.apps.colPath")}</th>
                <th>{t("detail.files.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.packageName}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{a.label}</div>
                    <button
                      type="button"
                      className="mono muted"
                      title={t("detail.apps.clickCopyPkg")}
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(a.packageName).then(
                          () => setStatusText(t("common.panel.copied", { value: a.packageName })),
                          () => void alert(t("common.panel.copyFailed")),
                        );
                      }}
                    >
                      {a.packageName}
                    </button>
                  </td>
                  <td>{a.versionName || "—"}</td>
                  <td className="mono" style={{ fontSize: 11, maxWidth: 220, wordBreak: "break-all" }}>
                    {a.apkPath}
                  </td>
                  <td>
                    <div className="row">
                      <Button
                        size="sm"
                        icon={<Play size={13} />}
                        loading={appBusy === `start:${a.packageName}`}
                        disabled={appBusy !== null}
                        onClick={async () => {
                          setAppBusy(`start:${a.packageName}`);
                          setStatusText(t("detail.apps.starting", { pkg: a.packageName }));
                          try {
                            const r = await DeviceService.startApp(serial, a.packageName);
                            if (r.success) setStatusText(t("detail.apps.started", { pkg: a.packageName }));
                            else {
                              setStatusText(r.stderr || r.stdout || t("detail.apps.startFailed"));
                              void alert(r.stderr || r.stdout || t("detail.apps.startFailed"));
                            }
                          } finally {
                            setAppBusy(null);
                          }
                        }}
                      >
                        {t("detail.apps.startBtn")}
                      </Button>
                      <Button
                        size="sm"
                        icon={<Square size={13} />}
                        loading={appBusy === `stop:${a.packageName}`}
                        disabled={appBusy !== null}
                        onClick={async () => {
                          setAppBusy(`stop:${a.packageName}`);
                          setStatusText(t("detail.apps.stopping", { pkg: a.packageName }));
                          try {
                            const r = await DeviceService.stopApp(serial, a.packageName);
                            if (r.success) setStatusText(t("detail.apps.stopped", { pkg: a.packageName }));
                            else {
                              setStatusText(r.stderr || r.stdout || t("detail.apps.stopFailed"));
                              void alert(r.stderr || r.stdout || t("detail.apps.stopFailed"));
                            }
                          } finally {
                            setAppBusy(null);
                          }
                        }}
                      >
                        {t("detail.apps.stopBtn")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={detailBusy === a.packageName}
                        disabled={detailBusy !== null}
                        onClick={async () => {
                          setDetailBusy(a.packageName);
                          setStatusText(t("detail.apps.loadingDetail", { pkg: a.packageName }));
                          try {
                            const d = await DeviceService.getAppDetail(serial, a.packageName);
                            const perm = await DeviceService.getAppPermissions(serial, a.packageName);
                            const act = await DeviceService.getAppActivities(serial, a.packageName);
                            setDetail(
                              `Package: ${d.packageName}\nVersion: ${d.versionName} (${d.versionCode})\nFirst: ${d.firstInstallTime}\nUpdate: ${d.lastUpdateTime}\nPath: ${d.apkPath}\n\nPermissions:\n${perm}\n\nActivities:\n${act}`
                            );
                            setStatusText(t("detail.apps.detailLoaded"));
                          } catch (e) {
                            setStatusText(e instanceof Error ? e.message : t("detail.apps.detailFailed"));
                          } finally {
                            setDetailBusy(null);
                          }
                        }}
                      >
                        {detailBusy === a.packageName ? t("common.loading") : t("detail.apps.detailBtn")}
                      </Button>
                      <select
                        defaultValue=""
                        style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
                        onChange={async (e) => {
                          const v = e.target.value;
                          e.target.value = "";
                          if (v === "clear") {
                            if (!(await askConfirm(t("detail.apps.confirmClear", { pkg: a.packageName })))) return;
                            setStatusText(t("detail.apps.clearing", { pkg: a.packageName }));
                            void DeviceService.clearAppData(serial, a.packageName).then((r) => {
                              if (r.success) setStatusText(t("detail.apps.cleared", { pkg: a.packageName }));
                              else {
                                setStatusText(r.stderr || r.stdout || t("detail.apps.clearFailed"));
                                void alert(r.stderr || r.stdout || t("detail.apps.clearFailed"));
                              }
                            });
                          }
                          if (v === "copy") {
                            void navigator.clipboard.writeText(a.packageName).then(
                              () => setStatusText(t("common.panel.copied", { value: a.packageName })),
                              () => void alert(t("common.panel.copyFailed")),
                            );
                          }
                          if (v === "uninstall") {
                            if (!(await askConfirm(t("detail.apps.confirmUninstall", { pkg: a.packageName })))) return;
                            setStatusText(t("detail.apps.uninstalling", { pkg: a.packageName }));
                            void DeviceService.uninstallApp(serial, a.packageName).then((r) => {
                              if (r.success) {
                                setStatusText(t("detail.apps.uninstalled", { pkg: a.packageName }));
                                void load();
                              } else {
                                setStatusText(r.stderr || r.stdout || t("detail.apps.uninstallFailed"));
                                void alert(r.stderr || r.stdout || t("detail.apps.uninstallFailed"));
                              }
                            });
                          }
                        }}
                      >
                        <option value="" disabled>
                          {t("detail.more")}
                        </option>
                        <option value="copy">{t("detail.apps.copyPkg")}</option>
                        <option value="clear">{t("detail.apps.clearData")}</option>
                        <option value="uninstall">{t("detail.apps.uninstall")}</option>
                      </select>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {detail && (
        <Card
          title={t("detail.apps.detailTitle")}
          action={
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(detail).then(
                    () => setStatusText(t("detail.apps.copiedDetail")),
                    () => void alert(t("common.panel.copyFailed")),
                  );
                }}
              >
                {t("detail.apps.copyAll")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDetail("")}>
                {t("common.close")}
              </Button>
            </div>
          }
        >
          <pre className="shell-output">{detail}</pre>
        </Card>
      )}
      </fieldset>
    </div>
  );
}

function DeviceLogs({ serial, disabled = false }: { serial: string; disabled?: boolean }) {
  const { t } = useI18n();
  const persistKey = `rdc.logcat.${serial}`;
  const [logs, setLogs] = useState("");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState(() => {
    try {
      return sessionStorage.getItem(`${persistKey}.filter`) || "";
    } catch {
      return "";
    }
  });
  const [errorOnly, setErrorOnly] = useState(() => {
    try {
      return sessionStorage.getItem(`${persistKey}.errorOnly`) === "1";
    } catch {
      return false;
    }
  });
  const [autoScroll, setAutoScroll] = useState(() => {
    try {
      return sessionStorage.getItem(`${persistKey}.autoScroll`) !== "0";
    } catch {
      return true;
    }
  });
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [copiedList, setCopiedList] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ignoreScroll = useRef(false);

  const nearBottom = (el: HTMLDivElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  const load = async (clear = false) => {
    if (disabled || (paused && !clear)) return;
    try {
      const text = await DeviceService.logcat(serial, 300, clear);
      setLogs(text);
    } catch (e) {
      if (!paused) {
        const err = e instanceof Error ? e.message : String(e);
        setLogs((prev) => prev || t("detail.logs.readFailed", { msg: err }));
      }
    }
  };

  useEffect(() => {
    try {
      setFilter(sessionStorage.getItem(`${persistKey}.filter`) || "");
      setErrorOnly(sessionStorage.getItem(`${persistKey}.errorOnly`) === "1");
      setAutoScroll(sessionStorage.getItem(`${persistKey}.autoScroll`) !== "0");
    } catch {
      setFilter("");
      setErrorOnly(false);
      setAutoScroll(true);
    }
  }, [persistKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`${persistKey}.filter`, filter);
      sessionStorage.setItem(`${persistKey}.errorOnly`, errorOnly ? "1" : "0");
      sessionStorage.setItem(`${persistKey}.autoScroll`, autoScroll ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [filter, errorOnly, autoScroll]);

  useEffect(() => {
    if (disabled) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [serial, paused, disabled]);

  useEffect(() => {
    if (!autoScroll || !ref.current) return;
    ignoreScroll.current = true;
    ref.current.scrollTop = ref.current.scrollHeight;
    window.requestAnimationFrame(() => {
      ignoreScroll.current = false;
    });
  }, [logs, autoScroll]);

  const colorClass = (line: string) => {
    if (line.includes(" E ") || line.includes("ERROR")) return "ERROR";
    if (line.includes(" W ") || line.includes("WARN")) return "WARN";
    if (line.includes(" D ") || line.includes("DEBUG")) return "DEBUG";
    return "INFO";
  };

  const allLines = logs.split("\n").filter((l) => l.length > 0);
  const lines = allLines
    .filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))
    .filter((l) => !errorOnly || colorClass(l) === "ERROR");
  const filtered = Boolean(filter || errorOnly);

  return (
    <Card
      title={t("detail.logs.title")}
      action={
        <div className="row">
          <Button
            size="sm"
            variant={errorOnly ? "danger" : "secondary"}
            onClick={() => setErrorOnly((v) => !v)}
          >
            {errorOnly ? t("detail.logs.errorOnlyOn") : t("detail.logs.errorOnly")}
          </Button>
          <Button size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? t("detail.logs.resume") : t("detail.logs.pause")}
          </Button>
          <label className="row muted" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            {t("detail.logs.autoScroll")}
          </label>
          <select
            defaultValue=""
            style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (v === "clear") void load(true);
              if (v === "export" && lines.length > 0) {
                const parts = [`logcat_${serial.replace(":", "_")}`];
                if (errorOnly) parts.push("ERROR");
                if (filter.trim()) parts.push(filter.trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 24));
                void (async () => {
                  try {
                    const path = await save({
                      defaultPath: `${parts.join("-")}.txt`,
                      filters: [{ name: "Text", extensions: ["txt", "log"] }],
                    });
                    if (!path) return;
                    const saved = await DeviceService.exportLogs(path, lines.join("\n"));
                    if (await askConfirm(t("detail.logs.savedConfirm", { path: saved }))) {
                      await DeviceService.revealInFolder(saved);
                    }
                  } catch (err) {
                    if (err) void alert(String(err));
                  }
                })();
              }
              if (v === "copy" && lines.length > 0) {
                void navigator.clipboard.writeText(lines.join("\n")).then(
                  () => {
                    setCopiedList(true);
                    window.setTimeout(() => setCopiedList(false), 1500);
                  },
                  () => void alert(t("common.panel.copyFailed")),
                );
              }
            }}
          >
            <option value="" disabled>
              {copiedList ? t("detail.logs.copiedLines") : t("detail.more")}
            </option>
            <option value="clear">{t("detail.logs.clear")}</option>
            <option value="export" disabled={lines.length === 0}>
              {t("detail.logs.exportTxt")}
            </option>
            <option value="copy" disabled={lines.length === 0}>
              {t("detail.logs.copyLines")}
            </option>
          </select>
        </div>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          style={{ flex: 1 }}
          placeholder={t("detail.logs.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {filtered ? t("detail.logs.matchCount", { m: lines.length, n: allLines.length }) : t("detail.logs.totalCount", { n: allLines.length })}
        </span>
      </div>
      <div
        ref={ref}
        className="shell-output"
        style={{ maxHeight: 520, minHeight: 360 }}
        onScroll={() => {
          const el = ref.current;
          if (!el || ignoreScroll.current) return;
          const atBottom = nearBottom(el);
          if (!atBottom && autoScroll) setAutoScroll(false);
          if (atBottom && !autoScroll) setAutoScroll(true);
        }}
      >
        {lines.length === 0 ? (
          <div className="empty-state">
            {filtered ? (
              <>
                {t("detail.logs.noMatch")}
                <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setFilter("")}>
                  {t("detail.logs.clearFilter")}
                </Button>
              </>
            ) : disabled ? (
              t("detail.logs.offline")
            ) : (
              t("detail.logs.empty")
            )}
          </div>
        ) : (
          lines.map((l, i) => (
            <button
              key={i}
              type="button"
              className={`log-line ${colorClass(l)}`}
              style={{ display: "block", width: "100%", textAlign: "left" }}
              title={t("detail.logs.clickCopy")}
              onClick={() => {
                void navigator.clipboard.writeText(l).then(
                  () => {
                    setCopiedAt(i);
                    window.setTimeout(() => setCopiedAt((cur) => (cur === i ? null : cur)), 1500);
                  },
                  () => void alert(t("common.panel.copyFailed")),
                );
              }}
            >
              {copiedAt === i ? t("detail.logs.copiedLine", { line: l }) : l}
            </button>
          ))
        )}
      </div>
    </Card>
  );
}

function DeviceSettings({
  serial,
  initialResolution,
  initialDpi,
  setStatusText,
  onApplied,
  deviceId,
  disabled = false,
}: {
  serial: string;
  initialResolution?: string;
  initialDpi?: string;
  setStatusText: (s: string) => void;
  onApplied?: () => void;
  deviceId: string;
  disabled?: boolean;
}) {
  const offline = disabled;
  const { t } = useI18n();
  const draftKey = `rdc.settings.draft.${serial}`;
  const readDraft = () => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const draft = readDraft();
  const [resolution, setResolution] = useState(
    validResolution(draft.resolution || "")
      ? draft.resolution!
      : validResolution(initialResolution || "")
        ? initialResolution!
        : "1080x1920",
  );
  const [dpi, setDpi] = useState(
    validDpi(draft.dpi || "") ? draft.dpi! : validDpi(initialDpi || "") ? initialDpi! : "320",
  );
  const [lang, setLang] = useState(draft.lang || "zh-CN");
  const [adbPort, setAdbPort] = useState(() => {
    if (draft.adbPort) return draft.adbPort;
    const m = serial.match(/:(\d+)$/);
    return m?.[1] || "5555";
  });
  const [scrcpyArgs, setScrcpyArgs] = useState(draft.scrcpyArgs || "--max-size 1080 --video-bit-rate 8M");
  const [proxyInput, setProxyInput] = useState(draft.proxy || "");
  const [proxyCurrent, setProxyCurrent] = useState<string>("");
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const navigate = useNavigate();
  const [autoStart, setAutoStart] = useState(
    Boolean(settings?.autoStartDeviceIds?.includes(deviceId)) || draft.autoStart === "1",
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          resolution,
          dpi,
          lang,
          adbPort,
          scrcpyArgs,
          autoStart: autoStart ? "1" : "0",
        }),
      );
    } catch {
      /* ignore */
    }
  }, [draftKey, resolution, dpi, lang, adbPort, scrcpyArgs, autoStart]);

  useEffect(() => {
    if (!settings) return;
    setAutoStart(Boolean(settings.autoStartDeviceIds?.includes(deviceId)));
  }, [settings, deviceId]);

  useEffect(() => {
    let cancelled = false;
    void DeviceService.shell(serial, "settings get global http_proxy")
      .then((r) => {
        if (cancelled) return;
        const v = (r.stdout || "").trim();
        setProxyCurrent(v && v !== ":0" && v.toLowerCase() !== "null" ? v : "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serial]);

  return (
    <fieldset disabled={offline} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <Card title={t("detail.settings.title")}>
      <div className="form-grid">
        <div className="field">
          <label>{t("common.panel.resolution")}</label>
          <select
            value={(RES_PRESETS as readonly string[]).includes(resolution) ? resolution : "__custom__"}
            onChange={(e) => {
              if (e.target.value !== "__custom__") setResolution(e.target.value);
            }}
          >
            <option value="720x1280">720 × 1280</option>
            <option value="1080x1920">1080 × 1920</option>
            <option value="1080x2400">1080 × 2400</option>
            <option value="1440x3200">1440 × 3200</option>
            <option value="1200x1920">{t("detail.settings.resTablet")}</option>
            <option value="__custom__">{t("detail.settings.custom")}</option>
          </select>
          <input value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder={t("detail.settings.whPlaceholder")} />
          {!validResolution(resolution) && (
            <div className="bad" style={{ fontSize: 12 }}>
              {t("detail.settings.resInvalid")}
            </div>
          )}
        </div>
        <div className="field">
          <label>DPI</label>
          <select
            value={(DPI_PRESETS as readonly string[]).includes(dpi) ? dpi : "__custom__"}
            onChange={(e) => {
              if (e.target.value !== "__custom__") setDpi(e.target.value);
            }}
          >
            {DPI_PRESETS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            <option value="__custom__">{t("detail.settings.custom")}</option>
          </select>
          <input value={dpi} onChange={(e) => setDpi(e.target.value)} placeholder="DPI" />
          {!validDpi(dpi) && (
            <div className="bad" style={{ fontSize: 12 }}>
              {t("detail.settings.dpiInvalid")}
            </div>
          )}
        </div>
        <div className="field">
          <label>{t("detail.settings.language")}</label>
          <select
            value={["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"].includes(lang) ? lang : "__custom__"}
            onChange={(e) => {
              if (e.target.value !== "__custom__") setLang(e.target.value);
            }}
          >
            <option value="zh-CN">{t("detail.settings.langZhHans")}</option>
            <option value="zh-TW">{t("detail.settings.langZhHant")}</option>
            <option value="en-US">English en-US</option>
            <option value="ja-JP">日本語 ja-JP</option>
            <option value="ko-KR">한국어 ko-KR</option>
            <option value="__custom__">{t("detail.settings.custom")}</option>
          </select>
          <input value={lang} onChange={(e) => setLang(e.target.value)} placeholder={t("detail.settings.langPlaceholder")} />
        </div>
        <div className="field">
          <label>{t("detail.settings.adbPort")}</label>
          <input value={adbPort} onChange={(e) => setAdbPort(e.target.value)} placeholder="5555" />
          <Button
            size="sm"
            style={{ marginTop: 8 }}
            disabled={!/^\d{2,5}$/.test(adbPort.trim())}
            onClick={async () => {
              const port = adbPort.trim();
              const host = serial.includes(":") ? serial.slice(0, serial.lastIndexOf(":")) : serial;
              const next = `${host}:${port}`;
              setStatusText(t("detail.settings.reconnecting", { addr: next }));
              if (serial.includes(":")) await DeviceService.disconnect(serial);
              const r = await DeviceService.connect(next);
              if (r.success) {
                setStatusText(t("detail.settings.connected", { addr: next }));
                onApplied?.();
              } else {
                const reason = (r.stderr || r.stdout || t("detail.settings.reconnectFailed")).trim();
                setStatusText(reason);
                void alert(reason);
              }
            }}
          >
            {t("detail.settings.reconnectBtn")}
          </Button>
        </div>
        <div className="field">
          <label>{t("detail.settings.proxy")}</label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {proxyCurrent
              ? t("detail.settings.proxyCurrent", { addr: proxyCurrent })
              : t("detail.settings.proxyNone")}
          </div>
          <input
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder={t("detail.settings.proxyPlaceholder")}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              variant="primary"
              disabled={!/^[\w.-]+:\d{2,5}$/.test(proxyInput.trim())}
              onClick={async () => {
                const v = proxyInput.trim();
                const r = await DeviceService.shell(serial, `settings put global http_proxy ${v}`);
                if (r.success) {
                  setProxyCurrent(v);
                  setStatusText(t("detail.settings.proxyApplied", { addr: v }));
                  onApplied?.();
                } else {
                  const reason = (r.stderr || r.stdout || t("detail.settings.proxyFailed")).trim();
                  setStatusText(reason);
                  void alert(reason);
                }
              }}
            >
              {t("detail.settings.proxyApplyBtn")}
            </Button>
            <Button
              size="sm"
              disabled={!proxyCurrent}
              onClick={async () => {
                const r = await DeviceService.shell(serial, "settings put global http_proxy :0");
                if (r.success) {
                  setProxyCurrent("");
                  setStatusText(t("detail.settings.proxyCleared"));
                  onApplied?.();
                } else {
                  const reason = (r.stderr || r.stdout || t("detail.settings.proxyFailed")).trim();
                  setStatusText(reason);
                  void alert(reason);
                }
              }}
            >
              {t("detail.settings.proxyClearBtn")}
            </Button>
          </div>
        </div>
        <div className="field">
          <label>{t("detail.settings.scrcpyArgs")}</label>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
            {(
              [
                [t("detail.settings.presetLowData"), "--max-size 720 --video-bit-rate 2M"],
                [t("detail.settings.presetDefault"), "--max-size 1080 --video-bit-rate 8M"],
                [t("detail.settings.presetHd"), "--max-size 1080 --video-bit-rate 16M"],
                [t("detail.settings.presetBorderless"), "--max-size 1080 --video-bit-rate 8M --window-borderless"],
              ] as const
            ).map(([name, args]) => (
              <Button
                key={name}
                size="sm"
                variant={scrcpyArgs === args ? "primary" : "ghost"}
                onClick={() => setScrcpyArgs(args)}
              >
                {name}
              </Button>
            ))}
          </div>
          <input value={scrcpyArgs} onChange={(e) => setScrcpyArgs(e.target.value)} />
          <Button
            size="sm"
            style={{ marginTop: 8 }}
            onClick={async () => {
              setStatusText(t("detail.settings.startingScrcpy"));
              const sizeHit = scrcpyArgs.match(/--max-size[=\s]+(\d+)/);
              const rateHit = scrcpyArgs.match(/--video-bit-rate[=\s]+(\d+)/);
              const r = await DeviceService.scrcpyStart(
                serial,
                Number(sizeHit?.[1]) || 1080,
                Number(rateHit?.[1]) || 8,
                scrcpyArgs,
              );
              if (r.success) setStatusText(t("detail.settings.scrcpyStarted"));
              else {
                const reason = (r.stderr || r.stdout || t("detail.control.scrcpyStartFailed")).trim();
                setStatusText(reason);
                void alert(reason);
              }
            }}
          >
            {t("detail.settings.startScrcpyBtn")}
          </Button>
        </div>
        <div className="field">
          <label>{t("detail.settings.container")}</label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {t("detail.settings.containerHint")}
          </div>
          <Button
            size="sm"
            onClick={() => {
              try {
                sessionStorage.setItem(
                  "rdc.docker.instQuery",
                  deviceId.replace(/^rdc-/, "") || serial,
                );
              } catch {
                /* ignore */
              }
              navigate("/docker");
            }}
          >
            {t("detail.settings.openInstance")}
          </Button>
        </div>
        <div className="field">
          <label>{t("detail.settings.autoStart")}</label>
          <label className="row">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => {
                const on = e.target.checked;
                setAutoStart(on);
                if (!settings) return;
                const ids = new Set(settings.autoStartDeviceIds ?? []);
                if (on) ids.add(deviceId);
                else ids.delete(deviceId);
                void saveSettings({ ...settings, autoStartDeviceIds: [...ids] }).catch((err) =>
                  void alert(String(err)),
                );
              }}
            />
            {t("detail.settings.autoStartHint")}
          </label>
        </div>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <Button
          variant="primary"
          disabled={!validResolution(resolution) || !validDpi(dpi)}
          onClick={async () => {
            if (!validResolution(resolution) || !validDpi(dpi)) {
              setStatusText(t("detail.settings.invalidResDpi"));
              return;
            }
            setStatusText(t("detail.settings.applyingRes"));
            const r1 = await DeviceService.setResolution(serial, resolution);
            if (!r1.success) {
              const reason = (r1.stderr || r1.stdout || t("detail.settings.resApplyFailed")).trim();
              setStatusText(reason);
              void alert(reason);
              return;
            }
            const r2 = await DeviceService.setDpi(serial, dpi);
            if (!r2.success) {
              const reason = (r2.stderr || r2.stdout || t("detail.settings.dpiApplyFailed")).trim();
              setStatusText(reason);
              void alert(reason);
              return;
            }
            setStatusText(t("detail.settings.applied", { res: resolution, dpi }));
            onApplied?.();
          }}
        >
          {t("detail.settings.applyResBtn")}
        </Button>
        <Button
          onClick={async () => {
            setStatusText(t("detail.settings.resettingRes"));
            const r1 = await DeviceService.setResolution(serial, "reset");
            const r2 = await DeviceService.setDpi(serial, "reset");
            if (!r1.success || !r2.success) {
              const reason = (r1.stderr || r2.stderr || r1.stdout || r2.stdout || t("detail.settings.resetFailed")).trim();
              setStatusText(reason);
              void alert(reason);
              return;
            }
            setStatusText(t("detail.settings.resetDone"));
            onApplied?.();
          }}
        >
          {t("detail.settings.resetBtn")}
        </Button>
        <Button
          onClick={async () => {
            if (!lang.trim()) {
              setStatusText(t("detail.settings.langEmpty"));
              return;
            }
            setStatusText(t("detail.settings.settingLang", { lang }));
            const r = await DeviceService.setLanguage(serial, lang);
            if (!r.success) {
              const reason = (r.stderr || r.stdout || t("detail.settings.langFailed")).trim();
              setStatusText(reason);
              void alert(reason);
              return;
            }
            setStatusText(t("detail.settings.langSet", { lang }));
            onApplied?.();
            if (await askConfirm(t("detail.settings.langConfirm"))) {
              setStatusText(t("detail.settings.rebooting"));
              const reboot = await DeviceService.restart(deviceId);
              setStatusText(reboot.success ? t("detail.status.restartSent") : reboot.stderr || reboot.stdout || t("detail.status.restartFailed"));
              if (!reboot.success) void alert(reboot.stderr || reboot.stdout || t("detail.status.restartFailed"));
            }
          }}
        >
          {t("detail.settings.applyLangBtn")}
        </Button>
      </div>
    </Card>
    </fieldset>
  );
}
