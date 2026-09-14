import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink, FolderOpen, Save } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DeviceService } from "../services/deviceService";
import { useToolProbe } from "../hooks/useToolProbe";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { AppSettings } from "../types";
import { ShortcutEditor } from "../components/settings/ShortcutEditor";
import { ConfigTransfer } from "../components/settings/ConfigTransfer";
import { UpdatePanel } from "../components/settings/UpdatePanel";
import { SchedulerPanel } from "../components/settings/SchedulerPanel";
import { askConfirm } from "../lib/dialogs";
import { getAllDeviceMetadata, removeDeviceMetadata } from "../lib/deviceMetadata";

const PATH_FIELDS = [
  { key: "logPath", label: "settings.path.logPath", kind: "dir" as const },
  { key: "screenshotPath", label: "settings.path.screenshotPath", kind: "dir" as const },
  { key: "apkPath", label: "settings.path.apkPath", kind: "dir" as const },
  { key: "dockerPath", label: "settings.path.dockerPath", kind: "exe" as const },
  { key: "adbPath", label: "settings.path.adbPath", kind: "exe" as const },
  { key: "scrcpyPath", label: "settings.path.scrcpyPath", kind: "exe" as const },
  { key: "recordingPath", label: "settings.path.recordingPath", kind: "dir" as const },
  { key: "gnirehtetPath", label: "settings.path.gnirehtetPath", kind: "exe" as const },
  // tun2socks is a Linux binary consumed *inside* the container — never an
  // .exe filter on Windows hosts.
  { key: "tun2socksPath", label: "settings.path.tun2socksPath", kind: "bin" as const },
  { key: "gappsZipPath", label: "settings.path.gappsZipPath", kind: "zip" as const },
] as const;

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
  const [metadataRevision, setMetadataRevision] = useState(0);
  const dirty = Boolean(form && settings && JSON.stringify(form) !== JSON.stringify(settings));
  const { tools, busy: probing, probe, probeMany } = useToolProbe();
  const autoProbed = useRef(false);
  const isWindowsHost = typeof navigator === "undefined" || /Windows/i.test(navigator.userAgent);

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
      { kind: "gnirehtet", path: (form.gnirehtetPath || "").trim() || "gnirehtet" },
    ]);
  }, [form, probeMany]);

  const staleMetadata = useMemo(() => {
    const liveIds = new Set(devices.map((device) => device.id));
    return Object.entries(getAllDeviceMetadata()).filter(([id]) => !liveIds.has(id));
  }, [devices, metadataRevision]);

  if (!form) {
    return <div className="empty-state">{t("settings.loading")}</div>;
  }

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm({ ...form, [key]: value });
  };

  const pathFor = (key: "dockerPath" | "adbPath" | "scrcpyPath" | "gnirehtetPath") =>
    (form[key] ?? "").trim() || (key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : key === "scrcpyPath" ? "scrcpy" : "gnirehtet");

  const runProbe = (key: "dockerPath" | "adbPath" | "scrcpyPath" | "gnirehtetPath") =>
    probe(key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : key === "scrcpyPath" ? "scrcpy" : "gnirehtet", pathFor(key));

  const runProbeAll = async () => {
    const r = await probeMany([
      { kind: "docker", path: pathFor("dockerPath") },
      { kind: "adb", path: pathFor("adbPath") },
      { kind: "scrcpy", path: pathFor("scrcpyPath") },
      { kind: "gnirehtet", path: pathFor("gnirehtetPath") },
    ]);
    setStatusText(t("settings.probeResult", { ok: r.ok, total: r.total }));
  };

  const removeStaleMetadata = (id: string) => {
    if (!removeDeviceMetadata(id)) {
      setStatusText(t("settings.staleMetadataFailed"));
      return;
    }
    setMetadataRevision((value) => value + 1);
    setStatusText(t("settings.staleMetadataRemoved", { n: 1 }));
  };

  const removeAllStaleMetadata = async () => {
    if (!staleMetadata.length || !(await askConfirm(t("settings.staleMetadataConfirm", { n: staleMetadata.length })))) return;
    const removed = staleMetadata.reduce((count, [id]) => count + (removeDeviceMetadata(id) ? 1 : 0), 0);
    setMetadataRevision((value) => value + 1);
    setStatusText(removed === staleMetadata.length ? t("settings.staleMetadataRemoved", { n: removed }) : t("settings.staleMetadataFailed"));
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
            try {
              // Keep saved device IDs even while Docker/ADB is temporarily
              // unavailable. Stale entries are shown explicitly below and
              // can only be removed by the user's remove action.
              await saveSettings(form);
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
              <label>{t("settings.batteryAutoRefresh")}</label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.batteryAutoRefresh !== false}
                  onChange={(e) => set("batteryAutoRefresh", e.target.checked)}
                />
                {t("settings.enabled")}
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {t("settings.batteryAutoRefreshHint")}
              </div>
            </div>
            <div className="field">
              <label>更新通道</label>
              <select value={form.updateChannel || "stable"} onChange={(e) => set("updateChannel", e.target.value as "stable" | "beta")}>
                <option value="stable">稳定版</option>
                <option value="beta">测试版</option>
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>更新检查会把此通道传给发布服务；正式发布前需配置更新端点和签名公钥。</div>
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
            <div className="field">
              <label>窗口与启动</label>
              <label className="row"><input type="checkbox" checked={!!form.closeToTray} onChange={(e) => set("closeToTray", e.target.checked)} />关闭窗口时隐藏到托盘</label>
              <label className="row"><input type="checkbox" checked={!!form.launchAtLogin} onChange={(e) => set("launchAtLogin", e.target.checked)} />登录系统时启动</label>
              <label className="row"><input type="checkbox" checked={!!form.edgeHide} onChange={(e) => set("edgeHide", e.target.checked)} />窗口贴边时自动隐藏</label>
              <label className="row"><input type="checkbox" checked={!!form.desktopShortcut} onChange={(e) => set("desktopShortcut", e.target.checked)} />创建桌面快捷方式</label>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>登录启动和桌面快捷方式在保存设置后生效；托盘菜单仍可恢复主窗口。</div>
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
                key === "dockerPath" ? "docker" : key === "adbPath" ? "adb" : key === "scrcpyPath" ? "scrcpy" : key === "gnirehtetPath" ? "gnirehtet" : undefined;
              const hit = kind === "exe" && toolKind ? tools[toolKind] : undefined;
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
                                : kind === "exe" && isWindowsHost
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
                        onClick={() => void runProbe(key as "dockerPath" | "adbPath" | "scrcpyPath" | "gnirehtetPath")}
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

      <Card className="auto-start-card" title={t("settings.card.autoStart")}>
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
              const d = devices.find((x) => x.id === id || x.serial === id || x.containerId === id);
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

      <Card
        className="stale-metadata-card"
        title={t("settings.card.staleMetadata")}
        action={staleMetadata.length > 0 ? <Button size="sm" variant="danger" onClick={() => void removeAllStaleMetadata()}>{t("settings.staleMetadataClearAll")}</Button> : undefined}
      >
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{t("settings.staleMetadataHint")}</div>
        {staleMetadata.length === 0 ? <div className="empty-state">{t("settings.staleMetadataEmpty")}</div> : (
          <div className="stack">
            {staleMetadata.map(([id, metadata]) => (
              <div key={id} className="row-between">
                <div>
                  <strong>{metadata.remark || id}</strong>
                  <div className="muted mono" style={{ fontSize: 12 }}>{id}{metadata.group ? ` · ${metadata.group}` : ""}</div>
                </div>
                <Button size="sm" variant="danger" onClick={() => removeStaleMetadata(id)}>{t("settings.staleMetadataRemove")}</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ShortcutEditor devices={devices} setStatusText={setStatusText} />

      <ConfigTransfer
        settings={form}
        setStatusText={setStatusText}
        onImported={async (next) => {
          await saveSettings(next);
          setForm(next);
          setTheme(next.theme === "dark" ? "dark" : "light");
          setMetadataRevision((value) => value + 1);
        }}
      />

      <UpdatePanel settings={form} currentVersion={appVersion} setStatusText={setStatusText} onSettingsChange={(patch) => setForm((current) => current ? { ...current, ...patch } : current)} />

      <SchedulerPanel devices={devices} setStatusText={setStatusText} />

      <Card title={t("settings.card.about")} className="about-card">
        <div className="stack">
          <div>
            <strong>Just Run</strong>
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
