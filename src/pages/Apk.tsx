import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Package, Upload } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { askConfirm } from "../lib/dialogs";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DeviceService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { DeviceInfo } from "../types";

const PATH_KEY = "rdc.apk.path";
const REPLACE_KEY = "rdc.apk.replace";
const PICKED_KEY = "rdc.apk.picked";

function readSession(key: string, fallback = "") {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function adbOnline(d: DeviceInfo) {
  return d.online && d.adbStatus === "device";
}

export function ApkPage() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem(PICKED_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [apkPath, setApkPath] = useState(() => readSession(PATH_KEY));
  const [replace, setReplace] = useState(() => readSession(REPLACE_KEY, "1") !== "0");
  const [output, setOutput] = useState<{ id: string; name: string; ok: boolean; detail: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const setStatusText = useAppStore((s) => s.setStatusText);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const navigate = useNavigate();
  const { t } = useI18n();

  useEffect(() => {
    void DeviceService.listDevices()
      .then(setDevices)
      .catch((e) => {
        setStatusText(e instanceof Error ? t("apk.listFailedWith", { msg: e.message }) : t("apk.listFailed"));
      });
  }, [setStatusText]);

  useEffect(() => {
    try {
      sessionStorage.setItem(PATH_KEY, apkPath);
      sessionStorage.setItem(REPLACE_KEY, replace ? "1" : "0");
      sessionStorage.setItem(PICKED_KEY, JSON.stringify(selected));
    } catch {
      /* ignore */
    }
  }, [apkPath, replace, selected]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      devices.filter(
        (d) =>
          !q ||
          d.name.toLowerCase().includes(q) ||
          d.serial.toLowerCase().includes(q),
      ),
    [devices, q],
  );
  const onlineVisible = visible.filter(adbOnline);
  const allOnlineChecked =
    onlineVisible.length > 0 && onlineVisible.every((d) => selected.includes(d.id));

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const pickApk = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "APK", extensions: ["apk"] }],
        defaultPath: apkPath || settings?.apkPath || undefined,
      });
      if (typeof picked === "string" && picked) {
        setApkPath(picked);
        const dir = picked.replace(/[/\\][^/\\]+$/, "");
        if (settings && dir && dir !== picked) {
          void saveSettings({ ...settings, apkPath: dir }).catch(() => {
            /* ignore */
          });
        }
      }
    } catch {
      /* cancelled */
    }
  };

  const install = async () => {
    if (!apkPath || selected.length === 0) {
      setStatusText(t("apk.pickFirst"));
      return;
    }
    const targets = devices.filter((d) => selected.includes(d.id));
    const offline = targets.filter((d) => !adbOnline(d));
    if (offline.length) {
      if (
        !(await askConfirm(
          `${t("apk.confirmOffline", { n: offline.length, list: offline.map((d) => d.name).join("\n") })}`,
        ))
      ) {
        return;
      }
    }
    setBusy(true);
    setStatusText(t("apk.installing"));
    const lines: { id: string; name: string; ok: boolean; detail: string }[] = [];
    let okCount = 0;
    try {
      for (const d of targets) {
        setStatusText(t("apk.installingTo", { name: d.name }));
        const r = await DeviceService.installApk(d.serial, apkPath, replace);
        const ok = r.success || r.stdout.includes("Success");
        if (ok) okCount += 1;
        lines.push({
          id: d.id,
          name: d.name,
          ok,
          detail: (r.stdout || r.stderr || "").trim(),
        });
      }
      setOutput(lines);
      setStatusText(t("apk.installDone", { ok: okCount, total: targets.length }));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      lines.push({ id: "", name: t("apk.error"), ok: false, detail: err });
      setOutput(lines);
      setStatusText(err);
    } finally {
      setBusy(false);
    }
  };

  const copyOutput = async () => {
    if (!output.length) return;
    try {
      await navigator.clipboard.writeText(
        output.map((l) => `[${l.name}] ${l.ok ? t("devices.success") : t("devices.failed")} ${l.detail}`.trim()).join("\n"),
      );
      setStatusText(t("apk.copiedResult"));
    } catch {
      setStatusText(t("common.panel.copyFailed"));
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("apk.page.title")}</div>
          <div className="page-subtitle">{t("apk.page.subtitle")}</div>
        </div>
      </div>

      <div className="grid-2">
        <Card title={t("apk.installConfig")}>
          <div className="field">
            <label>{t("apk.apkPath")}</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                value={apkPath}
                onChange={(e) => setApkPath(e.target.value)}
                placeholder={settings?.apkPath || "C:\\path\\to\\app.apk"}
              />
              <Button icon={<Package size={14} />} onClick={() => void pickApk()}>
                {t("apk.browse")}
              </Button>
            </div>
          </div>
          <label className="row" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {t("apk.replaceInstall")}
          </label>
          <div className="row" style={{ marginTop: 16 }}>
            <Button
              variant="primary"
              icon={<Upload size={15} />}
              loading={busy}
              disabled={busy || !apkPath || selected.length === 0}
              onClick={() => void install()}
            >
              {t("apk.installToSelected")}{selected.length ? ` (${selected.length})` : ""}
            </Button>
          </div>
          {output.length > 0 && (
            <>
              <div className="row" style={{ marginTop: 14 }}>
                {output.some((l) => !l.ok && l.id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const ids = output.filter((l) => !l.ok && l.id).map((l) => l.id);
                      setSelected(ids);
                      setStatusText(t("devices.selectedFailed", { n: ids.length }));
                    }}
                  >
                    {t("devices.selectFailed")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void copyOutput()}>
                  {t("devices.copyResult")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOutput([])}>
                  {t("apk.clear")}
                </Button>
              </div>
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>{t("devices.table.device")}</th>
                    <th>{t("devices.table.result")}</th>
                    <th>{t("devices.table.detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {output.map((l, i) => (
                    <tr key={l.id || i}>
                      <td>
                        {l.id ? (
                          <button
                            type="button"
                            style={{
                              background: "none",
                              border: 0,
                              padding: 0,
                              color: "inherit",
                              cursor: "pointer",
                              textDecoration: "underline",
                            }}
                            onClick={() => navigate(`/devices/${encodeURIComponent(l.id)}`)}
                          >
                            {l.name}
                          </button>
                        ) : (
                          l.name
                        )}
                      </td>
                      <td className={l.ok ? "ok" : "bad"}>{l.ok ? t("devices.success") : t("devices.failed")}</td>
                      <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                        {l.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card
          title={t("apk.targetDevices")}
          action={
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                disabled={onlineVisible.length === 0}
                onClick={() => {
                  if (allOnlineChecked) {
                    const drop = new Set(onlineVisible.map((d) => d.id));
                    setSelected((s) => s.filter((id) => !drop.has(id)));
                  } else {
                    setSelected((s) => [...new Set([...s, ...onlineVisible.map((d) => d.id)])]);
                  }
                }}
              >
                {allOnlineChecked ? t("apk.unselectOnline") : t("apk.selectAllOnline")}
              </Button>
            </div>
          }
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("devices.search.placeholder")}
            style={{ height: 30, width: "100%", marginBottom: 10, padding: "0 10px", borderRadius: 8 }}
          />
          {devices.length === 0 ? (
            <div className="empty-state">
              {t("devices.empty.noDevices")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => navigate("/docker")}>
                {t("common.panel.goCreate")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              {t("apk.noMatch")}
              <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setQuery("")}>
                {t("apk.clearSearch")}
              </Button>
            </div>
          ) : (
            <div className="stack">
              {visible.map((d) => {
                const ready = adbOnline(d);
                return (
                  <label key={d.id} className="row" style={{ padding: "8px 4px", opacity: ready ? 1 : 0.65 }}>
                    <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{d.name}</div>
                      <div className="mono muted" style={{ fontSize: 12 }}>
                        {d.serial} · {ready ? t("devices.status.adbReady") : d.online ? `ADB ${d.adbStatus || "—"}` : t("common.offline")}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
