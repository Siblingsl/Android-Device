import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Play, Square, RefreshCw, Trash2, Shield, FolderOpen, Smartphone, Database, ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { copyText } from "../../lib/clipboard";
import { askConfirm } from "../../lib/dialogs";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { DeviceService } from "../../services/deviceService";
import { probeTool } from "../../hooks/useToolProbe";
import { createRequestSequence } from "../../lib/requestSequence";
import { DPI_PRESETS, RES_PRESETS, validDpi, validResolution } from "../../lib/displaySpec";
import { ToolStatus } from "../../components/ui/ToolStatus";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import type { TrackTaskInfo } from "../../lib/runtimeTrack";
import type { CreateInstanceRequest, DockerContainer, DockerInfo, MagiskAssets, SpoofProfileSummary, SpoofProfileUsage, WslKernelStatus } from "../../types";

/** Above this many containers sharing one spoof profile, warn on the create form. */
const SPOOF_USAGE_WARN_THRESHOLD = 5;

function adbSerialFromPorts(ports?: string): string | null {
  const m = ports?.match(/:(\d+)->5555/);
  return m ? `127.0.0.1:${m[1]}` : null;
}



function volumeNameOf(containerName: string): string {
  const n = containerName.replace(/^\/?/, "");
  return n.endsWith("-data") ? n : `${n}-data`;
}

type CreatingInstanceTask = {
  name: string;
  containerName: string;
  image: string;
  adbPort: number;
  stage: string;
  cancelRequested: boolean;
};

function createContainerName(name: string): string {
  const sanitized = Array.from(name)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : "-"))
    .join("")
    .toLowerCase();
  return `rdc-${sanitized}`;
}

function readSession(key: string, fallback = "") {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Lifecycle contract with the merged-page shell (`pages/containers/RuntimePage`).
 * Both props are optional, so the standalone `/docker` route renders the panel
 * exactly as before.
 */
export type DockerTrackPanelProps = {
  /**
   * Polling contract (merge spec §6.4). `false` = mounted but hidden behind the
   * other track: business polling pauses. One-shot timers (the debounced name /
   * port probes) and user-triggered requests are deliberately not affected.
   */
  active?: boolean;
  /**
   * Lifecycle report: the long task this panel is running right now, or `null`.
   * The shell keeps a reporting panel mounted while the other track is active
   * instead of unmounting it (which would drop the task's local state).
   */
  onTaskChange?: (task: TrackTaskInfo | null) => void;
  /**
   * Merged-page header dedup (P5): `false` drops this panel's own page header —
   * only the title/subtitle block — because the shell already renders the page
   * title once. The header's actions (刷新 / 创建实例) are *not* part of what is
   * dropped: they stay as the panel's top action row, so no capability is
   * hidden. Defaults to `true`; the standalone `/docker` route is unchanged.
   */
  showHeader?: boolean;
  /**
   * a11y wiring for the shell's tablist (P5). The panel root *is* the tabpanel:
   * global.css scopes this track's layout through `.page-fade > div`, so no
   * wrapper element may be inserted around it. Left undefined on the standalone
   * route, which then renders no tab/tabpanel relationship at all.
   */
  panelId?: string;
  /** id of the tab whose `aria-controls` points at `panelId`. */
  panelLabelId?: string;
  /**
   * Explicit refresh from the shell's source badge (P5): a bump re-runs this
   * panel's own read-only status load. The shell never calls a service itself,
   * and the initial value must not trigger anything — entering the page loads
   * nothing but what this panel already loads on mount.
   */
  refreshSignal?: number;
};

export default function DockerTrackPanel({
  active = true,
  onTaskChange,
  showHeader = true,
  panelId,
  panelLabelId,
  refreshSignal,
}: DockerTrackPanelProps = {}) {
  const { t } = useI18n();
  const storeSetStatusText = useAppStore((s) => s.setStatusText);
  // Status-line sourcing (merge spec §6.4): this track's status line is the
  // shared app footer, so a write from here names its origin. Everything else
  // about the call is unchanged — same `(text: string) => void` signature, same
  // call sites, same i18n keys.
  const setStatusText = useCallback(
    (text: string) => storeSetStatusText(`${t("runtime.track.docker")} · ${text}`),
    [storeSetStatusText, t],
  );
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const navigate = useNavigate();

  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [kernel, setKernel] = useState<WslKernelStatus | null>(null);
  const [kernelExpanded, setKernelExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creatingTask, setCreatingTask] = useState<CreatingInstanceTask | null>(null);
  const [cancelCreateBusy, setCancelCreateBusy] = useState(false);
  const createCancelRequestedRef = useRef(false);
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
  const [spoofProfiles, setSpoofProfiles] = useState<SpoofProfileSummary[]>([]);
  const [spoofUsage, setSpoofUsage] = useState<SpoofProfileUsage[]>([]);
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
  const loadSequence = useRef(createRequestSequence()).current;

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
    spoofProfileId: settings?.lastSpoofProfileId || "redmi-k40-alioth",
    spoofAbilist: false,
    installCloak: false,
    cleanTraces: true,
    gpuPassthrough: false,
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
    // Polling gate (merge spec §6.4): a hidden track does no business polling.
    // The create runs in the backend and finishes through the awaited
    // `createInstance` promise in the submit handler, so pausing this stage poll
    // loses no progress — it only stops refreshing the stage label until the
    // track is active again.
    if (!active) return;
    if (busy !== "create") return;
    const t = window.setInterval(() => {
      void DeviceService.getCreateStage()
        .then((s) => {
          if (s) {
            setCreateStage(s);
            setCreatingTask((task) => (task ? { ...task, stage: s } : task));
            setStatusText(s);
          }
        })
        .catch(() => {
          /* ignore */
        });
    }, 700);
    return () => window.clearInterval(t);
  }, [active, busy, setStatusText]);

  /**
   * Lifecycle report (merge spec §6.4). `busy === "create"` spans the whole
   * create window (it is set first and cleared in the handler's `finally`), and
   * its stage text doubles as the description in the shell's background bar.
   * Only reported: the panel decides nothing about mounting.
   */
  const createTaskLabel =
    busy === "create" ? creatingTask?.stage || createStage || t("docker.createWaitBoot") : null;
  useEffect(() => {
    onTaskChange?.(createTaskLabel ? { label: createTaskLabel } : null);
  }, [onTaskChange, createTaskLabel]);

  useEffect(() => {
    const name = form.name.trim();
    if (!name) {
      setNameTaken(false);
      setNameSuggestion("");
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void Promise.resolve()
        .then(() => DeviceService.checkInstanceName?.(name) ?? false)
        .then(async (taken) => {
          if (cancelled) return;
          setNameTaken(taken);
          setNameSuggestion(taken ? await suggestName(name) : "");
        })
        .catch(() => {
          if (!cancelled) setNameTaken(false);
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
      void Promise.resolve()
        .then(() => DeviceService.checkAdbPort?.(port) ?? false)
        .then(async (taken) => {
          if (cancelled) return;
          setPortTaken(taken);
          setPortSuggestion(taken ? await DeviceService.nextFreeAdbPort() : null);
        })
        .catch(() => {
          if (!cancelled) setPortTaken(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [form.adbPort]);

  const probeTools = async (token: number) => {
    const [d, a] = await Promise.all([
      probeTool("docker", settings?.dockerPath),
      probeTool("adb", settings?.adbPath),
    ]);
    if (!loadSequence.isCurrent(token)) return;
    setTools({ docker: d, adb: a });
  };

  const load = async () => {
    const token = loadSequence.begin();
    setLoading(true);
    try {
      const [d, k] = await Promise.all([
        DeviceService.refreshDockerInfo(),
        DeviceService.getWslKernelStatus().catch(() => null),
      ]);
      if (!loadSequence.isCurrent(token)) return;
      setInfo(d);
      setKernel(k);
      void probeTools(token);
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      setStatusText(e instanceof Error ? t("docker.refreshFailedWith", { msg: e.message }) : t("docker.refreshFailed"));
    } finally {
      if (!loadSequence.isCurrent(token)) return;
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
          spoofProfileId: settings?.lastSpoofProfileId || f.spoofProfileId,
        }));
      })
      .catch(() => {
        /* ignore */
      });
    return () => loadSequence.invalidate();
  }, []);

  /**
   * Read-only source snapshot for the shell's badge (merge spec §6.8). Built
   * only from data this panel already loaded — no extra command, and the shell
   * never queries anything itself. The deps change exactly when a read landed
   * (`setInfo`/`setKernel`/`setTools` always store fresh objects), so the
   * timestamp is the age of the reading, not of the last render.
   *
   * `instances` (P6, additive) is the same redroid container list this panel
   * renders, mapped 1:1 for the comparison view. It is deliberately *not*
   * filtered by the panel's own search/status filters: those are view state, and
   * a snapshot that changed with them would be reporting the filter, not the
   * host. `androidVersion` stays empty because `docker ps` carries no version —
   * the image tag is the evidence and the view maps it.
   */
  const publishSource = useAppStore((s) => s.setDockerSource);
  useEffect(() => {
    if (!info && !kernel && !tools) return;
    publishSource({
      at: Date.now(),
      running: info ? info.running : null,
      containers: info ? info.containers.length : null,
      cliAvailable: tools ? tools.docker.ok : null,
      kernelBinderEnabled: kernel ? kernel.binderEnabled : null,
      instances: info
        ? info.containers
            .filter((container) => container.isRedroid)
            .map((container) => ({
              name: container.name,
              androidVersion: "",
              image: container.image,
              status: container.status,
              host: "",
              metrics: container.metrics ?? null,
            }))
        : null,
    });
  }, [info, kernel, tools, publishSource]);

  /**
   * Explicit refresh from the shell's badge (P5). A bump re-runs `load()`, i.e.
   * the same read-only `docker info` + WSL kernel + tool probe this panel does
   * on mount. The first value is recorded as already handled, so mounting the
   * merged page never triggers an extra read.
   */
  const handledRefreshRef = useRef(refreshSignal ?? 0);
  useEffect(() => {
    const signal = refreshSignal ?? 0;
    if (signal === handledRefreshRef.current) return;
    handledRefreshRef.current = signal;
    void load();
  }, [refreshSignal, load]);

  useEffect(() => {
    let cancelled = false;
    void DeviceService.listSpoofProfiles()
      .then((profiles) => {
        if (!cancelled) setSpoofProfiles(profiles);
      })
      .catch(() => {
        /* profile list is best-effort for the create form */
      });
    // Diversity census (docker labels) — best-effort, hidden when Docker is down.
    void DeviceService.spoofProfileUsage()
      .then((usage) => {
        if (!cancelled) setSpoofUsage(usage);
      })
      .catch(() => {
        /* usage census is best-effort */
      });
    return () => {
      cancelled = true;
    };
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
        : kernel?.mode === "external-vm"
          ? t("docker.kernel.externalVm")
          : t("docker.kernel.modeUnknown");
  const sizeMb = kernel?.customKernelSize ? (kernel.customKernelSize / 1024 / 1024).toFixed(1) : "—";
  const isWindowsWsl = kernel?.strategy === "wsl-prebuilt-or-build";
  const isLinuxHost = kernel?.strategy === "host-binder";
  const isMacDockerHost = kernel?.strategy === "docker-desktop-vm";

  const spoofBrands = [...new Set(spoofProfiles.map((p) => p.brand))];
  const selectedSpoofProfile = spoofProfiles.find((p) => p.id === form.spoofProfileId) ?? null;
  const selectedProfileUsage = selectedSpoofProfile
    ? spoofUsage.find((u) => u.profileId === selectedSpoofProfile.id)?.count ?? 0
    : 0;
  const selectedSpoofBrand = selectedSpoofProfile?.brand ?? spoofBrands[0] ?? "";
  const spoofModelsForBrand = spoofProfiles.filter((p) => p.brand === selectedSpoofBrand);
  const spoofBuiltinForBrand = spoofModelsForBrand.filter((p) => p.source !== "captured");
  const spoofCapturedForBrand = spoofModelsForBrand.filter((p) => p.source === "captured");

  const cancelCreatingInstance = async () => {
    const task = creatingTask;
    if (!task || task.cancelRequested || cancelCreateBusy) return;
    if (!(await askConfirm(t("docker.cancelCreateConfirm", { name: task.name })))) return;

    createCancelRequestedRef.current = true;
    setCreatingTask((current) =>
      current ? { ...current, cancelRequested: true, stage: t("docker.cancellingCreate") } : current,
    );
    setCancelCreateBusy(true);
    try {
      const result = await DeviceService.cancelCreateInstance(task.name);
      if (!result.success) {
        throw new Error(result.stderr || result.stdout || t("docker.cancelCreateFailed"));
      }
      setStatusText(t("docker.createCancelled"));
      if (busy !== "create") {
        await load();
        setCreatingTask(null);
      }
    } catch (e) {
      createCancelRequestedRef.current = false;
      setCreatingTask((current) =>
        current ? { ...current, cancelRequested: false, stage: createStage } : current,
      );
      const err = e instanceof Error ? e.message : String(e);
      setStatusText(err);
      void alert(err);
    } finally {
      setCancelCreateBusy(false);
    }
  };

  /**
   * Header actions, kept out of the title block so `showHeader={false}` (merged
   * page) can drop only the title/subtitle and still render every capability:
   * 刷新 (`load`) and 创建实例 (opens the create form, disabled while Docker is
   * unavailable). Pure move — same buttons, same handlers, same order; only the
   * wrapping class gained `runtime-panel-actions` for the collapsed layout.
   */
  const headerActions = (
    <div className="row runtime-panel-actions">
      <Button icon={<RefreshCw size={15} />} onClick={load}>
        {t("common.refresh")}
      </Button>
      <Button
        variant="primary"
        icon={<Plus size={15} />}
        disabled={Boolean(creatingTask) || (tools !== null && !tools.docker.ok)}
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
  );

  return (
    <div
      id={panelId}
      role={panelId ? "tabpanel" : undefined}
      aria-labelledby={panelId ? panelLabelId : undefined}
      tabIndex={panelId ? -1 : undefined}
    >
      {showHeader ? (
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("docker.title")}</h1>
            <div className="page-subtitle">{t("docker.subtitle")}</div>
          </div>
          {headerActions}
        </div>
      ) : (
        headerActions
      )}

      <div className="row" style={{ flexWrap: "wrap" }}>
        <ToolStatus kind="docker" hit={tools?.docker} />
        <ToolStatus kind="adb" hit={tools?.adb} />
      </div>

      <Card
        className={`kernel-card ${kernelExpanded ? "is-expanded" : "is-collapsed"}`}
        title={t("docker.kernelCard.title")}
        action={
          <div className="row kernel-actions">
            {!kernelExpanded && kernel && (
              <span className="kernel-summary muted">
                {kernelModeLabel} · Binder {isMacDockerHost ? t("docker.kernel.externalVm") : kernel.binderEnabled ? t("docker.enabled") : t("docker.disabled")}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={kernelExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              aria-expanded={kernelExpanded}
              title={kernelExpanded ? t("docker.kernel.collapse") : t("docker.kernel.expand")}
              onClick={() => setKernelExpanded((expanded) => !expanded)}
            >
              {kernelExpanded ? t("docker.kernel.collapse") : t("docker.kernel.expand")}
            </Button>
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={load}>
              {t("docker.refreshStatus")}
            </Button>
          </div>
        }
      >
        {!kernelExpanded ? null : loading && !kernel ? (
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
                  {isWindowsWsl ? t("docker.kernel.strategyWsl") : isLinuxHost ? t("docker.kernel.strategyHost") : isMacDockerHost ? t("docker.kernel.strategyMac") : t("docker.kernel.unsupported")}
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
                  {isMacDockerHost ? t("docker.kernel.externalVm") : kernel?.binderEnabled ? t("docker.enabled") : t("docker.disabled")}
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
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--muted)" }}>
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
                className="mono kernel-verify-output"
                style={{
                  margin: 0,
                  padding: 10,
                  fontSize: 11,
                  borderRadius: 10,
                  background: "var(--surface-tint)",
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

      <div className="grid-stats">
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
        <div className="create-modal-layer" role="presentation">
          <div
            ref={createFormRef}
            className="create-modal-shell"
            role="dialog"
            aria-modal="true"
            aria-label={t("docker.createForm.title")}
          >
        <Card
          className="create-modal"
          title={t("docker.createForm.title")}
          action={
            <div className="row create-modal-actions">
              {creatingTask && (
                <span className="create-modal-status">
                  <LoaderCircle size={12} className="create-spinner" />
                  {t("docker.creating")}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<ChevronDown size={13} />}
                onClick={() => setShowCreate(false)}
              >
                {t("docker.createCollapse")}
              </Button>
            </div>
          }
        >
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
          <div className="create-modal-checks">
            <label className="row">
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
            <label className="row">
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
            <div className="create-modal-check">
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.cleanTraces !== false}
                  onChange={(e) => setForm((f) => ({ ...f, cleanTraces: e.target.checked }))}
                />
                {t("docker.cleanTraces")}
              </label>
              <div className="muted create-check-hint">
                {t("docker.cleanTracesHint")}
              </div>
            </div>
            <div className="create-modal-check">
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.gpuPassthrough === true}
                  onChange={(e) => setForm((f) => ({ ...f, gpuPassthrough: e.target.checked }))}
                />
                {t("docker.gpuPassthrough")}
              </label>
              <div className="muted create-check-hint">
                {t("docker.gpuPassthroughHint")}
              </div>
            </div>
          </div>
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
                  {!!form.installLsposed && (
                    <>
                      <label className="row" style={{ marginBottom: 8, marginLeft: 20 }}>
                        <input
                          type="checkbox"
                          checked={!!form.installCloak}
                          onChange={(e) => setForm({ ...form, installCloak: e.target.checked })}
                        />
                        {t("docker.cloakDeepSpoof")}
                      </label>
                      {form.installCloak && (
                        <div className="muted" style={{ fontSize: 11, marginLeft: 20, marginBottom: 8 }}>
                          {t("docker.cloakNote")}
                        </div>
                      )}
                    </>
                  )}
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
                  <div style={{ marginBottom: 8 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      {t("docker.spoofSectionTitle")}
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                        <span className="muted" style={{ fontSize: 10 }}>{t("docker.spoofBrand")}</span>
                        <select
                          value={selectedSpoofBrand}
                          onChange={(e) => {
                            const brand = e.target.value;
                            const first = spoofProfiles.find((p) => p.brand === brand);
                            setForm((f) => ({ ...f, spoofProfileId: first?.id ?? "" }));
                          }}
                        >
                          {spoofBrands.map((brand) => (
                            <option key={brand} value={brand}>{brand}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
                        <span className="muted" style={{ fontSize: 10 }}>{t("docker.spoofModel")}</span>
                        <select
                          value={form.spoofProfileId || ""}
                          onChange={(e) => setForm((f) => ({ ...f, spoofProfileId: e.target.value }))}
                        >
                          <option value="">{t("docker.spoofCustomConf")}</option>
                          {spoofBuiltinForBrand.length > 0 && (
                            <optgroup label={t("docker.spoofGroupBuiltin")}>
                              {spoofBuiltinForBrand.map((p) => (
                                <option key={p.id} value={p.id}>{p.model} · {p.marketName}</option>
                              ))}
                            </optgroup>
                          )}
                          {spoofCapturedForBrand.length > 0 && (
                            <optgroup label={t("docker.spoofGroupCaptured")}>
                              {spoofCapturedForBrand.map((p) => (
                                <option key={p.id} value={p.id}>{p.model} · {p.marketName}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </label>
                    </div>
                    {selectedSpoofProfile ? (
                      <div className="mono muted" style={{ fontSize: 11, lineHeight: 1.6, wordBreak: "break-all" }}>
                        <div>{selectedSpoofProfile.marketName}</div>
                        <div>{selectedSpoofProfile.model} · Android {selectedSpoofProfile.androidVersion} · {selectedSpoofProfile.securityPatch}</div>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={selectedSpoofProfile.fingerprint}>
                          {selectedSpoofProfile.fingerprint}
                        </div>
                        <div style={{ marginTop: 2 }}>{t("docker.spoofUsageCount", { n: selectedProfileUsage })}</div>
                        {selectedProfileUsage >= SPOOF_USAGE_WARN_THRESHOLD && (
                          <div style={{ color: "var(--warning)", fontSize: 11, marginTop: 2 }}>
                            {t("docker.spoofUsageWarn", { n: selectedProfileUsage })}
                          </div>
                        )}
                        {selectedSpoofProfile.notes?.includes("构造") ? (
                          <div className="bad" style={{ fontSize: 11, marginTop: 2 }}>
                            {t("docker.spoofConstructedHint")}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <>
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
                    <label className="row" style={{ marginTop: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!form.spoofAbilist}
                        onChange={(e) => setForm((f) => ({ ...f, spoofAbilist: e.target.checked }))}
                      />
                      {t("docker.spoofAbilist")}
                    </label>
                    {form.spoofAbilist && (
                      <div className="bad" style={{ fontSize: 11, marginTop: 4 }}>
                        {t("docker.spoofAbilistWarning")}
                      </div>
                    )}
                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      {t("docker.spoofBoundary")}
                    </div>
                  </div>
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
                createCancelRequestedRef.current = false;
                setCreatingTask({
                  name: form.name.trim(),
                  containerName: createContainerName(form.name),
                  image: form.image,
                  adbPort: form.adbPort,
                  stage: t("docker.probingDocker"),
                  cancelRequested: false,
                });
                setBusy("create");
                setStatusText(t("docker.probingDocker"));
                const dockerHit = await probeTool("docker", settings?.dockerPath);
                if (!dockerHit.ok) {
                  setStatusText(t("docker.dockerUnavailableShort"));
                  void alert(
                    t("docker.dockerUnavailableAlert", { text: dockerHit.text }),
                  );
                  setCreatingTask(null);
                  setBusy(null);
                  return;
                }
                if (createCancelRequestedRef.current) {
                  setCreatingTask(null);
                  setBusy(null);
                  setStatusText(t("docker.createCancelled"));
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
                    setCreatingTask(null);
                    setBusy(null);
                    return;
                  }
                }
                if (createCancelRequestedRef.current) {
                  setCreatingTask(null);
                  setBusy(null);
                  setStatusText(t("docker.createCancelled"));
                  return;
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
                  if (createCancelRequestedRef.current || r.exitCode === -2) {
                    // The backend normally cleans up as soon as it observes the
                    // cancellation flag.  A cancel request can, however, arrive
                    // just after the final backend checkpoint and before this
                    // promise resolves.  Repeat the idempotent cleanup here so a
                    // late cancellation cannot leave a just-created container.
                    if (createCancelRequestedRef.current && r.exitCode !== -2) {
                      const cleanup = await DeviceService.cancelCreateInstance(form.name);
                      if (!cleanup.success) {
                        throw new Error(
                          cleanup.stderr || cleanup.stdout || t("docker.cancelCreateFailed"),
                        );
                      }
                    }
                    await load();
                    setCreatingTask(null);
                    setStatusText(t("docker.createCancelled"));
                    return;
                  }
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
                        lastSpoofProfileId: form.spoofProfileId,
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
                    setCreatingTask(null);
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
                  setCreatingTask(null);
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
                  setCreatingTask(null);
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
        </div>
      )}

      <div className="grid-2">
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
          {loading && !info ? (
            <Skeleton count={4} height={40} />
          ) : redroids.length === 0 && !creatingTask ? (
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
              {creatingTask && (
                <CreatingInstanceRow
                  task={creatingTask}
                  dialogOpen={showCreate}
                  cancelBusy={cancelCreateBusy}
                  onContinue={() => setShowCreate(true)}
                  onCancel={() => void cancelCreatingInstance()}
                />
              )}
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

function CreatingInstanceRow({
  task,
  dialogOpen,
  cancelBusy,
  onContinue,
  onCancel,
}: {
  task: CreatingInstanceTask;
  dialogOpen: boolean;
  cancelBusy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const serial = `127.0.0.1:${task.adbPort}`;

  return (
    <div className="instance-row creating-instance-row" aria-busy="true">
      <div className="creating-instance-copy">
        <div className="row creating-instance-title">
          <LoaderCircle size={14} className="create-spinner" />
          <strong>{task.name}</strong>
          <span className="badge info">{t("docker.creating")}</span>
        </div>
        <div className="muted mono">{task.containerName} · ADB {serial}</div>
        <div className="creating-instance-stage">{task.stage || t("common.loading")}</div>
        <div className="muted mono">{task.image}</div>
      </div>
      <div className="row creating-instance-actions">
        {!dialogOpen && !task.cancelRequested && (
          <Button
            size="sm"
            variant="ghost"
            icon={<ChevronUp size={13} />}
            onClick={onContinue}
          >
            {t("docker.createExpand")}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={13} />}
          loading={cancelBusy || task.cancelRequested}
          onClick={onCancel}
        >
          {task.cancelRequested ? t("docker.cancellingCreate") : t("docker.cancelCreate")}
        </Button>
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
