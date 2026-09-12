import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../lib/dialogs";
import { useNavigate, useParams } from "react-router-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  RefreshCw,
  Keyboard,
  Clipboard,
  FolderPlus,
  Trash2,
  Upload,
  Download,
  Play,
  Square,
  Search,
  Star,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceStream } from "../components/device/DeviceStream";
import { DeviceControlBar } from "../components/device/DeviceControlBar";
import { FileExplorer } from "../components/device/FileExplorer";
import { InteractiveTerminal } from "../components/device/InteractiveTerminal";
import { RecordingPanel } from "../components/device/RecordingPanel";
import { ScrcpyPreferences } from "../components/device/ScrcpyPreferences";
import { GnirehtetPanel } from "../components/device/GnirehtetPanel";
import { DeviceMetadataPanel } from "../components/device/DeviceMetadataPanel";
import { KeyboardMappingPanel } from "../components/device/KeyboardMappingPanel";
import { AutomationPanel } from "../components/device/AutomationPanel";
import { AgentPanel } from "../components/device/AgentPanel";
import { DeviceService } from "../services/deviceService";
import { DPI_PRESETS, RES_PRESETS, validDpi, validResolution } from "../lib/displaySpec";
import { resolveStoredScrcpyArgs } from "../lib/scrcpyPreferences";
import { getDeviceMetadata } from "../lib/deviceMetadata";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type {
  AppInfo,
  DeviceInfo,
  FileEntry,
  LsposedScopeReport,
  RootStatus,
  ShellResult,
  SuPolicyEntry,
} from "../types";

type Tab = "overview" | "control" | "files" | "apps" | "logs" | "settings";

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
  const [connecting, setConnecting] = useState(false);
  const autoTried = useRef("");

  const load = async () => {
    setLoading(true);
    try {
      let d = await DeviceService.getDevice(deviceId);
      if (!d && deviceId.includes(":")) {
        const list = await DeviceService.listDevices();
        const hit = list.find((x) => x.serial === deviceId || x.id === deviceId);
        if (hit) d = await DeviceService.getDevice(hit.id);
      }
      setDevice(d);
      return d;
    } catch (e) {
      setStatusText(e instanceof Error ? t("detail.load.failedWith", { msg: e.message }) : t("detail.load.failed"));
      return null;
    } finally {
      setLoading(false);
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
  const online = device.online && device.adbStatus === "device";
  const detailTabs: Array<readonly [Tab, string, boolean]> = [
    ["overview", "detail.tab.overview", false],
    ["control", "detail.tab.control", true],
    ["files", "detail.tab.files", true],
    ["apps", "detail.tab.apps", true],
    ["logs", "detail.tab.logs", true],
    ["settings", "detail.tab.settings", true],
  ];
  const activeTabLabel = t(`detail.tab.${tab}`);
  const activeTabSummary = t(`detail.workspace.${tab}`);

  return (
    <div className="detail-shell">
      <div className="detail-context">
        <div className="detail-context-main">
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => navigate("/devices")}>
            {t("detail.back")}
          </Button>
          <div className="detail-context-identity">
            <div className="page-title">{device.name}</div>
            <div className="page-subtitle mono">{device.serial}</div>
          </div>
          <span className={`detail-context-state ${online ? "is-online" : ""}`}>
            <span className="detail-context-state-dot" />
            {online ? t("common.online") : t("common.offline")}
          </span>
        </div>
        <div className="detail-context-actions">
          {!online && device.containerId && (
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
          {!online && device.serial.includes(":") && (
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
          <Button icon={<RefreshCw size={15} />} onClick={() => void load()} disabled={connecting}>
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

      <nav className="detail-tabbar" aria-label={t("detail.tabNavigation")}>
        {detailTabs.map(([k, labelKey, needsOnline], index) => {
          const offlineTab = needsOnline && !online;
          const label = t(labelKey);
          return (
            <button
              key={k}
              className={`detail-tab ${tab === k ? "active" : ""}`}
              aria-current={tab === k ? "page" : undefined}
              title={offlineTab ? t("detail.title.needsAdb") : undefined}
              onClick={() => setTab(k)}
            >
              <span className="detail-tab-index">0{index + 1}</span>
              <span>{label}</span>
              {offlineTab && (
                <span className="detail-tab-status">
                  <span className="detail-tab-status-dot" />
                  {t("detail.tab.requiresOnline")}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <main className="detail-workspace">
        <div className="detail-workspace-head">
          <div>
            <div className="detail-workspace-title">{activeTabLabel}</div>
            <div className="detail-workspace-summary">{activeTabSummary}</div>
          </div>
          <div className="detail-workspace-actions">
            <span className={`detail-context-state ${online ? "is-online" : ""}`}>
              <span className="detail-context-state-dot" />
              {online ? t("detail.status.ready") : t("detail.tab.requiresOnline")}
            </span>
          </div>
        </div>
        <div className="detail-scroll-region">
          {!online && tab !== "overview" && (
            <div className="notice" style={{ marginBottom: 0 }}>
              {t("detail.notice.offline")}
            </div>
          )}
          {tab === "overview" && (
            <div className="detail-overview-workspace">
              <Overview device={device} onOpenTab={setTab} />
              <DeviceMetadataPanel device={device} />
              <RootPanel device={device} />
            </div>
          )}
          {tab === "control" && (
            <Control
              serial={serial}
              device={device}
              resolution={device.resolution}
              setStatusText={setStatusText}
              onOpenFiles={() => setTab("files")}
              onOpenApps={() => setTab("apps")}
              onOpenNetwork={() => document.querySelector<HTMLElement>(".gnirehtet-panel")?.scrollIntoView({ behavior: "smooth", block: "center" })}
              onOpenScrcpyConfig={() => {
                setTab("settings");
                window.setTimeout(() => document.querySelector<HTMLElement>(".scrcpy-preferences")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
              }}
              onOpenTerminal={() => {
                document.querySelector<HTMLElement>(".interactive-terminal")?.scrollIntoView({ behavior: "smooth", block: "center" });
                document.querySelector<HTMLInputElement>(".interactive-terminal-input input")?.focus();
              }}
              disabled={!online}
            />
          )}
          {tab === "files" && <FileExplorer serial={serial} setStatusText={setStatusText} disabled={!online} />}
          {tab === "apps" && <Apps serial={serial} setStatusText={setStatusText} disabled={!online} />}
          {tab === "logs" && <DeviceLogs serial={serial} disabled={!online} />}
          {tab === "settings" && (
            <DeviceSettings
              serial={serial}
              initialResolution={device.resolution}
              initialDpi={device.dpi}
              setStatusText={setStatusText}
              onApplied={() => void load()}
              deviceId={deviceId}
              disabled={!online}
            />
          )}
        </div>
      </main>
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
      className="detail-module"
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

function Control({
  serial,
  device,
  resolution,
  setStatusText,
  onOpenFiles,
  onOpenApps,
  onOpenNetwork,
  onOpenScrcpyConfig,
  onOpenTerminal,
  disabled = false,
}: {
  serial: string;
  device: DeviceInfo;
  resolution?: string;
  setStatusText: (s: string) => void;
  onOpenFiles?: () => void;
  onOpenApps?: () => void;
  onOpenNetwork?: () => void;
  onOpenScrcpyConfig?: () => void;
  onOpenTerminal?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [clipboard, setClipboard] = useState("");
  const [shellCmd, setShellCmd] = useState("");
  const [shellOut, setShellOut] = useState("");
  const [copiedOut, setCopiedOut] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("rdc.shell.history");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : [];
    } catch {
      return [];
    }
  });
  const [favorites, setFavorites] = useState<string[]>(() => {
    const fallback = [
      "getprop ro.build.version.release",
      "wm size",
      "pm list packages -3",
      "dumpsys activity activities | head -30",
    ];
    try {
      const raw = localStorage.getItem("rdc.shell.favorites");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length
        ? parsed
        : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("rdc.shell.favorites", JSON.stringify(favorites));
    } catch {
      /* ignore */
    }
  }, [favorites]);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.shell.history", JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }, [history]);

  const act = async (label: string, fn: () => Promise<ShellResult>) => {
    if (disabled) {
      setStatusText(t("detail.status.deviceOffline"));
      return;
    }
    setStatusText(label);
    try {
      const result = await fn();
      setStatusText(result.success ? t("detail.status.ready") : result.stderr || result.stdout || `${label} 失败`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    }
  };

  const runShell = async (cmd?: string) => {
    const c = (cmd ?? shellCmd).trim();
    if (!c) return;
    setStatusText(t("detail.control.runningShell"));
    try {
      const r = await DeviceService.shell(serial, c);
      setShellOut((r.stdout || r.stderr || "(empty)") + `\n[exit ${r.exitCode}]`);
      setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 30));
      setStatusText(r.success ? t("detail.status.ready") : r.stderr || r.stdout || "Shell 执行失败");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    }
  };

  const takeShot = async () => {
    setStatusText(t("detail.control.shooting"));
    const r = await DeviceService.screenshot(serial);
    if (r.success) {
      setStatusText(t("detail.control.shotSaved", { path: r.path }));
    } else {
      const reason = (r.error || t("detail.control.shotFailed")).trim();
      setStatusText(reason);
      void alert(reason);
    }
  };

  const installApkQuick = async () => {
    if (disabled) {
      setStatusText(t("detail.status.deviceOffline"));
      return;
    }
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "APK", extensions: ["apk"] }] });
    if (typeof picked !== "string" || !picked) return;
    const name = picked.split(/[\\\\/]/).pop() || picked;
    setStatusText(`正在安装 ${name}`);
    const result = await DeviceService.installApk(serial, picked, true);
    setStatusText(result.success ? `${name} 安装成功` : result.stderr || result.stdout || `${name} 安装失败`);
  };

  return (
    <div className="detail-control-workspace split-control">
      <div className="screen-area">
        <DeviceStream
          serial={serial}
          deviceId={device.id}
          resolution={resolution}
          disabled={disabled}
          setStatusText={setStatusText}
          onTakeScreenshot={() => void takeShot()}
        />

        <div className="screen-stats">
          <span className="badge">{t("detail.control.hint.click")}</span>
          <span className="badge">{t("detail.control.hint.drag")}</span>
          <span className="badge">{t("detail.control.hint.wheel")}</span>
          <span className="badge">{t("detail.control.hint.dblclick")}</span>
          <span className="badge">{t("detail.control.hint.right")}</span>
          <span className="badge">{t("detail.control.hint.middle")}</span>
        </div>
      </div>

      <div className="control-panel">
        <KeyboardMappingPanel device={device} setStatusText={setStatusText} />
        <AutomationPanel device={device} setStatusText={setStatusText} />
        <AgentPanel device={device} setStatusText={setStatusText} />
        <RecordingPanel serial={serial} online={!disabled} setStatusText={setStatusText} />
        <GnirehtetPanel serial={serial} online={!disabled} setStatusText={setStatusText} />
        <InteractiveTerminal serial={serial} online={!disabled} />
        <Card title={t("detail.control.panelTitle")} padding>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {t("detail.control.panelHint")}
          </div>
          <DeviceControlBar
            serial={serial}
            online={!disabled}
            setStatusText={setStatusText}
            onScreenshot={() => void takeShot()}
            onInstallApk={() => void installApkQuick()}
            onOpenApps={onOpenApps}
            onOpenNetwork={onOpenNetwork}
            onOpenScrcpyConfig={onOpenScrcpyConfig}
            onOpenFiles={onOpenFiles}
            onOpenTerminal={onOpenTerminal}
          />

          <div className="field" style={{ marginTop: 12 }}>
            <label>{t("detail.control.inputText")}</label>
            <div className="row">
              <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("detail.control.inputPlaceholder")} />
              <Button disabled={disabled} icon={<Keyboard size={14} />} onClick={() => act(t("detail.control.inputText"), () => DeviceService.text(serial, text))}>
                {t("detail.control.send")}
              </Button>
            </div>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label>{t("detail.control.sendClipboard")}</label>
            <div className="row">
              <input style={{ flex: 1 }} value={clipboard} onChange={(e) => setClipboard(e.target.value)} />
              <Button disabled={disabled} icon={<Clipboard size={14} />} onClick={() => act(t("detail.control.clipboard"), () => DeviceService.sendClipboard(serial, clipboard))}>
                {t("detail.control.send")}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="一次性 ADB Shell">
          <div className="field">
            <label>{t("detail.control.command")}</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                aria-label="ADB Shell 命令"
                data-testid="shell-command-input"
                className="mono shell-command-input"
                value={shellCmd}
                onChange={(e) => setShellCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runShell()}
                placeholder="shell command..."
              />
              <Button variant="primary" disabled={disabled} onClick={() => runShell()}>
                {t("detail.control.run")}
              </Button>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {t("detail.control.favorites")}
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {favorites.map((f) => (
                <span key={f} className="row" style={{ gap: 0 }}>
                  <Button size="sm" variant="ghost" title={f} onClick={() => { setShellCmd(f); void runShell(f); }}>
                    {f.length > 28 ? f.slice(0, 28) + "…" : f}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t("detail.control.removeFavorite")}
                    onClick={() => setFavorites((x) => x.filter((c) => c !== f))}
                  >
                    ×
                  </Button>
                </span>
              ))}
              <Button
                size="sm"
                variant="secondary"
                disabled={!shellCmd.trim()}
                onClick={() => {
                  const cmd = shellCmd.trim();
                  setFavorites((x) =>
                    x.includes(cmd) ? x.filter((c) => c !== cmd) : [cmd, ...x].slice(0, 12),
                  );
                }}
              >
                {favorites.includes(shellCmd.trim()) ? t("detail.control.unfavorite") : t("detail.control.favorite")}
              </Button>
            </div>
          </div>
          {history.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t("detail.control.history")}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
                  {t("detail.control.clearHistory")}
                </Button>
              </div>
              <div className="stack">
                {history.slice(0, 5).map((h) => (
                  <button key={h} className="mono muted" style={{ textAlign: "left" }} onClick={() => setShellCmd(h)}>
                    {h}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="shell-output" style={{ marginTop: 12 }}>
            {shellOut || t("detail.control.outputPlaceholder")}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              disabled={!shellOut}
              onClick={() => {
                void navigator.clipboard.writeText(shellOut).then(
                  () => {
                    setCopiedOut(true);
                    window.setTimeout(() => setCopiedOut(false), 1500);
                  },
                  () => void alert(t("common.panel.copyFailed")),
                );
              }}
            >
              {copiedOut ? t("detail.control.copiedOutput") : t("detail.control.copyOutput")}
            </Button>
            <Button size="sm" variant="ghost" disabled={!shellOut} onClick={() => setShellOut("")}>
              {t("detail.control.clearOutput")}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function Files({
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
      setFiles(await DeviceService.listFilesResult(serial, p));
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
    <div className="detail-files-workspace stack">
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
          <div className="table-wrap detail-table-scroll">
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
          </div>
        )}
      </Card>
      </fieldset>
    </div>
  );
}

const appIconCache = new Map<string, string>();
const appIconFailures = new Set<string>();

function AppIcon({ serial, packageName, label }: { serial: string; packageName: string; label: string }) {
  const cacheKey = `${serial}\u0000${packageName}`;
  const [source, setSource] = useState(() => appIconCache.get(cacheKey) || "");
  const [visible, setVisible] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || source || appIconFailures.has(cacheKey)) return;
    let disposed = false;
    void DeviceService.getAppIcon(serial, packageName).then((icon) => {
      if (disposed || !icon) return;
      appIconCache.set(cacheKey, icon);
      setSource(icon);
    }).catch(() => {
      appIconFailures.add(cacheKey);
    });
    return () => { disposed = true; };
  }, [cacheKey, packageName, serial, source, visible]);

  return (
    <span ref={hostRef} className="app-list-icon" title={source ? label : `${label}（图标不可用）`} aria-hidden="true">
      {source ? <img src={source} alt="" loading="lazy" /> : <span>{label.trim().slice(0, 1).toUpperCase() || "?"}</span>}
    </span>
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
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(`rdc.apps.favorites.${serial}`) || "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(`rdc.apps.recent.${serial}`) || "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  });

  const load = async () => {
    setLoading(true);
    try {
      setApps(await DeviceService.listAppsResult(serial, includeSystem));
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

  useEffect(() => {
    try {
      localStorage.setItem(`rdc.apps.favorites.${serial}`, JSON.stringify(favorites));
      localStorage.setItem(`rdc.apps.recent.${serial}`, JSON.stringify(recent));
    } catch {
      /* optional persistence */
    }
  }, [serial, favorites, recent]);

  const noteRecent = (packageName: string) => setRecent((current) => [packageName, ...current.filter((item) => item !== packageName)].slice(0, 12));
  const launch = async (app: AppInfo) => {
    setAppBusy(`start:${app.packageName}`);
    setStatusText(t("detail.apps.starting", { pkg: app.packageName }));
    try {
      const result = await DeviceService.startApp(serial, app.packageName);
      if (result.success) {
        noteRecent(app.packageName);
        setStatusText(t("detail.apps.started", { pkg: app.packageName }));
      } else {
        setStatusText(result.stderr || result.stdout || t("detail.apps.startFailed"));
      }
    } finally {
      setAppBusy(null);
    }
  };

  const filtered = apps.filter(
    (a) =>
      a.packageName.toLowerCase().includes(keyword.toLowerCase()) ||
      a.label.toLowerCase().includes(keyword.toLowerCase())
  );

  return (
    <div className="detail-apps-workspace stack">
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
            <select
              className="app-launch-picker"
              defaultValue=""
              aria-label="快速启动应用"
              onChange={(event) => {
                const packageName = event.target.value;
                event.target.value = "";
                const app = apps.find((item) => item.packageName === packageName);
                if (app) void launch(app);
              }}
            >
              <option value="" disabled>快速启动应用</option>
              {favorites.length > 0 && <optgroup label="收藏">{favorites.map((pkg) => <option key={`fav-${pkg}`} value={pkg}>{apps.find((app) => app.packageName === pkg)?.label || pkg}</option>)}</optgroup>}
              {recent.length > 0 && <optgroup label="最近">{recent.map((pkg) => <option key={`recent-${pkg}`} value={pkg}>{apps.find((app) => app.packageName === pkg)?.label || pkg}</option>)}</optgroup>}
            </select>
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
                   if (r.success) {
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
          <div className="table-wrap detail-table-scroll">
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
                    <div className="app-name-line">
                      <AppIcon serial={serial} packageName={a.packageName} label={a.label} />
                      <div style={{ fontWeight: 600 }}>{a.label}</div>
                    </div>
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
                      <button
                        type="button"
                        className={`app-favorite ${favorites.includes(a.packageName) ? "active" : ""}`}
                        title={favorites.includes(a.packageName) ? "取消收藏" : "收藏应用"}
                        onClick={() => setFavorites((current) => current.includes(a.packageName) ? current.filter((item) => item !== a.packageName) : [a.packageName, ...current].slice(0, 30))}
                      >
                        <Star size={14} fill={favorites.includes(a.packageName) ? "currentColor" : "none"} />
                      </button>
                      <Button
                        size="sm"
                        icon={<Play size={13} />}
                        loading={appBusy === `start:${a.packageName}`}
                        disabled={appBusy !== null}
                        onClick={() => void launch(a)}
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
                             const d = await DeviceService.getAppDetailResult(serial, a.packageName);
                             const perm = await DeviceService.getAppPermissionsResult(serial, a.packageName);
                             const act = await DeviceService.getAppActivitiesResult(serial, a.packageName);
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
                          if (v === "activity") {
                            const activity = prompt("Activity 完整类名（可带前导 .）", "");
                            if (!activity) return;
                            setStatusText(`正在启动 ${a.packageName}/${activity}`);
                            const r = await DeviceService.startAppActivity(serial, a.packageName, activity);
                            setStatusText(r.success ? "Activity 已启动" : r.stderr || r.stdout || "Activity 启动失败");
                          }
                          if (v === "shortcut") {
                            try {
                              const shortcut = await DeviceService.createAppShortcut(serial, a.packageName);
                              setStatusText(`应用桌面快捷方式已创建：${shortcut}`);
                            } catch (error) {
                              setStatusText(`创建应用快捷方式失败：${error instanceof Error ? error.message : String(error)}`);
                            }
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
                         <option value="activity">启动指定 Activity</option>
                         <option value="shortcut">创建桌面快捷方式</option>
                         <option value="clear">{t("detail.apps.clearData")}</option>
                        <option value="uninstall">{t("detail.apps.uninstall")}</option>
                      </select>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
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
    <div className="detail-logs-workspace">
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
    </div>
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
  const [scrcpyArgs, setScrcpyArgs] = useState(
    draft.scrcpyArgs || resolveStoredScrcpyArgs(
      serial,
      getDeviceMetadata(deviceId).group,
      "--max-size 1080 --video-bit-rate 8M",
    ),
  );
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
    <div className="detail-settings-workspace">
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
        <ScrcpyPreferences
          serial={serial}
          initialArgs={scrcpyArgs}
          disabled={offline}
          onChange={setScrcpyArgs}
          setStatusText={setStatusText}
        />
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
    </div>
  );
}
