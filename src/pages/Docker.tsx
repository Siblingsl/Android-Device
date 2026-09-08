import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Play, Square, RefreshCw, Trash2, Shield, FolderOpen, Smartphone, Database } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { copyText } from "../lib/clipboard";
import { askConfirm } from "../lib/dialogs";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService } from "../services/deviceService";
import { probeTool } from "../hooks/useToolProbe";
import { DPI_PRESETS, RES_PRESETS, validDpi, validResolution } from "../lib/displaySpec";
import { ToolStatus } from "../components/ui/ToolStatus";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import type { CreateInstanceRequest, DockerContainer, DockerInfo, MagiskAssets, WslKernelStatus } from "../types";

function adbSerialFromPorts(ports?: string): string | null {
  const m = ports?.match(/:(\d+)->5555/);
  return m ? `127.0.0.1:${m[1]}` : null;
}



function volumeNameOf(containerName: string): string {
  const n = containerName.replace(/^\/?/, "");
  return n.endsWith("-data") ? n : `${n}-data`;
}

function readSession(key: string, fallback = "") {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function DockerPage() {
  const { t } = useI18n();
  const setStatusText = useAppStore((s) => s.setStatusText);
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const navigate = useNavigate();

  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [kernel, setKernel] = useState<WslKernelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyOut, setVerifyOut] = useState<string>("");
  const [instQuery, setInstQuery] = useState(() => readSession("rdc.docker.instQuery"));
  const [instFilter, setInstFilter] = useState<"all" | "up" | "exited">(() => {
    const v = readSession("rdc.docker.instFilter", "all");
    return v === "up" || v === "exited" ? v : "all";
  });
  const [imgQuery, setImgQuery] = useState(() => readSession("rdc.docker.imgQuery"));
  const [gappsExists, setGappsExists] = useState<boolean | null>(null);
  const [magiskAssets, setMagiskAssets] = useState<MagiskAssets | null>(null);
  const [hidePackagesText, setHidePackagesText] = useState("");
  const [spoofExists, setSpoofExists] = useState<boolean | null>(null);
  const hidePackageList = hidePackagesText
    .split(/[\n,;，；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalidPackages = hidePackageList.filter((p) => !/^[A-Za-z0-9._$]+$/.test(p));
  const [autoStartAfterCreate, setAutoStartAfterCreate] = useState(
    Boolean(settings?.createAutoStart),
  );
  const [nameTaken, setNameTaken] = useState(false);
  const [nameSuggestion, setNameSuggestion] = useState("");
  const [stayToCreate, setStayToCreate] = useState(Boolean(settings?.createStayOnForm));
  const [lastCreatedSerial, setLastCreatedSerial] = useState("");
  const [createdFlash, setCreatedFlash] = useState(false);
  const [failedSerial, setFailedSerial] = useState("");
  const [clonedName, setClonedName] = useState("");
  const [createStage, setCreateStage] = useState("");
  const [waitAdbPref, setWaitAdbPref] = useState(
    settings?.createWaitAdb !== false && readSession("rdc.docker.waitAdb", "1") !== "0",
  );
  const createFormRef = useRef<HTMLDivElement>(null);
  const [portTaken, setPortTaken] = useState(false);
  const [portSuggestion, setPortSuggestion] = useState<number | null>(null);

  const suggestName = async (base: string) => {
    const raw = base.trim() || "redroid";
    const stem = raw.replace(/-\d+$/, "");
    let n = 2;
    let candidate = `${stem}-${n}`;
    while (await DeviceService.checkInstanceName(candidate)) {
      n += 1;
      candidate = `${stem}-${n}`;
      if (n > 99) break;
    }
    return candidate;
  };

  const [tools, setTools] = useState<{
    docker: { ok: boolean; text: string };
    adb: { ok: boolean; text: string };
  } | null>(null);

  const openDevice = (serial: string) => {
    setSelected(serial);
    navigate(`/devices/${encodeURIComponent(serial)}`);
  };
  const [form, setForm] = useState<CreateInstanceRequest>({
    name: "redroid-1",
    androidVersion: "13.0.0-latest",
    cpu: settings?.lastCpu || "2",
    ram: settings?.lastRam || "2g",
    resolution: settings?.lastResolution || "1080x1920",
    dpi: settings?.lastDpi || "320",
    adbPort: 5555,
    scrcpyPort: 0,
    image: settings?.lastImage || "redroid/redroid:13.0.0-latest",
    installGapps: settings?.installGapps !== false,
    gappsZip: settings?.gappsZipPath || "",
    installMagisk: false,
    installLsposed: true,
    installShamiko: true,
    spoofProfile: "",
  });

  useEffect(() => {
    if (settings?.createAutoStart != null) setAutoStartAfterCreate(Boolean(settings.createAutoStart));
  }, [settings?.createAutoStart]);

  useEffect(() => {
    if (settings?.createStayOnForm != null) setStayToCreate(Boolean(settings.createStayOnForm));
  }, [settings?.createStayOnForm]);

  useEffect(() => {
    if (settings?.createWaitAdb != null) setWaitAdbPref(Boolean(settings.createWaitAdb));
  }, [settings?.createWaitAdb]);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.docker.instQuery", instQuery);
      sessionStorage.setItem("rdc.docker.instFilter", instFilter);
      sessionStorage.setItem("rdc.docker.imgQuery", imgQuery);
      sessionStorage.setItem("rdc.docker.waitAdb", waitAdbPref ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [instQuery, instFilter, imgQuery, waitAdbPref]);

  useEffect(() => {
    if (busy !== "create") return;
    const t = window.setInterval(() => {
      void DeviceService.getCreateStage()
        .then((s) => {
          if (s) {
            setCreateStage(s);
            setStatusText(s);
          }
        })
        .catch(() => {
          /* ignore */
        });
    }, 700);
    return () => window.clearInterval(t);
  }, [busy, setStatusText]);

  useEffect(() => {
    const name = form.name.trim();
    if (!name) {
      setNameTaken(false);
      setNameSuggestion("");
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void DeviceService.checkInstanceName(name).then(async (taken) => {
        if (cancelled) return;
        setNameTaken(taken);
        setNameSuggestion(taken ? await suggestName(name) : "");
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [form.name]);

  useEffect(() => {
    const port = Number(form.adbPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortTaken(false);
      setPortSuggestion(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void DeviceService.checkAdbPort(port).then(async (taken) => {
        if (cancelled) return;
        setPortTaken(taken);
        setPortSuggestion(taken ? await DeviceService.nextFreeAdbPort() : null);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [form.adbPort]);

  const probeTools = async () => {
    const [d, a] = await Promise.all([
      probeTool("docker", settings?.dockerPath),
      probeTool("adb", settings?.adbPath),
    ]);
    setTools({ docker: d, adb: a });
  };

  const load = async () => {
    setLoading(true);
    try {
      const [d, k] = await Promise.all([
        DeviceService.refreshDockerInfo(),
        DeviceService.getWslKernelStatus().catch(() => null),
      ]);
      setInfo(d);
      setKernel(k);
      void probeTools();
    } catch (e) {
      setStatusText(e instanceof Error ? t("docker.refreshFailedWith", { msg: e.message }) : t("docker.refreshFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const path = (form.gappsZip || settings?.gappsZipPath || "").trim();
    if (!form.installGapps) {
      setGappsExists(null);
      return;
    }
    if (!path) {
      setGappsExists(false);
      return;
    }
    let cancelled = false;
    void DeviceService.pathExists(path).then((ok) => {
      if (!cancelled) setGappsExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [form.installGapps, form.gappsZip, settings?.gappsZipPath]);

  useEffect(() => {
    const path = (form.spoofProfile || "").trim();
    if (!form.installMagisk || !path) {
      setSpoofExists(null);
      return;
    }
    let cancelled = false;
    void DeviceService.pathExists(path).then((ok) => {
      if (!cancelled) setSpoofExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [form.installMagisk, form.spoofProfile]);

  useEffect(() => {
    load();
    void DeviceService.getMagiskAssets()
      .then((a) => setMagiskAssets(a))
      .catch(() =>
        setMagiskAssets({
          magiskDir: "",
          magiskOk: false,
          lsposedOk: false,
          shamikoOk: false,
          message: t("docker.magiskProbeUnavailable"),
        }),
      );
    void DeviceService.getLocalGappsPath()
      .then((p) => {
        setForm((f) => ({
          ...f,
          cpu: settings?.lastCpu || f.cpu,
          ram: settings?.lastRam || f.ram,
          resolution: settings?.lastResolution || f.resolution,
          dpi: settings?.lastDpi || f.dpi,
          image: settings?.lastImage || f.image,
          androidVersion:
            (settings?.lastImage || f.image).replace(/^.*:/, "") || f.androidVersion,
          installGapps: settings?.installGapps !== false,
          gappsZip: f.gappsZip || settings?.gappsZipPath || p || "",
        }));
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const run = async (id: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(id);
    setStatusText(msg);
    try {
      const result = await fn();
      if (result && typeof result === "object" && "success" in result) {
        const r = result as { success?: boolean; stderr?: string; stdout?: string };
        if (!r.success) {
          throw new Error((r.stderr || r.stdout || t("docker.opFailed", { msg })).trim());
        }
      }
      await load();
      setStatusText(t("devices.status.ready"));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setStatusText(err);
      void alert(err);
    } finally {
      setBusy(null);
    }
  };

  const redroidsAll = info?.containers.filter((c) => c.isRedroid) ?? [];
  const instQ = instQuery.trim().toLowerCase();
  const isUp = (status: string) => status.toLowerCase().includes("up");
  const imgQ = imgQuery.trim().toLowerCase();
  const imagesFiltered = (info?.images ?? []).filter((img) => {
    if (!imgQ) return true;
    return (
      img.repository.toLowerCase().includes(imgQ) ||
      img.tag.toLowerCase().includes(imgQ) ||
      img.id.toLowerCase().includes(imgQ)
    );
  });
  const redroids = redroidsAll.filter((c) => {
    if (instFilter === "up" && !isUp(c.status)) return false;
    if (instFilter === "exited" && isUp(c.status)) return false;
    if (!instQ) return true;
    return (
      c.name.toLowerCase().includes(instQ) ||
      c.image.toLowerCase().includes(instQ) ||
      (c.ports || "").toLowerCase().includes(instQ)
    );
  });
  const kernelModeLabel =
    kernel?.mode === "custom"
      ? t("docker.kernel.modeCustom")
      : kernel?.mode === "default"
        ? t("docker.kernel.modeDefault")
        : kernel?.mode === "host"
          ? t("docker.kernel.modeHost")
          : t("docker.kernel.modeUnknown");
  const sizeMb = kernel?.customKernelSize ? (kernel.customKernelSize / 1024 / 1024).toFixed(1) : "—";
  const isWindowsWsl = kernel?.strategy === "wsl-prebuilt-or-build";
  const isLinuxHost = kernel?.strategy === "host-binder";

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("docker.title")}</div>
          <div className="page-subtitle">{t("docker.subtitle")}</div>
        </div>
        <div className="row">
          <Button icon={<RefreshCw size={15} />} onClick={load}>
            {t("common.refresh")}
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabled={tools !== null && !tools.docker.ok}
            title={tools && !tools.docker.ok ? t("docker.dockerUnavailable", { text: tools.docker.text }) : undefined}
            onClick={async () => {
              try {
                const port = await DeviceService.nextFreeAdbPort();
                const redroids = (info?.containers ?? []).filter((c) => c.isRedroid);
                let n = redroids.length + 1;
                let name = `redroid-${n}`;
                while (await DeviceService.checkInstanceName(name)) {
                  n += 1;
                  name = `redroid-${n}`;
                }
                setForm((f) => ({ ...f, name, adbPort: port }));
              } catch {
                /* keep defaults */
              }
              setShowCreate(true);
            }}
          >
            {t("docker.createInstance")}
          </Button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 16 }}>
        <ToolStatus kind="docker" hit={tools?.docker} />
        <ToolStatus kind="adb" hit={tools?.adb} />
      </div>

      <Card
        title={t("docker.kernelCard.title")}
        action={
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={load}>
            {t("docker.refreshStatus")}
          </Button>
        }
      >
        {loading && !kernel ? (
          <Skeleton height={80} />
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid-stats" style={{ margin: 0 }}>
              <div>
                <div className="muted">{t("docker.kernel.platform")}</div>
                <div className="mono" style={{ fontWeight: 700, fontSize: 14 }}>
                  {kernel?.platform || "—"}
                </div>
              </div>
              <div>
                <div className="muted">{t("docker.kernel.strategy")}</div>
                <div style={{ fontWeight: 650, fontSize: 13 }}>
                  {isWindowsWsl ? t("docker.kernel.strategyWsl") : isLinuxHost ? t("docker.kernel.strategyHost") : t("docker.kernel.unsupported")}
                </div>
              </div>
              <div>
                <div className="muted">{t("docker.kernel.currentMode")}</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{kernelModeLabel}</div>
              </div>
              <div>
                <div className="muted">{t("docker.kernel.liveKernel")}</div>
                <div className="mono" style={{ fontWeight: 650, fontSize: 13 }}>
                  {kernel?.liveKernelVersion || "—"}
                </div>
              </div>
              <div>
                <div className="muted">Binder</div>
                <div style={{ fontWeight: 700, fontSize: 16, color: kernel?.binderEnabled ? "var(--success, #16a34a)" : "var(--danger, #dc2626)" }}>
                  {kernel?.binderEnabled ? t("docker.enabled") : t("docker.disabled")}
                </div>
              </div>
              <div>
                <div className="muted">{isWindowsWsl ? t("docker.kernel.customImage") : t("docker.kernel.kernelImage")}</div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>
                  {isLinuxHost
                    ? t("docker.kernel.noBzImageNeeded")
                    : kernel?.customKernelExists
                      ? t("docker.kernel.ready", { size: sizeMb })
                      : t("docker.kernel.notInstalled")}
                </div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {kernel?.message || "—"}
            </div>
            {kernel?.releaseAssetBzImage ? (
              <div className="mono muted" style={{ fontSize: 11 }}>
                {t("docker.kernel.releaseAsset", { asset: kernel.releaseAssetBzImage })}
              </div>
            ) : null}
            {kernel?.configuredKernel ? (
              <div className="mono muted" style={{ fontSize: 11 }}>
                .wslconfig kernel={kernel.configuredKernel}
              </div>
            ) : null}
            {kernel?.dockerReadyHints?.length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                {kernel.dockerReadyHints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            ) : null}
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {isWindowsWsl && (
                <>
                  <Button
                    size="sm"
                    variant="success"
                    icon={<Shield size={13} />}
                    loading={busy === "custom"}
                    disabled={!kernel?.customKernelExists}
                    onClick={async () => {
                      if (!(await askConfirm(t("docker.kernel.confirmCustom")))) return;
                      void run(
                        "custom",
                        async () => {
                          const r = await DeviceService.switchWslKernel("custom", true);
                          if (!r.success) throw new Error(r.stderr || r.stdout || t("docker.switchFailed"));
                          void alert(t("docker.kernel.switchedCustom"));
                          return r;
                        },
                        t("docker.switchCustomKernel"),
                      );
                    }}
                  >
                    {t("docker.switchCustomKernel")}
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === "default"}
                    onClick={async () => {
                      if (!(await askConfirm(t("docker.kernel.confirmDefault")))) return;
                      void run(
                        "default",
                        async () => {
                          const r = await DeviceService.switchWslKernel("default", true);
                          if (!r.success) throw new Error(r.stderr || r.stdout || t("docker.switchFailed"));
                          void alert(t("docker.kernel.switchedDefault"));
                          return r;
                        },
                        t("docker.restoreDefaultKernel"),
                      );
                    }}
                  >
                    {t("docker.restoreDefaultKernel")}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                loading={busy === "verify"}
                onClick={() => {
                  void run(
                    "verify",
                    async () => {
                      const r = await DeviceService.verifyWslBinder();
                      setVerifyOut([r.stdout, r.stderr].filter(Boolean).join("\n"));
                      if (!r.success) throw new Error(r.stderr || r.stdout || t("docker.detectFailed"));
                      return r;
                    },
                    t("docker.probeBinder"),
                  );
                }}
              >
                {t("docker.probeBinder")}
              </Button>
            </div>
            {verifyOut ? (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 10,
                  fontSize: 11,
                  maxHeight: 180,
                  overflow: "auto",
                  borderRadius: 10,
                  background: "var(--bg-hover)",
                }}
              >
                {verifyOut}
              </pre>
            ) : null}
            <div className="muted" style={{ fontSize: 11 }}>
              {t("docker.kernel.hint")}
            </div>
          </div>
        )}
      </Card>

      <div className="grid-stats" style={{ marginTop: 16 }}>
        {loading && !info ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <Skeleton height={60} />
            </Card>
          ))
        ) : (
          <>
            <Card>
              <div className="muted">{t("docker.dockerStatus")}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{info?.running ? t("common.status.dockerRunning") : t("common.status.dockerOff")}</div>
            </Card>
            <Card>
              <div className="muted">{t("docker.version")}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{info?.version || "—"}</div>
            </Card>
            <Card>
              <div className="muted">CPU</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{(info?.cpuUsage ?? 0).toFixed(1)}%</div>
            </Card>
            <Card>
              <div className="muted">{t("common.panel.memory")}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{(info?.memoryUsage ?? 0).toFixed(1)}%</div>
            </Card>
          </>
        )}
      </div>

      {showCreate && (
        <div ref={createFormRef}>
        <Card title={t("docker.createForm.title")} action={<Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>{t("common.close")}</Button>}>
          {createStage && (
            <div
              className="notice"
              style={{
                marginBottom: 12,
                color: /未完成|失败/.test(createStage) ? "var(--danger)" : undefined,
              }}
            >
              {createStage}
              {busy !== "create" && /未完成|失败/.test(createStage) && (
                <>
                  {failedSerial && (
                    <Button
                      size="sm"
                      variant="ghost"
                      style={{ marginLeft: 8 }}
                      onClick={() => openDevice(failedSerial)}
                    >
                      {t("adb.openThis")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => setCreateStage("")}
                  >
                    {t("common.close")}
                  </Button>
                </>
              )}
            </div>
          )}
          {lastCreatedSerial && stayToCreate && (
            <div
              className="notice"
              style={{
                marginBottom: 12,
                outline: createdFlash ? "2px solid var(--success)" : undefined,
                transition: "outline .2s",
              }}
            >
              {createdFlash ? t("docker.justCreated") : t("docker.prevReady")}
              {lastCreatedSerial}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openDevice(lastCreatedSerial)}
                style={{ marginLeft: 8 }}
              >
                {t("devices.card.detail")}
              </Button>
            </div>
          )}
          <label className="row" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={stayToCreate}
              onChange={(e) => {
                const on = e.target.checked;
                setStayToCreate(on);
                if (settings) {
                  void saveSettings({ ...settings, createStayOnForm: on }).catch(() => {
                    /* ignore */
                  });
                }
              }}
            />
            {t("docker.stayOnForm")}
          </label>
          <label className="row" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={waitAdbPref}
              onChange={(e) => {
                const on = e.target.checked;
                setWaitAdbPref(on);
                if (settings) {
                  void saveSettings({ ...settings, createWaitAdb: on }).catch(() => {
                    /* ignore */
                  });
                }
              }}
            />
            {t("docker.waitAdb")}
          </label>
          <fieldset disabled={busy === "create"} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="form-grid">
            {(
              [
                ["name", t("docker.field.name")],
                ["androidVersion", t("docker.field.androidVersion")],
                ["image", t("docker.field.imageVersion")],
              ] as const
            ).map(([key, label]) => (
              <div className="field" key={key}>
                <label>{label}</label>
                <input
                  data-create-name={key === "name" ? "1" : undefined}
                  value={String(form[key])}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    document.getElementById("rdc-create-submit")?.click();
                  }}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (key === "androidVersion") {
                      const img = form.image.trim();
                      const official = !img || /^redroid\/redroid:/i.test(img);
                      setForm({
                        ...form,
                        androidVersion: value,
                        image: official ? `redroid/redroid:${value}` : img,
                      });
                      return;
                    }
                    if (key === "image") {
                      const tag = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
                      setForm({
                        ...form,
                        image: value,
                        androidVersion: tag || form.androidVersion,
                      });
                      return;
                    }
                    setForm({ ...form, [key]: value });
                  }}
                />
                {key === "name" && nameTaken && (
                  <div className="bad" style={{ fontSize: 12, marginTop: 6 }}>
                    {t("docker.nameTaken")}
                    {nameSuggestion && (
                      <>
                        {t("docker.availableHint")}
                        <button
                          type="button"
                          style={{ textDecoration: "underline" }}
                          onClick={() => setForm((f) => ({ ...f, name: nameSuggestion }))}
                        >
                          {nameSuggestion}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="field">
              <label>{t("docker.field.cpu")}</label>
              <select
                value={["1", "2", "4", "6", "8"].includes(form.cpu) ? form.cpu : "__custom__"}
                onChange={(e) => {
                  if (e.target.value !== "__custom__") setForm({ ...form, cpu: e.target.value });
                }}
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="6">6</option>
                <option value="8">8</option>
                <option value="__custom__">{t("docker.custom")}</option>
              </select>
              <input
                value={form.cpu}
                onChange={(e) => setForm({ ...form, cpu: e.target.value })}
                placeholder={t("docker.cpuPlaceholder")}
              />
            </div>
            <div className="field">
              <label>RAM</label>
              <select
                value={["1g", "2g", "4g", "6g", "8g"].includes(form.ram.toLowerCase()) ? form.ram.toLowerCase() : "__custom__"}
                onChange={(e) => {
                  if (e.target.value !== "__custom__") setForm({ ...form, ram: e.target.value });
                }}
              >
                <option value="1g">1g</option>
                <option value="2g">2g</option>
                <option value="4g">4g</option>
                <option value="6g">6g</option>
                <option value="8g">8g</option>
                <option value="__custom__">{t("docker.custom")}</option>
              </select>
              <input
                value={form.ram}
                onChange={(e) => setForm({ ...form, ram: e.target.value })}
                placeholder={t("docker.ramPlaceholder")}
              />
            </div>
            <div className="field">
              <label>{t("docker.field.resolution")}</label>
              <select
                value={
                  (RES_PRESETS as readonly string[]).includes(form.resolution)
                    ? form.resolution
                    : "__custom__"
                }
                onChange={(e) => {
                  if (e.target.value !== "__custom__") setForm({ ...form, resolution: e.target.value });
                }}
              >
                <option value="720x1280">720 × 1280</option>
                <option value="1080x1920">1080 × 1920</option>
                <option value="1080x2400">1080 × 2400</option>
                <option value="1440x3200">1440 × 3200</option>
                <option value="1200x1920">{t("docker.resTablet1200")}</option>
                <option value="__custom__">{t("docker.custom")}</option>
              </select>
              <input
                value={form.resolution}
                onChange={(e) => setForm({ ...form, resolution: e.target.value })}
                placeholder={t("docker.widthXHeight")}
              />
              {!validResolution(form.resolution) && (
                <div className="bad" style={{ fontSize: 12 }}>
                  {t("docker.badResolution")}
                </div>
              )}
            </div>
            <div className="field">
              <label>DPI</label>
              <select
                value={(DPI_PRESETS as readonly string[]).includes(form.dpi) ? form.dpi : "__custom__"}
                onChange={(e) => {
                  if (e.target.value !== "__custom__") setForm({ ...form, dpi: e.target.value });
                }}
              >
                <option value="240">240</option>
                <option value="320">320</option>
                <option value="400">400</option>
                <option value="480">480</option>
                <option value="560">560</option>
                <option value="__custom__">{t("docker.custom")}</option>
              </select>
              <input
                value={form.dpi}
                onChange={(e) => setForm({ ...form, dpi: e.target.value })}
                placeholder="DPI"
              />
              {!validDpi(form.dpi) && (
                <div className="bad" style={{ fontSize: 12 }}>
                  {t("docker.badDpi")}
                </div>
              )}
            </div>
            <div className="field">
              <label>{t("docker.field.adbPort")}</label>
              <div className="row">
                <input
                  type="number"
                  style={{ flex: 1 }}
                  value={form.adbPort}
                  onChange={(e) => setForm({ ...form, adbPort: Number(e.target.value) })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const port = await DeviceService.nextFreeAdbPort();
                    setForm((f) => ({ ...f, adbPort: port }));
                    setPortTaken(false);
                    setPortSuggestion(null);
                  }}
                >
                  {t("docker.autoAssign")}
                </Button>
              </div>
              {portTaken && (
                <div className="bad" style={{ fontSize: 12, marginTop: 6 }}>
                  {t("docker.portTaken")}
                  {portSuggestion != null && (
                    <>
                      {t("docker.availableHint")}
                      <button
                        type="button"
                        style={{ textDecoration: "underline" }}
                        onClick={() => setForm((f) => ({ ...f, adbPort: portSuggestion }))}
                      >
                        {portSuggestion}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="field">
              <label>{t("docker.field.scrcpy")}</label>
              <div className="muted" style={{ fontSize: 12, paddingTop: 8 }}>
                {t("docker.scrcpyHint")}
              </div>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>{t("docker.field.gapps")}</label>
              <label className="row" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={!!form.installGapps}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      installGapps: e.target.checked,
                      gappsZip: form.gappsZip || settings?.gappsZipPath || "",
                    })
                  }
                />
                {t("docker.gappsPreinstall")}
              </label>
              <label className="row" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={autoStartAfterCreate}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setAutoStartAfterCreate(on);
                    if (settings) {
                      void saveSettings({ ...settings, createAutoStart: on }).catch(() => {
                        /* ignore */
                      });
                    }
                  }}
                />
                {t("docker.autoStartAfterCreate")}
              </label>
              {form.installGapps && (
                <div className="row">
                  <input
                    style={{ flex: 1 }}
                    value={form.gappsZip || ""}
                    onChange={(e) => setForm({ ...form, gappsZip: e.target.value })}
                    placeholder={t("docker.gappsZipPlaceholder")}
                  />
                  <Button
                    size="sm"
                    icon={<FolderOpen size={13} />}
                    onClick={async () => {
                      try {
                        const picked = await open({
                          multiple: false,
                          directory: false,
                          filters: [{ name: "GApps", extensions: ["zip"] }],
                        });
                        if (typeof picked === "string" && picked) {
                          setForm((f) => ({ ...f, gappsZip: picked }));
                        }
                      } catch {
                        /* dialog cancelled */
                      }
                    }}
                  >
                    {t("docker.browse")}
                  </Button>
                </div>
              )}
              {form.installGapps && (
                <div className={gappsExists ? "ok" : "bad"} style={{ fontSize: 12, marginTop: 6 }}>
                  {!(form.gappsZip || settings?.gappsZipPath || "").trim()
                    ? t("docker.gappsPathEmpty")
                    : gappsExists === null
                      ? t("docker.checkingPath")
                      : gappsExists
                        ? t("docker.pathFound", { path: (form.gappsZip || settings?.gappsZipPath || "").trim() })
                        : t("docker.pathMissing")}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t("docker.gappsNote")}
              </div>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>{t("docker.field.rootPreinstall")}</label>
              <label className="row" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={!!form.installMagisk}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setForm({ ...form, installMagisk: on });
                    // 首次勾选时若资产探测未完成/失败，重探一次，避免按钮被永久禁用
                    if (on && magiskAssets === null) {
                      void DeviceService.getMagiskAssets()
                        .then(setMagiskAssets)
                        .catch(() =>
                          setMagiskAssets({
                            magiskDir: "",
                            magiskOk: false,
                            lsposedOk: false,
                            shamikoOk: false,
                            message: t("docker.magiskProbeUnavailable"),
                          }),
                        );
                    }
                  }}
                />
                {t("docker.magiskPreinstall")}
              </label>
              {form.installMagisk && (
                <>
                  <label className="row" style={{ marginBottom: 8, marginLeft: 20 }}>
                    <input
                      type="checkbox"
                      checked={!!form.installLsposed}
                      onChange={(e) => setForm({ ...form, installLsposed: e.target.checked })}
                    />
                    {t("docker.lsposed")}
                    {magiskAssets && !magiskAssets.lsposedOk ? t("docker.missingZip") : ""}
                  </label>
                  <label className="row" style={{ marginBottom: 8, marginLeft: 20 }}>
                    <input
                      type="checkbox"
                      checked={!!form.installShamiko}
                      onChange={(e) => setForm({ ...form, installShamiko: e.target.checked })}
                    />
                    {t("docker.shamiko")}
                    {magiskAssets && !magiskAssets.shamikoOk ? t("docker.missingZip") : ""}
                  </label>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={hidePackagesText}
                      onChange={(e) => setHidePackagesText(e.target.value)}
                      placeholder={t("docker.denylistPlaceholder")}
                    />
                  </div>
                  {invalidPackages.length > 0 && (
                    <div className="bad" style={{ fontSize: 12, marginBottom: 8 }}>
                      {t("docker.invalidPackages", { list: invalidPackages.join("、") })}
                    </div>
                  )}
                  <div className="row" style={{ marginBottom: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={form.spoofProfile || ""}
                      onChange={(e) => setForm({ ...form, spoofProfile: e.target.value })}
                      placeholder={t("docker.spoofPlaceholder")}
                    />
                    <Button
                      size="sm"
                      icon={<FolderOpen size={13} />}
                      onClick={async () => {
                        try {
                          const picked = await open({
                            multiple: false,
                            directory: false,
                            filters: [{ name: "spoof profile", extensions: ["conf", "txt", "ini"] }],
                          });
                          if (typeof picked === "string" && picked) {
                            setForm((f) => ({ ...f, spoofProfile: picked }));
                          }
                        } catch {
                          /* dialog cancelled */
                        }
                      }}
                    >
                      {t("docker.browse")}
                    </Button>
                  </div>
                  {(form.spoofProfile || "").trim() && (
                    <div
                      className={spoofExists ? "ok" : "bad"}
                      style={{ fontSize: 12, marginBottom: 8 }}
                    >
                      {spoofExists === null
                        ? t("docker.checkingSpoof")
                        : spoofExists
                          ? t("docker.pathFound", { path: form.spoofProfile || "" })
                          : t("docker.spoofMissing")}
                    </div>
                  )}
                </>
              )}
              {form.installMagisk && (
                <div
                  className={magiskAssets?.magiskOk ? "ok" : "bad"}
                  style={{ fontSize: 12, marginTop: 6 }}
                >
                  {magiskAssets === null
                    ? t("docker.checkingMagisk")
                    : magiskAssets.magiskOk
                      ? t("docker.magiskReady", {
                          dir: magiskAssets.magiskDir,
                          lsposed: magiskAssets.lsposedOk ? "✓" : "✗",
                          shamiko: magiskAssets.shamikoOk ? "✓" : "✗",
                        })
                      : magiskAssets.message || t("docker.magiskIncomplete")}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t("docker.magiskNote")}
              </div>
            </div>
          </div>
          </fieldset>
          <div className="row" style={{ marginTop: 14 }}>
            <Button
              id="rdc-create-submit"
              variant="primary"
              loading={busy === "create"}
              disabled={
                (tools !== null && !tools.docker.ok) ||
                (!!form.installGapps && gappsExists === false) ||
                (!!form.installMagisk &&
                  (magiskAssets === null ||
                    !magiskAssets.magiskOk ||
                    (!!form.installLsposed && !magiskAssets.lsposedOk) ||
                    (!!form.installShamiko && !magiskAssets.shamikoOk))) ||
                (!!form.installMagisk && spoofExists === false) ||
                (!!form.installMagisk && invalidPackages.length > 0) ||
                !validResolution(form.resolution) ||
                !validDpi(form.dpi) ||
                nameTaken ||
                portTaken ||
                !form.name.trim()
              }
              title={
                tools && !tools.docker.ok
                  ? t("docker.dockerUnavailable", { text: tools.docker.text })
                  : form.installGapps && gappsExists === false
                    ? t("docker.gappsPathMissing")
                    : form.installMagisk && (magiskAssets === null || !magiskAssets.magiskOk)
                      ? t("docker.magiskMissingTitle")
                      : form.installMagisk && form.installLsposed && magiskAssets && !magiskAssets.lsposedOk
                        ? t("docker.lsposedMissing")
                    : form.installMagisk && form.installShamiko && magiskAssets && !magiskAssets.shamikoOk
                      ? t("docker.shamikoMissing")
                      : form.installMagisk && spoofExists === false
                        ? t("docker.spoofMissing")
                        : form.installMagisk && invalidPackages.length > 0
                          ? t("docker.denylistInvalid")
                          : !validResolution(form.resolution)
                      ? t("docker.resolutionInvalid")
                      : !validDpi(form.dpi)
                        ? t("docker.dpiInvalid")
                        : nameTaken
                          ? t("docker.nameTakenSuggest", { name: nameSuggestion || t("docker.otherName") })
                          : portTaken
                            ? t("docker.portTakenSuggest", { port: portSuggestion ?? t("docker.otherPort") })
                            : !form.name.trim()
                              ? t("docker.nameRequired")
                              : undefined
              }
              onClick={async () => {
                if (!validResolution(form.resolution)) {
                  setStatusText(t("docker.resolutionInvalid"));
                  void alert(t("docker.resolutionAlert"));
                  return;
                }
                if (!validDpi(form.dpi)) {
                  setStatusText(t("docker.dpiInvalid"));
                  void alert(t("docker.dpiAlert"));
                  return;
                }
                if (!form.name.trim()) {
                  setStatusText(t("docker.nameRequired"));
                  return;
                }
                if (await DeviceService.checkInstanceName(form.name)) {
                  const suggest = nameSuggestion || (await suggestName(form.name));
                  setNameTaken(true);
                  setNameSuggestion(suggest);
                  setStatusText(t("docker.nameExists", { name: form.name }));
                  if (await askConfirm(t("docker.nameExistsConfirm", { name: suggest }))) {
                    setForm((f) => ({ ...f, name: suggest }));
                    setNameTaken(false);
                  }
                  return;
                }
                const gappsPath = (form.gappsZip || settings?.gappsZipPath || "").trim();
                if (form.installGapps && !gappsPath) {
                  setStatusText(t("docker.gappsZipRequired"));
                  void alert(t("docker.gappsZipAlert"));
                  return;
                }
                const hidePackages = hidePackageList;
                if (form.installMagisk && invalidPackages.length > 0) {
                  setStatusText(t("docker.denylistInvalid"));
                  void alert(t("docker.denylistAlert", { list: invalidPackages.join("\n") }));
                  return;
                }
                if (form.installMagisk && form.spoofProfile?.trim()) {
                  const ok = await DeviceService.pathExists(form.spoofProfile.trim());
                  if (!ok) {
                    setStatusText(t("docker.spoofMissing"));
                    void alert(t("docker.spoofMissingAlert", { path: form.spoofProfile }));
                    return;
                  }
                }
                setBusy("create");
                setStatusText(t("docker.probingDocker"));
                const dockerHit = await probeTool("docker", settings?.dockerPath);
                if (!dockerHit.ok) {
                  setStatusText(t("docker.dockerUnavailableShort"));
                  void alert(
                    t("docker.dockerUnavailableAlert", { text: dockerHit.text }),
                  );
                  setBusy(null);
                  return;
                }
                let waitAdb = waitAdbPref;
                setStatusText(t("docker.probingAdb"));
                const adbHit = await probeTool("adb", settings?.adbPath);
                if (!adbHit.ok) {
                  waitAdb = false;
                  setStatusText(t("docker.adbUnavailableCreateOnly"));
                  if (
                    !(await askConfirm(
                      t("docker.adbUnavailableConfirm", { text: adbHit.text }),
                    ))
                  ) {
                    setBusy(null);
                    return;
                  }
                }
                setStatusText(
                  form.installGapps
                    ? t("docker.creatingGapps")
                    : waitAdb
                      ? t("docker.creatingWaitAdb")
                      : t("docker.creatingContainer"),
                );
                try {
                  const r = await DeviceService.createInstance({
                    ...form,
                    gappsZip: gappsPath,
                    hidePackages,
                    waitAdb,
                  });
                  await load();
                  const serial = `127.0.0.1:${form.adbPort}`;
                  const created = r.success || (await DeviceService.checkInstanceName(form.name));
                  if (created && settings) {
                    try {
                      await saveSettings({
                        ...settings,
                        installGapps: !!form.installGapps,
                        gappsZipPath: form.installGapps ? gappsPath : settings.gappsZipPath,
                        lastCpu: form.cpu,
                        lastRam: form.ram,
                        lastResolution: form.resolution,
                        lastDpi: form.dpi,
                        lastImage: form.image,
                        createAutoStart: autoStartAfterCreate,
                        createWaitAdb: waitAdb,
                      });
                    } catch {
                      /* ignore persist */
                    }
                  }
                  const offerAutoStart = async () => {
                    if (!settings || !autoStartAfterCreate) return;
                    const list = await DeviceService.listDevices();
                    const hit = list.find(
                      (d) => d.serial === serial || d.name === form.name || d.id === form.name,
                    );
                    const id = hit?.id || serial;
                    const ids = new Set(settings.autoStartDeviceIds ?? []);
                    ids.add(id);
                    await saveSettings({ ...settings, autoStartDeviceIds: [...ids] });
                    setStatusText(t("docker.addedAutoStart", { name: form.name }));
                  };
                  const bumpCreateDefaults = async () => {
                    try {
                      const port = await DeviceService.nextFreeAdbPort();
                      const nextName = await suggestName(form.name);
                      setForm((f) => ({ ...f, name: nextName, adbPort: port }));
                      setNameTaken(false);
                      setPortTaken(false);
                    } catch {
                      /* keep current */
                    }
                  };
                  const scrollCreateForm = () => {
                    window.requestAnimationFrame(() => {
                      createFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      const nameInput = createFormRef.current?.querySelector<HTMLInputElement>(
                        'input[data-create-name="1"]',
                      );
                      nameInput?.focus();
                      nameInput?.select();
                    });
                  };
                  if (!r.success) {
                    const reason = (r.stderr || r.stdout || t("docker.createFailed")).trim();
                    setFailedSerial(created ? serial : "");
                    setCreateStage(t("docker.createIncomplete", { reason: reason.split("\n")[0] }));
                    setStatusText(r.stderr || t("docker.adbNotReady"));
                    void alert(r.stderr || r.stdout || t("docker.createFailed"));
                    if (created) {
                      await offerAutoStart();
                      await bumpCreateDefaults();
                      setLastCreatedSerial(serial);
                      setCreatedFlash(true);
                      window.setTimeout(() => setCreatedFlash(false), 1600);
                      if (!stayToCreate) {
                        setShowCreate(false);
                        openDevice(serial);
                      } else {
                        scrollCreateForm();
                      }
                    }
                    return;
                  }
                  setFailedSerial("");
                  setStatusText(r.stdout || t("docker.readyAdb", { serial }));
                  await offerAutoStart();
                  await bumpCreateDefaults();
                  setLastCreatedSerial(serial);
                  setCreatedFlash(true);
                  window.setTimeout(() => setCreatedFlash(false), 1600);
                  if (!stayToCreate) {
                    setShowCreate(false);
                    openDevice(serial);
                  } else {
                    scrollCreateForm();
                  }
                } catch (e) {
                  const err = e instanceof Error ? e.message : String(e);
                  setFailedSerial("");
                  setCreateStage(t("docker.createIncomplete", { reason: err.split("\n")[0] }));
                  setStatusText(err);
                  void alert(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "create" ? t("docker.createWaitBoot") : t("docker.createAndStart")}
            </Button>
            <Button
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  cpu: "2",
                  ram: "2g",
                  resolution: "1080x1920",
                  dpi: "320",
                  androidVersion: "13.0.0-latest",
                  image: "redroid/redroid:13.0.0-latest",
                }))
              }
            >
              {t("docker.resetDefaults")}
            </Button>
          </div>
        </Card>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Card
          title={t("docker.instancesTitle")}
          action={
            <div className="row">
              <input
                value={instQuery}
                onChange={(e) => setInstQuery(e.target.value)}
                placeholder={t("docker.searchInstances")}
                style={{ height: 30, minWidth: 160, padding: "0 8px", borderRadius: 8 }}
              />
              <select
                value={instFilter}
                onChange={(e) => setInstFilter(e.target.value as "all" | "up" | "exited")}
                style={{ height: 30, padding: "0 8px", borderRadius: 8 }}
              >
                <option value="all">{t("docker.filterAll", { n: redroidsAll.length })}</option>
                <option value="up">{t("docker.filterUp", { n: redroidsAll.filter((c) => isUp(c.status)).length })}</option>
                <option value="exited">{t("docker.filterExited", { n: redroidsAll.filter((c) => !isUp(c.status)).length })}</option>
              </select>
            </div>
          }
        >
          {loading ? (
            <Skeleton count={4} height={40} />
          ) : redroids.length === 0 ? (
            <div className="empty-state">
              {redroidsAll.length === 0 ? (
                <>
                  {t("docker.noInstances")}
                  <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setShowCreate(true)}>
                    {t("common.panel.goCreate")}
                  </Button>
                </>
              ) : (
                <>
                  {t("docker.noMatchingInstances")}
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      setInstQuery("");
                      setInstFilter("all");
                    }}
                  >
                    {t("docker.clearFilter")}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="stack">
              {redroids.map((c) => (
                <InstanceRow
                  key={c.id}
                  c={c}
                  busy={busy}
                  highlight={Boolean(
                    (lastCreatedSerial && adbSerialFromPorts(c.ports) === lastCreatedSerial) ||
                      (failedSerial && adbSerialFromPorts(c.ports) === failedSerial) ||
                      (clonedName &&
                        c.name.replace(/^\/?rdc-/, "") === clonedName.replace(/^\/?rdc-/, "")),
                  )}
                  scrollIntoView={!stayToCreate}
                  dockerOk={tools?.docker.ok !== false}
                  dockerHint={tools && !tools.docker.ok ? t("docker.dockerUnavailable", { text: tools.docker.text }) : undefined}
                  run={run}
                  openDevice={openDevice}
                  setStatusText={setStatusText}
                  onCloned={(name) => {
                    const n = name.replace(/^\/?rdc-/, "");
                    setClonedName(n);
                    setInstQuery(n);
                    setInstFilter("all");
                  }}
                />
              ))}
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title={t("docker.allContainers")}>
            {loading ? (
              <Skeleton count={5} height={28} />
            ) : (info?.containers ?? []).length === 0 ? (
              <div className="empty-state">{t("docker.noContainers")}</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("devices.table.name")}</th>
                    <th>{t("docker.colImage")}</th>
                    <th>{t("docker.colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(info?.containers ?? []).map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.isRedroid ? (
                          <button
                            type="button"
                            title={t("docker.locateInList")}
                            style={{
                              background: "none",
                              border: 0,
                              padding: 0,
                              color: "inherit",
                              cursor: "pointer",
                              textDecoration: "underline",
                            }}
                            onClick={() => {
                              setInstQuery(c.name.replace(/^\/?rdc-/, ""));
                              setInstFilter("all");
                            }}
                          >
                            {c.name}
                          </button>
                        ) : (
                          c.name
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {c.image}
                      </td>
                      <td>{c.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card
            title={t("docker.imagesTitle")}
            action={
              <div className="row">
                <input
                  value={imgQuery}
                  onChange={(e) => setImgQuery(e.target.value)}
                  placeholder={t("docker.searchImages")}
                  style={{ height: 30, minWidth: 140, padding: "0 8px", borderRadius: 8 }}
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={tools?.docker.ok === false || busy === "prune-img"}
                  loading={busy === "prune-img"}
                  onClick={async () => {
                    const n = (info?.images ?? []).filter(
                      (img) => img.repository === "<none>" || img.tag === "<none>",
                    ).length;
                    if (
                      !(await askConfirm(
                        n
                          ? t("docker.pruneConfirm", { n })
                          : t("docker.pruneConfirmNone"),
                      ))
                    ) {
                      return;
                    }
                    void run(
                      "prune-img",
                      async () => {
                        const r = await DeviceService.pruneDanglingImages();
                        if (!r.success) throw new Error(r.stderr || r.stdout || t("docker.pruneFailed"));
                      },
                      t("docker.pruneDanglingImages"),
                    );
                  }}
                >
                  {t("docker.pruneDangling")}
                </Button>
              </div>
            }
          >
            {loading ? (
              <Skeleton count={4} height={28} />
            ) : imagesFiltered.length === 0 ? (
              <div className="empty-state">
                {(info?.images ?? []).length === 0 ? (
                  t("docker.noImages")
                ) : (
                  <>
                    {t("docker.noMatchingImages")}
                    <Button size="sm" variant="ghost" style={{ marginLeft: 8 }} onClick={() => setImgQuery("")}>
                      {t("docker.clearSearch")}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("docker.colRepo")}</th>
                    <th>{t("docker.colTag")}</th>
                    <th>{t("docker.colSize")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {imagesFiltered.slice(0, 20).map((img) => (
                    <tr key={img.id + img.tag}>
                      <td>{img.repository}</td>
                      <td>{img.tag}</td>
                      <td>{img.size}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={tools?.docker.ok === false || busy === img.id}
                          loading={busy === img.id}
                          onClick={async () => {
                            const ref =
                              img.repository && img.tag && img.tag !== "<none>"
                                ? `${img.repository}:${img.tag}`
                                : img.id;
                            if (!(await askConfirm(t("docker.removeImageConfirm", { ref })))) return;
                            void run(img.id, async () => {
                              const r = await DeviceService.removeImage(ref, false);
                              if (!r.success) throw new Error(r.stderr || r.stdout || t("docker.deleteFailed"));
                            }, t("docker.removeImage"));
                          }}
                        >
                          {t("docker.delete")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

    </div>
  );
}

function InstanceRow({
  c,
  busy,
  highlight,
  scrollIntoView,
  dockerOk,
  dockerHint,
  run,
  openDevice,
  setStatusText,
  onCloned,
}: {
  c: DockerContainer;
  busy: string | null;
  highlight?: boolean;
  scrollIntoView?: boolean;
  dockerOk: boolean;
  dockerHint?: string;
  run: (id: string, fn: () => Promise<unknown>, msg: string) => Promise<void>;
  openDevice: (serial: string) => void;
  setStatusText: (s: string) => void;
  onCloned?: (name: string) => void;
}) {
  const { t } = useI18n();
  const serial = adbSerialFromPorts(c.ports);
  const volume = volumeNameOf(c.name);
  const navigate = useNavigate();
  const [panel, setPanel] = useState<{ kind: "inspect" | "logs"; text: string; loading: boolean } | null>(
    null,
  );

  const openInspect = async () => {
    setPanel({ kind: "inspect", text: "", loading: true });
    try {
      const r = await DeviceService.inspectContainer(c.id);
      const raw = r.stdout || r.stderr || t("docker.noOutput");
      setPanel({ kind: "inspect", text: raw, loading: false });
    } catch (e) {
      setPanel({ kind: "inspect", text: e instanceof Error ? e.message : String(e), loading: false });
    }
  };

  const openLogs = async () => {
    setPanel({ kind: "logs", text: "", loading: true });
    try {
      const r = await DeviceService.getContainerLogs(c.id, 200);
      const raw = [r.stdout, r.stderr].filter(Boolean).join("\n") || t("docker.noLogs");
      setPanel({ kind: "logs", text: raw, loading: false });
    } catch (e) {
      setPanel({ kind: "logs", text: e instanceof Error ? e.message : String(e), loading: false });
    }
  };

  return (
    <div
      className="instance-row"
      ref={(el) => {
        if (highlight && scrollIntoView && el) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }}
      style={
        highlight
          ? { outline: "2px solid var(--success)", borderRadius: 10, padding: 8 }
          : undefined
      }
    >
      <div>
        <div style={{ fontWeight: 650 }}>{c.name.replace(/^\/?rdc-/, "")}</div>
        <div className="muted mono" style={{ fontSize: 12 }}>
          {t("docker.containerLine", { name: c.name, status: c.status })}
        </div>
        <div className="muted mono" style={{ fontSize: 12, fontWeight: 600 }}>
          ADB {serial || c.ports || t("docker.notMapped")}
        </div>
        <div className="muted mono" style={{ fontSize: 11 }}>
          {t("docker.volumeLine", { volume })}
        </div>
        <div className="muted mono" style={{ fontSize: 11 }}>
          {c.image} · {c.id.slice(0, 12)}
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button
          size="sm"
          variant="primary"
          icon={<Smartphone size={13} />}
          disabled={!serial}
          onClick={() => serial && openDevice(serial)}
        >
          {t("docker.openDevice")}
        </Button>
        <Button
          size="sm"
          icon={<Database size={13} />}
          onClick={() => {
            try {
              sessionStorage.setItem("rdc.volumes.query", volume);
            } catch {
              /* ignore */
            }
            navigate("/volumes");
          }}
        >
          {t("docker.volumes")}
        </Button>
        <Button
          size="sm"
          icon={<Play size={13} />}
          loading={busy === c.id}
          disabled={!dockerOk}
          title={dockerHint}
          onClick={() => run(c.id, () => DeviceService.startContainer(c.id), t("docker.startContainer"))}
        >
          {t("docker.start")}
        </Button>
        <Button
          size="sm"
          icon={<Square size={13} />}
          disabled={!dockerOk}
          title={dockerHint}
          onClick={() => run(c.id, () => DeviceService.stopContainer(c.id), t("docker.stopContainer"))}
        >
          {t("docker.stop")}
        </Button>
        <Button
          size="sm"
          icon={<RefreshCw size={13} />}
          disabled={!dockerOk}
          title={dockerHint}
          onClick={() => run(c.id, () => DeviceService.restartContainer(c.id), t("docker.restartContainer"))}
        >
          {t("docker.restart")}
        </Button>
        <select
          disabled={!dockerOk}
          title={dockerHint}
          defaultValue=""
          style={{ height: 28, padding: "0 8px", borderRadius: 8 }}
          onChange={(e) => {
            const v = e.target.value;
            e.target.value = "";
            if (v === "serial") {
              if (!serial) {
                setStatusText(t("docker.noAdbPort"));
                return;
              }
              void copyText(serial).then(
                () => setStatusText(t("common.panel.copied", { value: serial })),
                () => setStatusText(t("common.panel.copyFailed")),
              );
            }
            if (v === "inspect") void openInspect();
            if (v === "logs") void openLogs();
            if (v === "clone") {
              const name = prompt(t("docker.cloneAs"), `${c.name.replace(/^\/?rdc-/, "")}-copy`);
              if (!name) return;
              void run(c.id, async () => {
                const r = await DeviceService.cloneContainer(c.id, name);
                if (r.success) onCloned?.(name);
                return r;
              }, t("docker.cloneContainer"));
            }
            if (v === "rename") {
              const name = prompt(t("docker.newName"));
              if (!name) return;
              void run(c.id, () => DeviceService.renameContainer(c.id, name), t("docker.rename"));
            }
            if (v === "export") {
              void (async () => {
                try {
                  const path = await save({
                    defaultPath: `${c.name.replace(/^\/?/, "")}.json`,
                    filters: [{ name: "JSON", extensions: ["json"] }],
                  });
                  if (!path) return;
                  const saved = await DeviceService.exportContainerConfig(c.id, path);
                  setStatusText(t("docker.exported", { path: saved || path }));
                  if (await askConfirm(t("docker.revealConfirm"))) {
                    await DeviceService.revealInFolder(saved || path);
                  }
                } catch (e) {
                  if (e) {
                    const err = e instanceof Error ? e.message : String(e);
                    setStatusText(err);
                    void alert(err);
                  }
                }
              })();
            }
          }}
        >
          <option value="" disabled>
            {t("docker.more")}
          </option>
          <option value="serial" disabled={!serial}>
            {t("docker.copySerial")}
          </option>
          <option value="inspect">{t("docker.inspect")}</option>
          <option value="logs">{t("docker.logs")}</option>
          <option value="clone">{t("docker.clone")}</option>
          <option value="rename">{t("docker.rename")}</option>
          <option value="export">{t("docker.exportJson")}</option>
        </select>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={13} />}
          disabled={!dockerOk}
          title={dockerHint}
          onClick={async () => {
            // Native dialog: window.confirm is suppressed while the window is
            // minimized and auto-resolves, which once deleted a container
            // with no visible confirmation at all.
            if (!(await askConfirm(t("docker.removeConfirm", { name: c.name, volume })))) return;
            const alsoVol = await askConfirm(
              t("docker.removeVolumeConfirm", { volume }),
            );
            void run(
              c.id,
              async () => {
                const rm = await DeviceService.removeContainer(c.id, true);
                if (!rm.success) throw new Error(rm.stderr || rm.stdout || t("docker.removeContainerFailed"));
                if (alsoVol) {
                  const vr = await DeviceService.removeVolume(volume, true);
                  if (!vr.success) {
                    throw new Error(vr.stderr || vr.stdout || t("docker.removeVolumeFailed"));
                  }
                }
              },
              alsoVol ? t("docker.removeContainerAndVolume") : t("docker.removeContainer"),
            );
          }}
        >
          {t("docker.delete")}
        </Button>
      </div>
      {panel && (
        <div style={{ width: "100%", marginTop: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong>{panel.kind === "inspect" ? "docker inspect" : t("docker.containerLogs")}</strong>
            <Button
              size="sm"
              variant="ghost"
              disabled={panel.loading || !panel.text}
              onClick={() => {
                void copyText(panel.text).then(
                  () => setStatusText(t("docker.copied")),
                  () => setStatusText(t("common.panel.copyFailed")),
                );
              }}
            >
              {t("docker.copy")}
            </Button>
            {panel.kind === "logs" && (
              <Button size="sm" variant="ghost" disabled={panel.loading} onClick={() => void openLogs()}>
                {t("common.refresh")}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
              {t("common.close")}
            </Button>
          </div>
          <pre className="shell-output" style={{ maxHeight: 280, overflow: "auto" }}>
            {panel.loading ? t("common.loading") : panel.text}
          </pre>
        </div>
      )}
    </div>
  );
}
