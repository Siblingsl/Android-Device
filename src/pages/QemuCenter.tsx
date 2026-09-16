import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService, QemuService } from "../services/deviceService";
import { useAppStore } from "../stores/appStore";
import { askConfirm } from "../lib/dialogs";
import { copyText } from "../lib/clipboard";
import { createRequestSequence } from "../lib/requestSequence";
import { tStatic, useI18n } from "../i18n";
import type {
  QemuDoctorReport,
  QemuRedroidInstance,
  QemuVerifyReport,
  QemuVmEntry,
  QemuRedroidCreateRequest,
  MagiskAssets,
  SpoofProfileSummary,
} from "../types";

/** Max lines kept in the log panel (oldest dropped). */
const LOG_LINE_LIMIT = 400;
/** Chunk length of the optional `guest wait` loop (cancelable between chunks). */
const WAIT_CHUNK_SECS = 15;
/** Total budget for the post-create SSH wait. */
const WAIT_TOTAL_SECS = 600;
/** Doctor re-poll cadence while a setup runs Rust-side (read-only, harmless). */
const SETUP_POLL_MS = 30_000;
/** Default cloud image distro passed to `setup image|all`. */
const DEFAULT_DISTRO = "noble";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type NodeForm = {
  name: string;
  cpus: string;
  memMib: string;
  diskGib: string;
  adbPortCount: string;
  autoSetup: boolean;
};

type InstanceForm = {
  name: string;
  cpus: string;
  memoryMib: string;
  width: string;
  height: string;
  dpi: string;
  image: string;
  androidVersion: string;
  installGapps: boolean;
  gappsZip: string;
  installMagisk: boolean;
  installLsposed: boolean;
  installShamiko: boolean;
  installCloak: boolean;
  installNativeCloak: boolean;
  nativeCloakZip: string;
  moduleZips: string;
  spoofProfileId: string;
  spoofProfile: string;
  spoofAbilist: boolean;
  hidePackages: string;
  cleanTraces: boolean;
};

const initialNodeForm: NodeForm = {
  name: "node1",
  cpus: "4",
  memMib: "4096",
  diskGib: "40",
  adbPortCount: "32",
  autoSetup: true,
};

const initialInstanceForm: InstanceForm = {
  name: "r1",
  cpus: "1",
  memoryMib: "2048",
  width: "720",
  height: "1280",
  dpi: "320",
  image: "",
  androidVersion: "14",
  installGapps: false,
  gappsZip: "",
  installMagisk: false,
  installLsposed: false,
  installShamiko: false,
  installCloak: false,
  installNativeCloak: false,
  nativeCloakZip: "",
  moduleZips: "",
  spoofProfileId: "",
  spoofProfile: "",
  spoofAbilist: false,
  hidePackages: "",
  cleanTraces: false,
};

function doctorBadgeClass(status: string): string {
  if (status === "ok") return "badge success";
  if (status === "fail") return "badge danger";
  return "badge warn";
}

function verdictBadgeClass(verdict: string): string {
  if (verdict === "PASS") return "badge success";
  if (verdict === "FAIL") return "badge danger";
  return "badge warn";
}

/** i18n keys used to render the setup step name in the pending-task banner. */
const STEP_LABEL_KEYS: Record<string, string> = {
  all: "qemu.env.setupAll",
  whpx: "qemu.env.setupWhpx",
  qemu: "qemu.env.setupQemu",
  image: "qemu.env.setupImage",
};

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function QemuCenterPage() {
  const { t } = useI18n();

  const [doctor, setDoctor] = useState<QemuDoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(true);
  const [doctorError, setDoctorError] = useState("");
  const [vms, setVms] = useState<QemuVmEntry[]>([]);
  const [vmsLoading, setVmsLoading] = useState(true);
  const [selectedVm, setSelectedVm] = useState("");
  const [instances, setInstances] = useState<QemuRedroidInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [verify, setVerify] = useState<QemuVerifyReport | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyVm, setVerifyVm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [showNodeForm, setShowNodeForm] = useState(false);
  const [showInstanceForm, setShowInstanceForm] = useState(false);
  const [nodeForm, setNodeForm] = useState<NodeForm>(initialNodeForm);
  const [instanceForm, setInstanceForm] = useState<InstanceForm>(initialInstanceForm);
  const [upgradeTarget, setUpgradeTarget] = useState<QemuRedroidInstance | null>(null);
  const [presetAssets, setPresetAssets] = useState<MagiskAssets | null>(null);
  const [spoofProfiles, setSpoofProfiles] = useState<SpoofProfileSummary[]>([]);
  const [presetAssetError, setPresetAssetError] = useState("");
  const presetBusyRef = useRef(false);
  const [createdSerial, setCreatedSerial] = useState("");
  const [waitingVm, setWaitingVm] = useState("");
  const [waitRemaining, setWaitRemaining] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const waitCancelRef = useRef(false);
  /** True while this mount is alive; gates every post-await local setState. */
  const mountedRef = useRef(true);
  const logRef = useRef<HTMLPreElement>(null);
  const loadSequence = useRef(createRequestSequence()).current;

  // Cross-page setup/hold state (zustand): survives switching away and back.
  const qemuSetup = useAppStore((s) => s.qemuSetup);
  const setQemuSetup = useAppStore((s) => s.setQemuSetup);
  const qemuWaitVm = useAppStore((s) => s.qemuWaitVm);
  const setQemuWaitVm = useAppStore((s) => s.setQemuWaitVm);

  /**
   * Busy key derived from the global store, so a setup started before a page
   * switch still renders its loading state after coming back. Local `busy`
   * wins (page-scoped actions) and falls back to the global setup flag.
   */
  const setupLocked = Boolean(qemuSetup?.running);
  const setupBusyKey = qemuSetup?.running ? `setup-${qemuSetup.step}` : null;
  const busyKey = busy ?? setupBusyKey;

  const appendLog = useCallback((lines: string[]) => {
    if (!lines.length) return;
    setLogs((previous) => {
      const next = [...previous, ...lines];
      return next.length > LOG_LINE_LIMIT ? next.slice(next.length - LOG_LINE_LIMIT) : next;
    });
  }, []);

  const logCommand = useCallback(
    (args: string[]) => appendLog([tStatic("qemu.log.line", { args: args.join(" ") })]),
    [appendLog],
  );

  const logOutput = useCallback(
    (stdout: string, stderr: string, success: boolean) => {
      const lines: string[] = [];
      if (stdout.trim()) lines.push(...stdout.trimEnd().split(/\r?\n/));
      if (stderr.trim()) lines.push(...stderr.trimEnd().split(/\r?\n/));
      if (!lines.length) lines.push(success ? "(no output)" : "(no output, non-zero exit)");
      appendLog(lines);
    },
    [appendLog],
  );

  const loadDoctor = useCallback(async (quiet = false) => {
    if (!quiet) {
      setDoctorLoading(true);
      setDoctorError("");
    }
    try {
      const report = await QemuService.doctor();
      if (!mountedRef.current) return;
      setDoctor(report);
      setDoctorError("");
      if (!quiet) {
        appendLog([`$ qemu-center doctor --json`]);
        appendLog(report.checks.map((c) => `[${c.status}] ${c.id}: ${c.detail || c.title}`));
      }
    } catch (error) {
      if (!mountedRef.current) return;
      // Quiet polls keep the last good report on transient failures.
      if (!quiet) {
        setDoctor(null);
        setDoctorError(errText(error));
      }
    } finally {
      if (!quiet && mountedRef.current) setDoctorLoading(false);
    }
  }, [appendLog]);

  const loadVms = useCallback(
    async (keepSelection = false, quiet = false) => {
      const token = loadSequence.begin();
      setVmsLoading(true);
      try {
        const list = await QemuService.vmList();
        if (!loadSequence.isCurrent(token)) return;
        setVms(list);
        if (!quiet) {
          appendLog([`$ qemu-center vm list --json`, `${list.length} node(s)`]);
        }
        setSelectedVm((current) => {
          if (keepSelection && current && list.some((v) => v.name === current)) return current;
          return list.length ? list[0].name : "";
        });
        setVerifyVm((current) => {
          if (current && list.some((v) => v.name === current)) return current;
          return list.length ? list[0].name : "";
        });
      } catch (error) {
        if (!loadSequence.isCurrent(token)) return;
        setStatusText(tStatic("qemu.refreshFailed", { msg: errText(error) }));
      } finally {
        if (loadSequence.isCurrent(token)) setVmsLoading(false);
      }
    },
    [appendLog, loadSequence],
  );

  const loadInstances = useCallback(
    async (vm: string, quiet = false) => {
      if (!vm) {
        setInstances([]);
        return;
      }
      setInstancesLoading(true);
      try {
        const list = await QemuService.redroidList(vm);
        setInstances(list);
        if (!quiet) {
          appendLog([`$ qemu-center redroid list ${vm} --json`, `${list.length} instance(s)`]);
        }
      } catch (error) {
        setInstances([]);
        if (!quiet) appendLog([errText(error)]);
      } finally {
        setInstancesLoading(false);
      }
    },
    [appendLog],
  );

  useEffect(() => {
    void loadDoctor();
    void loadVms(false, true);
  }, [loadDoctor, loadVms]);

  useEffect(() => {
    if (!showInstanceForm) return;
    let alive = true;
    setPresetAssetError("");
    void Promise.allSettled([
      DeviceService.getLocalGappsPath(), DeviceService.getMagiskAssets(), DeviceService.listSpoofProfiles(),
    ]).then(([gapps, assets, profiles]) => {
      if (!alive) return;
      if (gapps.status === "fulfilled") setInstanceForm((form) => ({ ...form, gappsZip: form.gappsZip || gapps.value }));
      if (assets.status === "fulfilled") setPresetAssets(assets.value);
      if (profiles.status === "fulfilled") setSpoofProfiles(profiles.value);
      const errors = [gapps, assets, profiles].filter((result) => result.status === "rejected").map((result) => errText((result as PromiseRejectedResult).reason));
      setPresetAssetError(errors.join("\n"));
    });
    return () => { alive = false; };
  }, [showInstanceForm]);

  const updatePreset = (field: keyof InstanceForm, value: string | boolean) => {
    setInstanceForm((form) => {
      const next = { ...form, [field]: value };
      if (!next.installMagisk) {
        next.installLsposed = next.installShamiko = next.installCloak = next.installNativeCloak = false;
        next.moduleZips = next.spoofProfileId = next.spoofProfile = next.hidePackages = "";
        next.spoofAbilist = next.cleanTraces = false;
      }
      if (!next.installLsposed) next.installCloak = false;
      if (!next.spoofProfileId && !next.spoofProfile.trim()) next.spoofAbilist = next.cleanTraces = false;
      return next;
    });
  };

  /**
   * While a setup runs Rust-side (possibly started on a previous visit), poll
   * doctor so the environment card converges on fresh data; doctor is a
   * read-only check and safe to run concurrently with the setup CLI. The
   * elapsed-minutes label in the pending banner re-renders on the same tick.
   */
  useEffect(() => {
    if (!setupLocked) return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
      void loadDoctor(true);
    }, SETUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [setupLocked, loadDoctor]);

  /**
   * Completion detection: runSetup clears the global flag in its finally
   * (even unmounted), so a running→idle transition seen here means the setup
   * finished while we were mounted (or just now). One final loud doctor run.
   */
  const prevSetupRunningRef = useRef(false);
  useEffect(() => {
    const running = Boolean(qemuSetup?.running);
    const wasRunning = prevSetupRunningRef.current;
    prevSetupRunningRef.current = running;
    if (wasRunning && !running) void loadDoctor();
  }, [qemuSetup?.running, loadDoctor]);

  useEffect(() => {
    setUpgradeTarget(null);
    setShowInstanceForm(false);
    if (!selectedVm) {
      setInstances([]);
      return;
    }
    void loadInstances(selectedVm, true);
  }, [selectedVm, loadInstances]);

  useEffect(() => {
    if (logOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, logOpen]);

  // Mark this mount dead and stop the chunked guest-wait loop on unmount.
  // The qemuWaitVm flag intentionally survives so the next visit shows the
  // honest "wait was interrupted" hint instead of a fake recovery.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      waitCancelRef.current = true;
    };
  }, []);

  /** Poll guest SSH in short chunks so [取消等待] really stops the loop. */
  const waitForGuest = useCallback(
    async (vm: string) => {
      waitCancelRef.current = false;
      // True when this loop was stopped by a page switch (not by the user
      // and not by completion): keep the global flag so the next visit of the
      // page shows the honest "wait interrupted" hint instead of fake state.
      let interruptedByUnmount = false;
      const deadline = Date.now() + WAIT_TOTAL_SECS * 1000;
      setWaitingVm(vm);
      setQemuWaitVm(vm);
      setWaitRemaining(WAIT_TOTAL_SECS);
      setStatusText(tStatic("qemu.nodes.wait.title"));
      logCommand(["guest", "wait", vm, "--timeout-secs", String(WAIT_TOTAL_SECS)]);
      try {
        while (Date.now() < deadline) {
          if (waitCancelRef.current) {
            if (mountedRef.current) {
              setStatusText(tStatic("qemu.nodes.wait.cancelled"));
              appendLog([tStatic("qemu.nodes.wait.cancelled")]);
            } else {
              interruptedByUnmount = true;
            }
            return;
          }
          const chunk = Math.min(WAIT_CHUNK_SECS, Math.ceil((deadline - Date.now()) / 1000));
          if (chunk <= 0) break;
          setWaitRemaining(chunk);
          const result = await QemuService.guestWait(vm, chunk);
          if (!mountedRef.current) {
            interruptedByUnmount = true;
            return;
          }
          if (result.stdout.trim()) appendLog(result.stdout.trimEnd().split(/\r?\n/));
          if (result.success) {
            setStatusText(tStatic("qemu.nodes.wait.ok"));
            appendLog([tStatic("qemu.nodes.wait.ok")]);
            await loadVms(true, true);
            await loadInstances(vm, true);
            return;
          }
        }
        if (mountedRef.current) {
          setStatusText(tStatic("qemu.nodes.wait.failed"));
          appendLog([tStatic("qemu.nodes.wait.failed")]);
        }
      } catch (error) {
        if (mountedRef.current) {
          setStatusText(errText(error));
          appendLog([errText(error)]);
        }
      } finally {
        if (mountedRef.current) {
          setWaitingVm("");
          setWaitRemaining(0);
          setQemuWaitVm(null);
        } else if (!interruptedByUnmount) {
          // Ended on its own (success/timeout/error) while unmounted: the
          // flag must not claim an interrupted wait that no longer exists.
          setQemuWaitVm(null);
        }
      }
    },
    [appendLog, loadInstances, loadVms, logCommand, setQemuWaitVm],
  );

  const runSetup = async (step: "whpx" | "qemu" | "image" | "all") => {
    // Re-entry guard: a second parallel `setup all` would deadlock winget/DISM.
    // Reads the store directly so it also covers the sub-frame race between
    // flag-set and re-render (double-click before the buttons go disabled).
    if (useAppStore.getState().qemuSetup?.running) {
      setStatusText(t("qemu.env.setupAlreadyRunning"));
      return;
    }
    setBusy(`setup-${step}`);
    // Global flag first: it must already be set if the user switches pages
    // while the Rust CLI child keeps running after this component unmounts.
    setQemuSetup({ running: true, step, startedAt: Date.now() });
    setStatusText(t("qemu.env.setupRunning"));
    const stepArgs =
      step === "whpx" || step === "qemu"
        ? ["setup", step]
        : ["setup", step, "--distro", DEFAULT_DISTRO];
    logCommand(stepArgs);
    try {
      const result = await QemuService.setup(step, DEFAULT_DISTRO);
      if (!mountedRef.current) return; // global cleanup still runs in finally
      logOutput(result.stdout, result.stderr, result.success);
      const rebootHint = /reboot|重启/i.test(result.stdout);
      if (!result.success) {
        setStatusText(t("qemu.env.setupFailed"));
      } else if (step === "all" || step === "whpx") {
        setStatusText(rebootHint ? t("qemu.env.setupDoneReboot") : t("qemu.env.setupDone"));
      } else {
        setStatusText(t("qemu.env.setupDone"));
      }
    } catch (error) {
      if (!mountedRef.current) return;
      appendLog([errText(error)]);
      setStatusText(t("qemu.env.setupFailed"));
    } finally {
      // Unconditional global clear — even unmounted, the flag must never stay
      // locked, otherwise re-mounting the page would show a phantom banner.
      setQemuSetup(null);
      if (mountedRef.current) setBusy(null);
    }
  };

  const createNode = async () => {
    const name = nodeForm.name.trim();
    if (!NAME_PATTERN.test(name)) {
      setStatusText(t("qemu.nodes.form.nameInvalid"));
      return;
    }
    setBusy("node-create");
    setStatusText(t("qemu.nodes.creating", { name }));
    const request = {
      name,
      imagePath: "",
      cpus: Number(nodeForm.cpus) || 0,
      memMib: Number(nodeForm.memMib) || 0,
      diskGib: Number(nodeForm.diskGib) || 0,
      adbPortCount: Number(nodeForm.adbPortCount) || 0,
      autoSetup: nodeForm.autoSetup,
    };
    logCommand([
      "vm",
      "create",
      name,
      "--image",
      "<default>",
      "--cpus",
      String(request.cpus),
      "--mem",
      String(request.memMib),
      "--disk-gib",
      String(request.diskGib),
      "--adb-port-count",
      String(request.adbPortCount),
      ...(request.autoSetup ? ["--auto-setup"] : []),
    ]);
    try {
      const result = await QemuService.vmCreate(request);
      logOutput(result.stdout, result.stderr, result.success);
      if (!result.success) {
        // A bare "failed" hid the real cause (e.g. ssh-keygen's "No such file
        // or directory") in the log panel — surface the CLI's own stderr line.
        // Mirrors Rust's stderr_last_line(): last non-empty line, trimmed.
        const errLine = result.stderr
          .split(/\r?\n/)
          .reverse()
          .find((line) => line.trim())
          ?.trim();
        setStatusText(
          t("qemu.nodes.createFailed", { msg: errLine || `exit ${result.exitCode}` }),
        );
        return;
      }
      setStatusText(t("qemu.nodes.created", { name }));
      setShowNodeForm(false);
      await loadVms(true, true);
      setSelectedVm(name);
      void waitForGuest(name);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(t("qemu.nodes.createFailed", { msg: errText(error) }));
    } finally {
      setBusy(null);
    }
  };

  const vmAction = async (
    action: "start" | "stop" | "delete" | "verify",
    name: string,
  ) => {
    if (presetBusyRef.current) return;
    if (action === "delete") {
      if (!(await askConfirm(t("qemu.nodes.deleteConfirm", { name })))) return;
    }
    if (action === "verify") {
      setVerifyVm(name);
      setSelectedVm(name);
      void runVerify(name);
      return;
    }
    setBusy(`${action}-${name}`);
    logCommand(action === "delete" ? ["vm", "delete", name, "--purge"] : ["vm", action, name]);
    try {
      const result =
        action === "start"
          ? await QemuService.vmStart(name)
          : action === "stop"
            ? await QemuService.vmStop(name)
            : await QemuService.vmDelete(name, true);
      logOutput(result.stdout, result.stderr, result.success);
      if (result.success) {
        if (action === "start") setStatusText(t("qemu.nodes.started", { name }));
        else if (action === "stop") setStatusText(t("qemu.nodes.stopped"));
        else setStatusText(t("qemu.nodes.deleted", { name }));
      } else {
        setStatusText(result.stderr.trim() || result.stdout.trim() || t("qemu.nodes.actionFailed"));
      }
      await loadVms(true, true);
      if (action === "delete" && selectedVm === name) setInstances([]);
      if (action !== "delete") await loadInstances(name, true);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setBusy(null);
    }
  };

  /** Sanitize a snapshot tag exactly like the CLI's validate_snapshot_tag. */
  const cleanTag = (raw: string): string =>
    raw.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32);

  const snapshotVm = async (vm: QemuVmEntry) => {
    const raw = window.prompt(t("qemu.nodes.snapshotPrompt", { name: vm.name }), "");
    if (!raw) return;
    const tag = cleanTag(raw);
    if (!tag) {
      setStatusText(t("qemu.nodes.tagInvalid"));
      return;
    }
    setBusy(`snapshot-${vm.name}`);
    logCommand(["vm", "snapshot", vm.name, tag]);
    try {
      const result = await QemuService.vmSnapshot(vm.name, tag);
      logOutput(result.stdout, result.stderr, result.success);
      setStatusText(
        result.success ? t("qemu.nodes.snapshotDone", { tag }) : t("qemu.nodes.snapshotFailed"),
      );
      await loadVms(true, true);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setBusy(null);
    }
  };

  const restoreVm = async (vm: QemuVmEntry) => {
    const tags = vm.snapshots ?? [];
    if (!tags.length) {
      setStatusText(t("qemu.nodes.noSnapshots"));
      return;
    }
    // Restore rolls the disk back: everything after the snapshot is lost and
    // the VM must be stopped (qemu-img refuses locked images anyway).
    if (!(await askConfirm(t("qemu.nodes.restoreConfirm", { name: vm.name, tags: tags.join(", ") })))) {
      return;
    }
    const raw = window.prompt(t("qemu.nodes.restorePrompt", { tags: tags.join(", ") }), tags[tags.length - 1]);
    if (!raw) return;
    const tag = cleanTag(raw);
    if (!tags.includes(tag)) {
      setStatusText(t("qemu.nodes.tagUnknown", { tag }));
      return;
    }
    setBusy(`restore-${vm.name}`);
    logCommand(["vm", "restore", vm.name, tag]);
    try {
      const result = await QemuService.vmRestore(vm.name, tag);
      logOutput(result.stdout, result.stderr, result.success);
      setStatusText(
        result.success ? t("qemu.nodes.restoreDone", { tag }) : t("qemu.nodes.restoreFailed"),
      );
      await loadVms(true, true);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setBusy(null);
    }
  };

  const createInstance = async () => {
    const vm = selectedVm;
    if (!vm || busyKey || presetBusyRef.current) return;
    const name = instanceForm.name.trim();
    if (!NAME_PATTERN.test(name)) {
      setStatusText(t("qemu.instances.form.nameInvalid"));
      return;
    }
    if (instanceForm.installGapps && !instanceForm.gappsZip.trim()) {
      setStatusText(t("qemu.presets.gappsRequired"));
      return;
    }
    if (instanceForm.installMagisk && presetAssets && (!presetAssets.magiskOk || (instanceForm.installLsposed && !presetAssets.lsposedOk) || (instanceForm.installShamiko && !presetAssets.shamikoOk))) {
      setStatusText(t("qemu.presets.assetsMissing"));
      return;
    }
    presetBusyRef.current = true;
    if (upgradeTarget && !(await askConfirm(t("qemu.presets.upgradeConfirm", { name })))) {
      presetBusyRef.current = false;
      return;
    }
    setBusy(`instance-create-${vm}`);
    setStatusText(t("qemu.presets.running"));
    const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const request: QemuRedroidCreateRequest = {
      vm,
      name,
      cpus: Number(instanceForm.cpus) || 0,
      memoryMib: Number(instanceForm.memoryMib) || 0,
      width: Number(instanceForm.width) || 0,
      height: Number(instanceForm.height) || 0,
      dpi: Number(instanceForm.dpi) || 0,
      androidVersion: instanceForm.androidVersion.trim() || undefined,
      image: instanceForm.image.trim() || undefined,
      installGapps: instanceForm.installGapps,
      gappsZip: instanceForm.installGapps ? instanceForm.gappsZip.trim() : undefined,
      installMagisk: instanceForm.installMagisk,
      installLsposed: instanceForm.installLsposed,
      installShamiko: instanceForm.installShamiko,
      installCloak: instanceForm.installCloak,
      installNativeCloak: instanceForm.installNativeCloak,
      nativeCloakZip: instanceForm.installNativeCloak ? instanceForm.nativeCloakZip.trim() || undefined : undefined,
      moduleZips: lines(instanceForm.moduleZips),
      spoofProfileId: instanceForm.spoofProfileId.trim() || undefined,
      spoofProfile: instanceForm.spoofProfileId.trim() ? undefined : instanceForm.spoofProfile.trim() || undefined,
      spoofAbilist: instanceForm.spoofAbilist,
      hidePackages: lines(instanceForm.hidePackages),
      cleanTraces: instanceForm.cleanTraces,
    };
    logCommand([
      "redroid",
      upgradeTarget ? "upgrade" : "create",
      vm,
      name,
      "--cpus",
      String(request.cpus),
      "--memory",
      String(request.memoryMib),
      "--width",
      String(request.width),
      "--height",
      String(request.height),
      "--dpi",
      String(request.dpi),
    ]);
    try {
      const result = await (upgradeTarget ? QemuService.redroidUpgrade(request) : QemuService.redroidCreate(request));
      logOutput(result.stdout, result.stderr, result.success);
      if (!result.success) {
        setStatusText(result.stderr.trim() || result.stdout.trim() || t("qemu.instances.createFailed"));
        return;
      }
      const list = await QemuService.redroidList(vm);
      setInstances(list);
      const created = list.find((entry) => entry.instance === name);
      const serial =
        created?.serial || result.stdout.match(/127\.0\.0\.1:\d+/)?.[0] || "";
      setCreatedSerial(serial);
      setStatusText(t(upgradeTarget ? "qemu.presets.upgraded" : "qemu.instances.created", { name, serial: serial || "-" }));
      setShowInstanceForm(false);
      setUpgradeTarget(null);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setBusy(null);
      presetBusyRef.current = false;
    }
  };

  const restoreInstance = async (instance: QemuRedroidInstance) => {
    if (!instance.rollbackAvailable || busyKey || presetBusyRef.current) return;
    presetBusyRef.current = true;
    try {
      if (!(await askConfirm(t("qemu.presets.restoreConfirm", { name: instance.instance })))) return;
      setBusy(`instance-restore-${instance.instance}`);
      setStatusText(t("qemu.presets.running"));
      const result = await QemuService.redroidRestore(selectedVm, instance.instance);
      logOutput(result.stdout, result.stderr, result.success);
      setStatusText(result.success ? t("qemu.presets.restored", { name: instance.instance }) : result.stderr.trim() || result.stdout.trim() || t("qemu.instances.createFailed"));
      if (result.success) await loadInstances(selectedVm, true);
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setBusy(null);
      presetBusyRef.current = false;
    }
  };

  const runVerify = async (vm: string) => {
    if (!vm) return;
    setVerifyLoading(true);
    setStatusText(t("qemu.verify.running"));
    logCommand(["verify", "--json", "--vm", vm]);
    try {
      const report = await QemuService.verify(vm);
      setVerify(report);
      appendLog(report.checks.map((c) => `[${c.verdict}] ${c.id}: ${c.detail}`));
      const counts = report.checks.reduce(
        (acc, c) => {
          if (c.verdict === "PASS") acc.pass += 1;
          else if (c.verdict === "FAIL") acc.fail += 1;
          else acc.untested += 1;
          return acc;
        },
        { pass: 0, fail: 0, untested: 0 },
      );
      setStatusText(
        t("qemu.verify.summary", {
          pass: counts.pass,
          fail: counts.fail,
          untested: counts.untested,
        }),
      );
    } catch (error) {
      appendLog([errText(error)]);
      setStatusText(errText(error));
    } finally {
      setVerifyLoading(false);
    }
  };

  const copySerial = async (serial: string) => {
    try {
      await copyText(serial);
      setStatusText(t("qemu.instances.copied", { serial }));
    } catch (error) {
      setStatusText(errText(error));
    }
  };

  const adbBlockLabel = (vm: QemuVmEntry) => {
    if (!vm.adbPorts.length) return "-";
    return `${vm.adbPorts[0]}..=${vm.adbPorts[vm.adbPorts.length - 1]}`;
  };

  const waitLabel = waitingVm
    ? `${t("qemu.nodes.wait.title")} · ${t("qemu.nodes.wait.remaining", { secs: waitRemaining })}`
    : "";

  return (
    <div className="page-qemu">
      <div className="page-header">
        <div>
          <div className="page-title">
            <Server size={16} strokeWidth={2} /> {t("qemu.title")}
          </div>
          <div className="page-subtitle">{t("qemu.subtitle")}</div>
        </div>
        <div className="row">
          <Button icon={<RefreshCw size={15} />} onClick={() => void loadVms(true)}>
            {t("common.refresh")}
          </Button>
          <Button
            icon={<Server size={15} />}
            loading={doctorLoading}
            onClick={() => void loadDoctor()}
          >
            {t("qemu.env.refresh")}
          </Button>
        </div>
      </div>

      {/* Pending-setup banner: the Rust CLI keeps running across page
          switches; this restores the loading truth after coming back. */}
      {qemuSetup?.running ? (
        <div className="notice qemu-setup-pending" role="alert">
          <LoaderCircle size={14} className="create-spinner" />
          <span className="qemu-setup-pending-text">
            {t("qemu.env.setupPendingBanner", {
              step: t(STEP_LABEL_KEYS[qemuSetup.step] ?? "qemu.env.setupAll"),
              minutes:
                Math.floor((nowTick - qemuSetup.startedAt) / 60_000) < 1
                  ? "<1"
                  : String(Math.floor((nowTick - qemuSetup.startedAt) / 60_000)),
            })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void loadDoctor()}>
            {t("qemu.env.refresh")}
          </Button>
        </div>
      ) : null}

      <div className="notice qemu-experimental" role="status">
        {t("qemu.experimental")}
      </div>

      {doctorError ? (
        <div className="notice qemu-cli-missing" role="alert">
          {t("qemu.cliMissing")}
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
            {doctorError}
          </div>
        </div>
      ) : null}

      {/* ---------------- Environment readiness ---------------- */}
      <Card
        title={t("qemu.env.title")}
        action={
          <div className="row qemu-card-actions">
            <Button
              size="sm"
              disabled={setupLocked}
              loading={busyKey === "setup-whpx"}
              title={t("qemu.env.setupWhpxHint")}
              onClick={() => void runSetup("whpx")}
            >
              {t("qemu.env.setupWhpx")}
            </Button>
            <Button
              size="sm"
              disabled={setupLocked}
              loading={busyKey === "setup-qemu"}
              title={t("qemu.env.setupQemuHint")}
              onClick={() => void runSetup("qemu")}
            >
              {t("qemu.env.setupQemu")}
            </Button>
            <Button
              size="sm"
              disabled={setupLocked}
              loading={busyKey === "setup-image"}
              onClick={() => void runSetup("image")}
            >
              {t("qemu.env.setupImage")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ShieldCheck size={13} />}
              disabled={setupLocked}
              loading={busyKey === "setup-all"}
              onClick={() => void runSetup("all")}
            >
              {t("qemu.env.setupAll")}
            </Button>
          </div>
        }
      >
        {doctorLoading && !doctor ? (
          <Skeleton height={90} />
        ) : doctor ? (
          <div className="stack qemu-check-list">
            {doctor.checks.map((check) => (
              <div key={check.id} className="qemu-check-row">
                <span className={doctorBadgeClass(check.status)}>
                  {t(`qemu.env.status.${check.status === "ok" ? "ok" : check.status === "fail" ? "fail" : "unknown"}`)}
                </span>
                <span className="qemu-check-title">
                  {check.title} <span className="mono muted">{check.id}</span>
                </span>
                {check.detail ? (
                  <span className="muted qemu-check-detail" title={check.detail}>
                    {check.detail}
                  </span>
                ) : null}
                {check.status !== "ok" && check.fix ? (
                  <div className="qemu-check-fix">
                    {t("qemu.env.fixLabel")}: <span className="mono">{check.fix}</span>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="muted qemu-state-dir-row">
              <span className="qemu-state-dir-label">{t("qemu.env.stateDir")}</span>
              <span className="mono qemu-state-dir-path" title={doctor.stateDir || undefined}>
                {doctor.stateDir || "-"}
              </span>
              <span className="badge success">{t("qemu.env.portableBadge")}</span>
            </div>
            <div className="muted qemu-portable-note">{t("qemu.env.portableNote")}</div>
          </div>
        ) : (
          <div className="empty-state">{t("qemu.env.loading")}</div>
        )}
      </Card>

      {/* ---------------- Nodes ---------------- */}
      <Card
        title={t("qemu.nodes.title")}
        action={
          <div className="row qemu-card-actions">
            {waitingVm ? (
              <span className="qemu-wait-strip">
                <LoaderCircle size={12} className="create-spinner" />
                {waitLabel}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    waitCancelRef.current = true;
                  }}
                >
                  {t("qemu.nodes.wait.cancel")}
                </Button>
              </span>
            ) : qemuWaitVm ? (
              /* Honest recovery for an interrupted wait: no fake progress. */
              <span className="qemu-wait-strip qemu-wait-interrupted">
                {t("qemu.nodes.wait.interrupted", { vm: qemuWaitVm })}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void waitForGuest(qemuWaitVm)}
                >
                  {t("qemu.nodes.waitAgain")}
                </Button>
              </span>
            ) : null}
            <Button
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setShowNodeForm((open) => !open)}
            >
              {t("qemu.nodes.create")}
            </Button>
          </div>
        }
      >
        {showNodeForm ? (
          <div className="qemu-form-grid">
            <div className="field">
              <label>{t("qemu.nodes.form.name")}</label>
              <input
                value={nodeForm.name}
                placeholder={t("qemu.nodes.form.namePlaceholder")}
                onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t("qemu.nodes.form.cpus")}</label>
              <input
                value={nodeForm.cpus}
                onChange={(e) => setNodeForm({ ...nodeForm, cpus: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t("qemu.nodes.form.mem")}</label>
              <input
                value={nodeForm.memMib}
                onChange={(e) => setNodeForm({ ...nodeForm, memMib: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t("qemu.nodes.form.disk")}</label>
              <input
                value={nodeForm.diskGib}
                onChange={(e) => setNodeForm({ ...nodeForm, diskGib: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t("qemu.nodes.form.portCount")}</label>
              <input
                value={nodeForm.adbPortCount}
                onChange={(e) => setNodeForm({ ...nodeForm, adbPortCount: e.target.value })}
              />
            </div>
            <label className="row qemu-checkbox">
              <input
                type="checkbox"
                checked={nodeForm.autoSetup}
                onChange={(e) => setNodeForm({ ...nodeForm, autoSetup: e.target.checked })}
              />
              {t("qemu.nodes.form.autoSetup")}
            </label>
            <div className="row">
              <Button
                variant="primary"
                loading={busy === "node-create"}
                onClick={() => void createNode()}
              >
                {t("qemu.nodes.form.submit")}
              </Button>
            </div>
          </div>
        ) : null}

        {vmsLoading && !vms.length ? (
          <Skeleton height={80} />
        ) : vms.length ? (
          <div className="table-wrap qemu-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("qemu.nodes.colName")}</th>
                  <th>{t("qemu.nodes.colVcpus")}</th>
                  <th>{t("qemu.nodes.colMem")}</th>
                  <th>{t("qemu.nodes.colAccel")}</th>
                  <th>{t("qemu.nodes.colSsh")}</th>
                  <th>{t("qemu.nodes.colAdb")}</th>
                  <th>{t("qemu.nodes.colInstances")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vms.map((vm) => (
                  <tr
                    key={vm.name}
                    className={vm.name === selectedVm ? "qemu-row-selected" : undefined}
                    onClick={() => { if (!presetBusyRef.current) setSelectedVm(vm.name); }}
                  >
                    <td className="mono">{vm.name}</td>
                    <td>{vm.vcpus}</td>
                    <td>{vm.memMib}</td>
                    <td>{vm.accel}</td>
                    <td className="mono">{vm.sshHostPort}</td>
                    <td className="mono">{adbBlockLabel(vm)}</td>
                    <td>{vm.adbAssignments.length}</td>
                    <td>
                      <div className="row qemu-row-actions">
                        <Button
                          size="sm"
                          icon={<Play size={12} />}
                          loading={busy === `start-${vm.name}`}
                          disabled={Boolean(busyKey)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void vmAction("start", vm.name);
                          }}
                        >
                          {t("qemu.nodes.start")}
                        </Button>
                        <Button
                          size="sm"
                          icon={<Square size={12} />}
                          loading={busy === `stop-${vm.name}`}
                          disabled={Boolean(busyKey)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void vmAction("stop", vm.name);
                          }}
                        >
                          {t("qemu.nodes.stop")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Trash2 size={12} />}
                          loading={busy === `delete-${vm.name}`}
                          disabled={Boolean(busyKey)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void vmAction("delete", vm.name);
                          }}
                        >
                          {t("qemu.nodes.delete")}
                        </Button>
                        <Button
                          size="sm"
                          icon={<ShieldCheck size={12} />}
                          disabled={Boolean(busyKey)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void vmAction("verify", vm.name);
                          }}
                        >
                          {t("qemu.nodes.verify")}
                        </Button>
                        <Button
                          size="sm"
                          loading={busy === `snapshot-${vm.name}`}
                          disabled={Boolean(busyKey)}
                          title={t("qemu.nodes.snapshotHint")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void snapshotVm(vm);
                          }}
                        >
                          {t("qemu.nodes.snapshot")}
                        </Button>
                        <Button
                          size="sm"
                          loading={busy === `restore-${vm.name}`}
                          disabled={Boolean(busyKey)}
                          title={t("qemu.nodes.restoreHint")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void restoreVm(vm);
                          }}
                        >
                          {t("qemu.nodes.restore")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">{t("qemu.nodes.empty")}</div>
        )}
      </Card>

      {/* ---------------- Instances ---------------- */}
      <Card
        title={t("qemu.instances.title")}
        action={
          <div className="row qemu-card-actions">
            {createdSerial ? (
              <span className="qemu-serial-chip">
                <span className="mono">{createdSerial}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={12} />}
                  onClick={() => void copySerial(createdSerial)}
                >
                  {t("qemu.instances.copySerial")}
                </Button>
              </span>
            ) : null}
            <Button
              size="sm"
              icon={<Plus size={13} />}
              disabled={!selectedVm || Boolean(busyKey)}
              onClick={() => {
                setUpgradeTarget(null);
                setInstanceForm(initialInstanceForm);
                setShowInstanceForm((open) => upgradeTarget ? true : !open);
              }}
            >
              {t("qemu.instances.create")}
            </Button>
          </div>
        }
      >
        {!selectedVm ? (
          <div className="empty-state">{t("qemu.instances.noSelection")}</div>
        ) : (
          <>
            {showInstanceForm ? (
              <div className="qemu-form-grid">
                <div className="field">
                  <label htmlFor="qemu-instance-name">{t("qemu.instances.form.name")}</label>
                  <input
                    id="qemu-instance-name"
                    disabled={Boolean(upgradeTarget) || Boolean(busyKey)}
                    value={instanceForm.name}
                    placeholder={t("qemu.instances.form.namePlaceholder")}
                    onChange={(e) => setInstanceForm({ ...instanceForm, name: e.target.value })}
                  />
                </div>
                {upgradeTarget ? <p className="muted" style={{ gridColumn: "1 / -1" }}>{t("qemu.presets.upgradeHint")}</p> : <>
                <div className="field">
                  <label>{t("qemu.instances.form.cpus")}</label>
                  <input
                    value={instanceForm.cpus}
                    onChange={(e) => setInstanceForm({ ...instanceForm, cpus: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>{t("qemu.instances.form.memory")}</label>
                  <input
                    value={instanceForm.memoryMib}
                    onChange={(e) => setInstanceForm({ ...instanceForm, memoryMib: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>{t("qemu.instances.form.width")}</label>
                  <input
                    value={instanceForm.width}
                    onChange={(e) => setInstanceForm({ ...instanceForm, width: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>{t("qemu.instances.form.height")}</label>
                  <input
                    value={instanceForm.height}
                    onChange={(e) => setInstanceForm({ ...instanceForm, height: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>{t("qemu.instances.form.dpi")}</label>
                  <input
                    value={instanceForm.dpi}
                    onChange={(e) => setInstanceForm({ ...instanceForm, dpi: e.target.value })}
                  />
                </div>
                </>}
                <div className="field">
                  <label htmlFor="qemu-android-version">{t("qemu.presets.androidVersion")}</label>
                  <input id="qemu-android-version" value={instanceForm.androidVersion} disabled={Boolean(busyKey) || Boolean(upgradeTarget?.androidVersion)} onChange={(e) => updatePreset("androidVersion", e.target.value)} />
                  {upgradeTarget && !upgradeTarget.androidVersion ? <small className="muted">{t("qemu.presets.versionCheck")}</small> : null}
                </div>
                <div className="field">
                  <label htmlFor="qemu-image">{t("qemu.presets.image")}</label>
                  <input id="qemu-image" value={instanceForm.image} placeholder={t("qemu.presets.imageDefault")} disabled={Boolean(busyKey)} onChange={(e) => updatePreset("image", e.target.value)} />
                </div>
                <div style={{ gridColumn: "1 / -1" }} className="row">
                  {(["installGapps", "installMagisk", "installLsposed", "installShamiko", "installCloak", "installNativeCloak"] as const).map((field) => <label key={field} className="row">
                    <input type="checkbox" checked={instanceForm[field]} disabled={Boolean(busyKey) || (field !== "installGapps" && field !== "installMagisk" && !instanceForm.installMagisk) || (field === "installCloak" && !instanceForm.installLsposed)} onChange={(e) => updatePreset(field, e.target.checked)} />
                    {t(`qemu.presets.${field}`)}
                  </label>)}
                </div>
                <p className="muted" style={{ gridColumn: "1 / -1" }}>{t("qemu.presets.dependencies")}</p>
                {presetAssets ? <p className="muted" style={{ gridColumn: "1 / -1" }}>{t("qemu.presets.assetStatus", { magisk: t(presetAssets.magiskOk ? "qemu.env.status.ok" : "qemu.env.status.fail"), lsposed: t(presetAssets.lsposedOk ? "qemu.env.status.ok" : "qemu.env.status.fail"), shamiko: t(presetAssets.shamikoOk ? "qemu.env.status.ok" : "qemu.env.status.fail") })}</p> : null}
                {presetAssetError ? <p role="alert" style={{ gridColumn: "1 / -1" }}>{presetAssetError}</p> : null}
                {instanceForm.installCloak ? <p className="muted" style={{ gridColumn: "1 / -1" }}>{t("qemu.presets.cloakScope")}</p> : null}
                {(["gappsZip", "nativeCloakZip", "moduleZips", "spoofProfileId", "spoofProfile", "hidePackages"] as const).map((field) => {
                  const disabled = Boolean(busyKey) || (field === "gappsZip" ? !instanceForm.installGapps : field === "nativeCloakZip" ? !instanceForm.installNativeCloak : !instanceForm.installMagisk) || (field === "spoofProfile" && Boolean(instanceForm.spoofProfileId));
                  return <div className="field" key={field} style={{ gridColumn: ["moduleZips", "spoofProfile", "hidePackages"].includes(field) ? "1 / -1" : undefined }}>
                    <label htmlFor={`qemu-${field}`}>{t(`qemu.presets.${field}`)}</label>
                    {["moduleZips", "spoofProfile", "hidePackages"].includes(field) ? <textarea id={`qemu-${field}`} rows={3} disabled={disabled} value={instanceForm[field]} onChange={(e) => updatePreset(field, e.target.value)} /> : <input id={`qemu-${field}`} list={field === "spoofProfileId" ? "qemu-profiles" : undefined} disabled={disabled} value={instanceForm[field]} onChange={(e) => updatePreset(field, e.target.value)} />}
                  </div>;
                })}
                <datalist id="qemu-profiles">{spoofProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.marketName || profile.model}</option>)}</datalist>
                <div style={{ gridColumn: "1 / -1" }} className="row">
                  {(["spoofAbilist", "cleanTraces"] as const).map((field) => <label key={field} className="row"><input type="checkbox" checked={instanceForm[field]} disabled={Boolean(busyKey) || !instanceForm.installMagisk || (!instanceForm.spoofProfileId.trim() && !instanceForm.spoofProfile.trim())} onChange={(e) => updatePreset(field, e.target.checked)} />{t(`qemu.presets.${field}`)}</label>)}
                </div>
                <p className="muted" style={{ gridColumn: "1 / -1" }}>{t("qemu.presets.abiHint")}</p>
                <div className="row">
                  <Button
                    variant="primary"
                    loading={busy === `instance-create-${selectedVm}`}
                    disabled={Boolean(busyKey)}
                    onClick={() => void createInstance()}
                  >
                    {t(upgradeTarget ? "qemu.presets.upgradeSubmit" : "qemu.instances.form.submit")}
                  </Button>
                </div>
              </div>
            ) : null}

            {instancesLoading && !instances.length ? (
              <Skeleton height={70} />
            ) : instances.length ? (
              <div className="table-wrap qemu-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("qemu.instances.colInstance")}</th>
                      <th>{t("qemu.instances.colContainer")}</th>
                      <th>{t("qemu.instances.colPort")}</th>
                      <th>{t("qemu.instances.colSerial")}</th>
                      <th>{t("qemu.instances.colStatus")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((instance) => (
                      <tr key={instance.instance}>
                        <td className="mono">{instance.instance}</td>
                        <td className="mono muted">{instance.container}</td>
                        <td className="mono">{instance.port}</td>
                        <td className="mono">{instance.serial}</td>
                        <td>{instance.status}</td>
                        <td>
                          <Button size="sm" disabled={Boolean(busyKey)} onClick={() => {
                            setUpgradeTarget(instance);
                            setInstanceForm({ ...initialInstanceForm, name: instance.instance, androidVersion: instance.androidVersion || "", image: instance.image || "" });
                            setShowInstanceForm(true);
                          }}>{t("qemu.presets.upgrade")}</Button>
                          <Button size="sm" disabled={!instance.rollbackAvailable || Boolean(busyKey)} loading={busy === `instance-restore-${instance.instance}`} onClick={() => void restoreInstance(instance)}>{t("qemu.presets.restore")}</Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Copy size={12} />}
                            onClick={() => void copySerial(instance.serial)}
                          >
                            {t("qemu.instances.copySerial")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">{t("qemu.instances.empty")}</div>
            )}
          </>
        )}
      </Card>

      {/* ---------------- Verify ---------------- */}
      <Card
        title={t("qemu.verify.title")}
        action={
          <div className="row qemu-card-actions">
            <Button
              size="sm"
              variant="primary"
              icon={<ShieldCheck size={13} />}
              disabled={!verifyVm}
              loading={verifyLoading}
              onClick={() => void runVerify(verifyVm)}
            >
              {t("qemu.verify.run")}
            </Button>
          </div>
        }
      >
        <div className="qemu-verify-controls">
          <label htmlFor="qemu-verify-vm">{t("qemu.verify.vm")}</label>
          <select
            id="qemu-verify-vm"
            value={verifyVm}
            onChange={(e) => setVerifyVm(e.target.value)}
          >
            {vms.length ? (
              vms.map((vm) => (
                <option key={vm.name} value={vm.name}>
                  {vm.name}
                </option>
              ))
            ) : (
              <option value="">{t("qemu.nodes.empty")}</option>
            )}
          </select>
        </div>
        {verify ? (
          <div className="stack qemu-check-list">
            <div className="muted qemu-verify-note">{t("qemu.verify.untestedNote")}</div>
            {verify.checks.map((check, index) => (
              <div key={check.id} className="qemu-check-row">
                <span className={verdictBadgeClass(check.verdict)}>
                  {t(`qemu.verify.verdict.${check.verdict.toLowerCase()}`)}
                </span>
                <span className="qemu-check-title">
                  <span className="mono muted">{index + 1}/7</span> {check.title}{" "}
                  <span className="mono muted">{check.id}</span>
                </span>
                {check.detail ? (
                  <span className="muted qemu-check-detail" title={check.detail}>
                    {check.detail}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("qemu.verify.empty")}</div>
        )}
      </Card>

      {/* ---------------- Log panel ---------------- */}
      <Card
        className="qemu-log-card"
        title={t("qemu.log.title")}
        action={
          <div className="row qemu-card-actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<Eraser size={12} />}
              onClick={() => setLogs([])}
            >
              {t("qemu.log.clear")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={logOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              aria-expanded={logOpen}
              onClick={() => setLogOpen((open) => !open)}
            >
              {logOpen ? t("qemu.log.collapse") : t("qemu.log.expand")}
            </Button>
          </div>
        }
      >
        {logOpen ? (
          logs.length ? (
            <pre ref={logRef} className="mono qemu-log-output">
              {logs.join("\n")}
            </pre>
          ) : (
            <div className="empty-state qemu-log-empty">{t("qemu.log.empty")}</div>
          )
        ) : (
          <div className="muted qemu-log-collapsed">
            {logs.length ? `${logs.length} lines` : t("qemu.log.empty")}
          </div>
        )}
      </Card>

      {statusText ? <div className="qemu-status-line muted">{statusText}</div> : null}
    </div>
  );
}
