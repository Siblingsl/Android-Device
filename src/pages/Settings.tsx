import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink, FolderOpen, Keyboard, RotateCcw, Save } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DeviceService } from "../services/deviceService";
import { useToolProbe } from "../hooks/useToolProbe";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import { normalizeMonitorPreferences } from "../lib/monitorPreferences";
import {
  GLOBAL_SHORTCUT_STATUS_CHANGED_EVENT,
  GLOBAL_SHORTCUTS_CHANGED_EVENT,
  notifyGlobalShortcutsChanged,
  readGlobalShortcutStatus,
  type GlobalShortcutStatus,
} from "../lib/globalShortcuts";
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  persistGlobalShortcutsEnabled,
  persistShortcuts,
  readGlobalShortcutsEnabled,
  readShortcuts,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutBindings,
} from "../lib/shortcuts";
import type { AppSettings } from "../types";

const PATH_FIELDS = [
  { key: "logPath", label: "settings.path.logPath", kind: "dir" as const },
  { key: "screenshotPath", label: "settings.path.screenshotPath", kind: "dir" as const },
  { key: "apkPath", label: "settings.path.apkPath", kind: "dir" as const },
  { key: "dockerPath", label: "settings.path.dockerPath", kind: "exe" as const },
  { key: "adbPath", label: "settings.path.adbPath", kind: "exe" as const },
  { key: "scrcpyPath", label: "settings.path.scrcpyPath", kind: "exe" as const },
  { key: "gappsZipPath", label: "settings.path.gappsZipPath", kind: "zip" as const },
] as const;

const SHORTCUT_ROWS: Array<{ action: ShortcutAction; label: string; hint: string }> = [
  { action: "openDashboard", label: "settings.shortcuts.action.openDashboard", hint: "settings.shortcuts.hint.openDashboard" },
  { action: "openDevices", label: "settings.shortcuts.action.openDevices", hint: "settings.shortcuts.hint.openDevices" },
  { action: "openTerminal", label: "settings.shortcuts.action.openTerminal", hint: "settings.shortcuts.hint.openTerminal" },
  { action: "refreshWorkspace", label: "settings.shortcuts.action.refreshWorkspace", hint: "settings.shortcuts.hint.refreshWorkspace" },
  { action: "openSettings", label: "settings.shortcuts.action.openSettings", hint: "settings.shortcuts.hint.openSettings" },
];

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const setTheme = useAppStore((s) => s.setTheme);
  const devices = useAppStore((s) => s.devices);
  const navigate = useNavigate();
  const [form, setForm] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const dirty = Boolean(form && settings && JSON.stringify(form) !== JSON.stringify(settings));
  const { tools, busy: probing, probe, probeMany } = useToolProbe();
  const autoProbed = useRef(false);
  const [shortcuts, setShortcuts] = useState<ShortcutBindings>(() => readShortcuts());
  const [capturingShortcut, setCapturingShortcut] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const [globalShortcutsEnabled, setGlobalShortcutsEnabled] = useState(() => readGlobalShortcutsEnabled());
  const [globalShortcutStatus, setGlobalShortcutStatus] = useState<GlobalShortcutStatus | null>(() => readGlobalShortcutStatus());

  useEffect(() => {
    loadSettings();
    void getVersion()
      .then(setAppVersion)
      .catch(() => {
        /* web preview */
      });
  }, [loadSettings]);

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // HashRouter 不是 data router，useBlocker 会抛异常炸掉整页；
  // 用 hashchange 手动实现「未保存离开确认」。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirty) return;
    const onHash = () => {
      if (window.location.hash.startsWith("#/settings") || !dirtyRef.current) return;
      if (!confirm(t("settings.confirmLeave"))) {
        window.location.hash = "#/settings";
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [dirty]);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  useEffect(() => {
    if (!form || autoProbed.current) return;
    autoProbed.current = true;
    void probeMany([
      { kind: "docker", path: (form.dockerPath || "").trim() || "docker" },
      { kind: "adb", path: (form.adbPath || "").trim() || "adb" },
      { kind: "scrcpy", path: (form.scrcpyPath || "").trim() || "scrcpy" },
    ]);
  }, [form, probeMany]);

  useEffect(() => {
    const syncGlobalShortcuts = () => {
      setGlobalShortcutsEnabled(readGlobalShortcutsEnabled());
      setGlobalShortcutStatus(readGlobalShortcutStatus());
    };
    window.addEventListener(GLOBAL_SHORTCUTS_CHANGED_EVENT, syncGlobalShortcuts);
    window.addEventListener(GLOBAL_SHORTCUT_STATUS_CHANGED_EVENT, syncGlobalShortcuts);
    return () => {
      window.removeEventListener(GLOBAL_SHORTCUTS_CHANGED_EVENT, syncGlobalShortcuts);
      window.removeEventListener(GLOBAL_SHORTCUT_STATUS_CHANGED_EVENT, syncGlobalShortcuts);
    };
  }, []);

  if (!form) {
    return <div className="empty-state">{t("settings.loading")}</div>;
  }

  const monitorPreferences = normalizeMonitorPreferences(
    form.resourceAlertThreshold,
    form.deviceRefreshIntervalSecs,
  );

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm({ ...form, [key]: value });
  };

  const assignShortcut = (action: ShortcutAction, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = formatShortcut(event.nativeEvent);
    if (!shortcut) {
      setShortcutError(t("settings.shortcuts.invalid"));
      return;
    }
    const conflict = findShortcutConflict(shortcuts, shortcut, action);
    if (conflict) {
      setShortcutError(
        t("settings.shortcuts.conflict", {
          shortcut,
          action: t(`settings.shortcuts.action.${conflict}`),
        }),
      );
      return;
    }
    const next = { ...shortcuts, [action]: shortcut };
    setShortcuts(next);
    persistShortcuts(next);
    setCapturingShortcut(null);
    setShortcutError("");
    setStatusText(t("settings.shortcuts.saved"));
  };

  const resetShortcuts = () => {
    const next = { ...DEFAULT_SHORTCUTS };
    setShortcuts(next);
    persistShortcuts(next);
    setCapturingShortcut(null);
    setShortcutError("");
    setStatusText(t("settings.shortcuts.reset"));
  };

  const globalShortcutSummary = !globalShortcutsEnabled
    ? t("settings.shortcuts.systemDisabled")
    : globalShortcutStatus?.available === false
      ? t("settings.shortcuts.systemUnavailable")
      : globalShortcutStatus
        ? t("settings.shortcuts.systemSummary", {
            registered: globalShortcutStatus.registered.length,
            total: SHORTCUT_ACTIONS.length,
          })
        : t("settings.shortcuts.systemEnabled");

  const globalShortcutState = (action: ShortcutAction) => {
    if (!globalShortcutsEnabled) return "disabled";
    if (globalShortcutStatus?.registered.includes(action)) return "registered";
    return globalShortcutStatus?.failed[action] ?? "notRegistered";
  };

  const pathFor = (key: "dockerPath" | "adbPath" | "scrcpyPath") =>
    (form[key] ?? "").trim() || (key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : "scrcpy");

  const runProbe = (key: "dockerPath" | "adbPath" | "scrcpyPath") =>
    probe(key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : "scrcpy", pathFor(key));

  const runProbeAll = async () => {
    const r = await probeMany([
      { kind: "docker", path: pathFor("dockerPath") },
      { kind: "adb", path: pathFor("adbPath") },
      { kind: "scrcpy", path: pathFor("scrcpyPath") },
    ]);
    setStatusText(t("settings.probeResult", { ok: r.ok, total: r.total }));
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("settings.title")}</div>
          <div className="page-subtitle">{t("settings.subtitle")}</div>
        </div>
        {dirty && (
          <>
            <span className="muted" style={{ fontSize: 12 }}>{t("settings.unsaved")}</span>
            <Button size="sm" variant="ghost" onClick={() => settings && setForm(settings)}>
              {t("settings.discard")}
            </Button>
          </>
        )}
        <Button
          variant="primary"
          icon={<Save size={15} />}
          disabled={!dirty}
          onClick={async () => {
            const live = new Set(devices.map((d) => d.id));
            const monitor = normalizeMonitorPreferences(
              form.resourceAlertThreshold,
              form.deviceRefreshIntervalSecs,
            );
            const cleaned = {
              ...form,
              resourceAlertThreshold: monitor.alertThreshold,
              deviceRefreshIntervalSecs: monitor.refreshIntervalSecs,
              autoStartDeviceIds: (form.autoStartDeviceIds ?? []).filter((id) => live.has(id)),
            };
            setForm(cleaned);
            try {
              await saveSettings(cleaned);
              setTheme(form.theme === "dark" ? "dark" : "light");
              setStatusText(t("settings.saved"));
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              setStatusText(t("settings.saveFailed", { err }));
              void alert(t("settings.saveFailed", { err }));
            }
          }}
        >
          {t("common.save")}
        </Button>
      </div>

      <div className="grid-2">
        <Card title={t("settings.card.appearance")}>
          <div className="form-grid">
            <div className="field">
              <label>{t("settings.theme")}</label>
              <select value={form.theme} onChange={(e) => set("theme", e.target.value)}>
                <option value="light">{t("settings.theme.light")}</option>
                <option value="dark">{t("settings.theme.dark")}</option>
              </select>
            </div>
            <div className="field">
              <label>{t("common.language")}</label>
              <select
                value={lang}
                onChange={(e) => {
                  setLang(e.target.value as "zh-CN" | "en-US");
                  set("language", e.target.value);
                }}
              >
                <option value="zh-CN">{t("common.lang.zh")}</option>
                <option value="en-US">{t("common.lang.en")}</option>
              </select>
            </div>
            <div className="field">
              <label>{t("settings.autoUpdate")}</label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.autoUpdate}
                  onChange={(e) => set("autoUpdate", e.target.checked)}
                />
                {t("settings.enabled")}
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {t("settings.autoUpdateHint")}
              </div>
            </div>
            <div className="field">
              <label>{t("settings.proxy")}</label>
              <input value={form.proxy} onChange={(e) => set("proxy", e.target.value)} placeholder="http://127.0.0.1:7890" />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {form.proxy.trim()
                  ? /^https?:\/\/\S+$/i.test(form.proxy.trim())
                    ? t("settings.proxy.valid")
                    : t("settings.proxy.invalid")
                  : t("settings.proxy.empty")}
              </div>
            </div>
            <div className="field">
              <label>{t("settings.gappsOnCreate")}</label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.installGapps !== false}
                  onChange={(e) => set("installGapps", e.target.checked)}
                />
                {t("settings.defaultChecked")}
              </label>
            </div>
          </div>
        </Card>

        <Card
          title={t("settings.card.paths")}
          action={
            <Button size="sm" loading={probing === "all"} onClick={() => void runProbeAll()}>
              {t("settings.probeAll")}
            </Button>
          }
        >
          <div className="stack">
            {PATH_FIELDS.map(({ key, label, kind }) => {
              const value = form[key] ?? "";
              const toolKind =
                key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : "scrcpy";
              const hit = kind === "exe" ? tools[toolKind] : undefined;
              return (
                <div className="field" key={key}>
                  <label>{t(label)}</label>
                  <div className="row">
                    <input
                      style={{ flex: 1 }}
                      value={value}
                      onChange={(e) => set(key, e.target.value)}
                      placeholder={kind === "zip" ? t("settings.zipPlaceholder") : undefined}
                    />
                    <Button
                      size="sm"
                      icon={<FolderOpen size={13} />}
                      onClick={async () => {
                        try {
                          const picked = await open({
                            multiple: false,
                            directory: kind === "dir",
                            filters:
                              kind === "zip"
                                ? [{ name: "GApps", extensions: ["zip"] }]
                                : kind === "exe"
                                  ? [{ name: t("settings.filterExe"), extensions: ["exe"] }]
                                  : undefined,
                          });
                          if (typeof picked === "string" && picked) set(key, picked);
                        } catch {
                          /* cancelled */
                        }
                      }}
                    >
                      {t("settings.browse")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ExternalLink size={13} />}
                      disabled={!value.trim()}
                      onClick={() =>
                        void DeviceService.revealInFolder(value.trim()).catch((e) =>
                          void alert(String(e)),
                        )
                      }
                    >
                      {t("common.open")}
                    </Button>
                    {kind === "exe" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={probing === "all" || probing === toolKind}
                        onClick={() => void runProbe(key as "dockerPath" | "adbPath" | "scrcpyPath")}
                      >
                        {t("settings.probe")}
                      </Button>
                    )}
                  </div>
                  {hit && (
                    <div className={hit.ok ? "ok" : "bad"} style={{ fontSize: 12 }}>
                      {t(hit.ok ? "settings.probeOk" : "settings.probeBad")} · {hit.text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card
        title={t("settings.card.shortcuts")}
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            onClick={resetShortcuts}
            aria-label={t("settings.shortcuts.resetButton")}
          >
            {t("settings.shortcuts.resetButton")}
          </Button>
        }
        className="settings-shortcuts-card"
      >
        <div className="shortcut-system-controls">
          <label className="shortcut-enable">
            <input
              type="checkbox"
              checked={globalShortcutsEnabled}
              aria-label={t("settings.shortcuts.enableSystem")}
              onChange={(event) => {
                const enabled = event.target.checked;
                setGlobalShortcutsEnabled(enabled);
                persistGlobalShortcutsEnabled(enabled);
                notifyGlobalShortcutsChanged();
                setStatusText(t(enabled ? "settings.shortcuts.enabled" : "settings.shortcuts.disabled"));
              }}
            />
            {t("settings.shortcuts.enableSystem")}
          </label>
          <span className="shortcut-system-summary">{globalShortcutSummary}</span>
        </div>
        <div className="settings-shortcuts-intro">
          <Keyboard size={17} aria-hidden="true" />
          <span>{t("settings.shortcuts.intro")}</span>
        </div>
        <div className="shortcut-list">
          {SHORTCUT_ROWS.map(({ action, label, hint }) => {
            const active = capturingShortcut === action;
            return (
              <div className="shortcut-row" key={action}>
                <div className="shortcut-copy">
                  <div className="shortcut-label">{t(label)}</div>
                  <div className="muted">{t(hint)}</div>
                </div>
                <div className="shortcut-row-actions">
                  <span className={`shortcut-status ${globalShortcutState(action)}`}>
                    {t(`settings.shortcuts.status.${globalShortcutState(action)}`)}
                  </span>
                  <button
                    type="button"
                    className={`shortcut-capture${active ? " active" : ""}`}
                    aria-label={t("settings.shortcuts.capture", { action: t(label) })}
                    onClick={() => {
                      setCapturingShortcut(action);
                      setShortcutError("");
                    }}
                    onKeyDown={(event) => {
                      if (active) assignShortcut(action, event);
                    }}
                  >
                    {active ? t("settings.shortcuts.press") : shortcuts[action]}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {shortcutError && <div className="shortcut-error" role="alert">{shortcutError}</div>}
        <div className="muted shortcut-footnote">{t("settings.shortcuts.scope")}</div>
      </Card>

      <Card title={t("settings.card.monitor")} className="settings-monitor-card">
        <div className="form-grid">
          <div className="field">
            <label>{t("settings.resourceAlertThreshold")}</label>
            <div className="row">
              <input
                type="number"
                min={50}
                max={100}
                step={1}
                value={monitorPreferences.alertThreshold}
                onChange={(e) => set("resourceAlertThreshold", Number(e.target.value))}
                onBlur={() => set("resourceAlertThreshold", monitorPreferences.alertThreshold)}
              />
              <span className="muted">%</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t("settings.resourceAlertThresholdHint")}
            </div>
          </div>
          <div className="field">
            <label>{t("settings.deviceRefreshInterval")}</label>
            <div className="row">
              <input
                type="number"
                min={5}
                max={60}
                step={1}
                value={monitorPreferences.refreshIntervalSecs}
                onChange={(e) => set("deviceRefreshIntervalSecs", Number(e.target.value))}
                onBlur={() => set("deviceRefreshIntervalSecs", monitorPreferences.refreshIntervalSecs)}
              />
              <span className="muted">{t("settings.seconds")}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t("settings.deviceRefreshIntervalHint")}
            </div>
          </div>
        </div>
      </Card>

      <Card title={t("settings.card.autoStart")}>
        <label className="row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={!!form.createAutoStart}
            onChange={(e) => set("createAutoStart", e.target.checked)}
          />
          {t("settings.createAutoStart")}
        </label>
        <label className="row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={!!form.createStayOnForm}
            onChange={(e) => set("createStayOnForm", e.target.checked)}
          />
          {t("settings.createStayOnForm")}
        </label>
        <label className="row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={form.createWaitAdb !== false}
            onChange={(e) => set("createWaitAdb", e.target.checked)}
          />
          {t("settings.createWaitAdb")}
        </label>
        {(form.autoStartDeviceIds ?? []).length === 0 ? (
          <div className="empty-state">
            {t("settings.noAutoStart")}
            <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/devices")}>
              {t("settings.goDevices")}
            </Button>
          </div>
        ) : (
          <div className="stack">
            {(form.autoStartDeviceIds ?? []).map((id) => {
              const d = devices.find((x) => x.id === id);
              return (
                <div key={id} className="row-between">
                  <div>
                    <div style={{ fontWeight: 600 }}>{d?.name || id}</div>
                    <div
                      className={d ? "muted mono" : "bad mono"}
                      style={{ fontSize: 12 }}
                    >
                      {d ? d.serial : t("settings.stale")}
                    </div>
                  </div>
                  <div className="row">
                    {d && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/devices/${encodeURIComponent(d.id)}`)}
                      >
                        {t("common.open")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() =>
                        set(
                          "autoStartDeviceIds",
                          (form.autoStartDeviceIds ?? []).filter((x) => x !== id),
                        )
                      }
                    >
                      {t("settings.remove")}
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="row" style={{ marginTop: 4 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const live = new Set(devices.map((d) => d.id));
                  const next = (form.autoStartDeviceIds ?? []).filter((id) => live.has(id));
                  set("autoStartDeviceIds", next);
                  setStatusText(
                    next.length === (form.autoStartDeviceIds ?? []).length
                      ? t("settings.noStale")
                      : t("settings.cleaned", {
                          n: (form.autoStartDeviceIds ?? []).length - next.length,
                        }),
                  );
                }}
              >
                {t("settings.cleanStale")}
              </Button>
              <span className="muted" style={{ fontSize: 12 }}>
                {t("settings.autoStartHint")}
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card title={t("settings.card.about")} className="about-card">
        <div className="stack">
          <div>
            <strong>Redroid Device Center</strong>
          </div>
          <div className="muted">{t("settings.version", { v: appVersion })}</div>
          <div className="muted">
            {t("settings.aboutDesc")}
          </div>
          <div className="muted">{t("settings.stack")}</div>
          <div className="muted">{t("settings.license")}</div>
        </div>
      </Card>

    </div>
  );
}
