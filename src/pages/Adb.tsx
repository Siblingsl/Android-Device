import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookmarkPlus, Cable, Camera, Check, ImagePlus, Link2, Pencil, QrCode, Radio, RefreshCw, Trash2, Unplug, Usb, Wrench, X } from "lucide-react";
import QRCode from "qrcode";
import { copyText } from "../lib/clipboard";
import { decodeQrImageFile, decodeQrVideoFrame } from "../lib/qrScanner";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { DeviceService } from "../services/deviceService";
import { askConfirm } from "../lib/dialogs";
import { createRequestSequence } from "../lib/requestSequence";
import { probeTool, type ProbeHit } from "../hooks/useToolProbe";
import { ToolStatus } from "../components/ui/ToolStatus";
import { useAppStore } from "../stores/appStore";
import { useI18n } from "../i18n";
import {
  findPairingService,
  getSavedWirelessAddressStatus,
  isAdbConnectService,
  isAdbPairingService,
  DEFAULT_RECONNECT_CONCURRENCY,
  normalizeWirelessAddress,
  normalizeReconnectConcurrency,
  parseAdbQrPayload,
  renameSavedWirelessAddress,
  runWithConcurrency,
  upsertSavedWirelessAddress,
  type SavedWirelessAddress,
} from "../lib/wirelessDebug";
import type { AdbInfo, AdbMdnsService, LanScanResult } from "../types";

type SavedReconnectStatus = "connecting" | "success" | "failed";
type SavedReconnectResult = { status: SavedReconnectStatus; message: string };

export function AdbPage() {
  const [info, setInfo] = useState<AdbInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState(() => {
    try {
      return sessionStorage.getItem("rdc.adb.address") || "127.0.0.1:5555";
    } catch {
      return "127.0.0.1:5555";
    }
  });
  const [tools, setTools] = useState<{ adb?: ProbeHit; docker?: ProbeHit }>({});
  const setStatusText = useAppStore((s) => s.setStatusText);
  const setSelected = useAppStore((s) => s.setSelectedDeviceId);
  const settings = useAppStore((s) => s.settings);
  const navigate = useNavigate();
  const { t } = useI18n();
  const adbOk = tools.adb?.ok !== false;
  const [lanSubnet, setLanSubnet] = useState("");
  const [lanPort, setLanPort] = useState("5555");
  const [lanAuto, setLanAuto] = useState(true);
  const [lanScanning, setLanScanning] = useState(false);
  const [lanResult, setLanResult] = useState<LanScanResult | null>(null);
  const [pairAddress, setPairAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [mdnsServices, setMdnsServices] = useState<AdbMdnsService[]>([]);
  const [mdnsLoading, setMdnsLoading] = useState(false);
  const mdnsBusy = useRef(false);
  const [qrPair, setQrPair] = useState<{
    instanceName: string;
    pairingSecret: string;
    payload: string;
    dataUrl: string;
  } | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrInput, setQrInput] = useState("");
  const [qrImageBusy, setQrImageBusy] = useState(false);
  const [qrScannerMode, setQrScannerMode] = useState<"camera" | null>(null);
  const qrFileInput = useRef<HTMLInputElement>(null);
  const qrVideoRef = useRef<HTMLVideoElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const qrStream = useRef<MediaStream | null>(null);
  const [savedAddresses, setSavedAddresses] = useState<SavedWirelessAddress[]>(() => {
    try {
      const raw = localStorage.getItem("rdc.adb.savedWirelessAddresses");
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is Partial<SavedWirelessAddress> => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({
          address: normalizeWirelessAddress(typeof entry.address === "string" ? entry.address : "") || "",
          label: typeof entry.label === "string" ? entry.label : "",
          lastConnectedAt: typeof entry.lastConnectedAt === "string" ? entry.lastConnectedAt : "",
        }))
        .filter((entry) => entry.address);
    } catch {
      return [];
    }
  });
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectConcurrency, setReconnectConcurrency] = useState(() => {
    try {
      return normalizeReconnectConcurrency(localStorage.getItem("rdc.adb.savedWirelessConcurrency") ?? undefined);
    } catch {
      return DEFAULT_RECONNECT_CONCURRENCY;
    }
  });
  const [reconnectResults, setReconnectResults] = useState<Record<string, SavedReconnectResult>>({});
  const [selectedSavedAddresses, setSelectedSavedAddresses] = useState<string[]>([]);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [tcpipSerial, setTcpipSerial] = useState("");
  const [tcpipPort, setTcpipPort] = useState("5555");
  const loadSequence = useRef(createRequestSequence()).current;

  useEffect(() => {
    void DeviceService.getLocalSubnet()
      .then((sn) => setLanSubnet((prev) => prev || sn))
      .catch(() => {
        /* backend unavailable */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runLanScan = async () => {
    const subnet = lanSubnet.trim();
    const port = Number(lanPort);
    if (!subnet) {
      setStatusText(t("adb.lan.invalidSubnet"));
      void alert(t("adb.lan.invalidSubnet"));
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatusText(t("adb.lan.invalidPort"));
      void alert(t("adb.lan.invalidPort"));
      return;
    }
    setLanScanning(true);
    setStatusText(t("adb.lan.scanning", { subnet }));
    try {
      const r = await DeviceService.lanScan(subnet, port, lanAuto);
      setLanResult(r);
      if (r.message) {
        setStatusText(r.message);
        void alert(r.message);
      } else {
        setStatusText(
          t("adb.lan.done", {
            found: r.found.length,
            n: r.found.filter((d) => d.connected).length,
          }),
        );
      }
      if (r.connectedCount > 0) await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(t("adb.lan.scanFailed", { msg }));
      void alert(t("adb.lan.scanFailed", { msg }));
    } finally {
      setLanScanning(false);
    }
  };

  const connectLanDevice = async (addr: string) => {
    setStatusText(t("adb.connecting", { address: addr }));
    const r = await DeviceService.adbConnect(addr);
    setStatusText(r.success ? r.stdout || t("adb.connected") : r.stderr || r.stdout || t("adb.connectFailed"));
    if (!r.success) void alert(r.stderr || r.stdout || t("adb.connectFailed"));
    await load();
    setLanResult((prev) =>
      prev
        ? {
            ...prev,
            found: prev.found.map((d) =>
              d.address === addr
                ? { ...d, connected: r.success, message: (r.stdout || r.stderr || "").trim() }
                : d,
            ),
          }
        : prev,
    );
  };

  const connectWirelessAddress = async (rawAddress: string, label = rawAddress) => {
    const target = normalizeWirelessAddress(rawAddress);
    if (!target) {
      setStatusText(t("adb.wireless.invalidAddress"));
      void alert(t("adb.wireless.invalidAddress"));
      return false;
    }
    setReconnectResults((current) => ({ ...current, [target]: { status: "connecting", message: "" } }));
    setStatusText(t("adb.connecting", { address: target }));
    try {
      const r = await DeviceService.adbConnect(target);
      const message = (r.success ? r.stdout : r.stderr || r.stdout || t("adb.connectFailed")).trim();
      setStatusText(message || (r.success ? t("adb.connected") : t("adb.connectFailed")));
      if (!r.success) {
        setReconnectResults((current) => ({ ...current, [target]: { status: "failed", message } }));
        void alert(message || t("adb.connectFailed"));
        return false;
      }
      setReconnectResults((current) => ({ ...current, [target]: { status: "success", message } }));
      setSavedAddresses((entries) => upsertSavedWirelessAddress(entries, target, label));
      await load();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setReconnectResults((current) => ({ ...current, [target]: { status: "failed", message } }));
      setStatusText(message || t("adb.connectFailed"));
      void alert(message || t("adb.connectFailed"));
      return false;
    }
  };

  const refreshMdnsServices = async (silent = false) => {
    if (!adbOk || mdnsBusy.current) return [];
    mdnsBusy.current = true;
    setMdnsLoading(true);
    try {
      const services = await DeviceService.adbMdnsServices();
      setMdnsServices(services);
      if (!silent) setStatusText(t("adb.wireless.mdnsDone", { n: services.length }));
      return services;
    } catch (e) {
      if (!silent) {
        const message = e instanceof Error ? e.message : String(e);
        setStatusText(t("adb.wireless.mdnsFailed", { msg: message }));
        void alert(t("adb.wireless.mdnsFailed", { msg: message }));
      }
      return [];
    } finally {
      mdnsBusy.current = false;
      setMdnsLoading(false);
    }
  };

  const pairWirelessAddress = async (rawAddress = pairAddress, secret = pairingCode) => {
    const target = normalizeWirelessAddress(rawAddress);
    const code = secret.trim();
    if (!target || !code) {
      setStatusText(t("adb.wireless.invalidPair"));
      void alert(t("adb.wireless.invalidPair"));
      return false;
    }
    setPairAddress(target);
    setPairingCode(code);
    setPairingBusy(true);
    setStatusText(t("adb.wireless.pairing", { address: target }));
    try {
      const r = await DeviceService.adbPair(target, code);
      const message = (r.success ? r.stdout : r.stderr || r.stdout || t("adb.wireless.pairFailed")).trim();
      setStatusText(message || (r.success ? t("adb.wireless.paired") : t("adb.wireless.pairFailed")));
      if (!r.success) {
        void alert(message || t("adb.wireless.pairFailed"));
        return false;
      }
      await refreshMdnsServices(true);
      await load();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatusText(message || t("adb.wireless.pairFailed"));
      void alert(message || t("adb.wireless.pairFailed"));
      return false;
    } finally {
      setPairingBusy(false);
    }
  };

  const createQrPairing = async () => {
    setQrBusy(true);
    try {
      const bytes = new Uint8Array(10);
      globalThis.crypto?.getRandomValues(bytes);
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
      const instanceName = "studio-rdc@" + suffix;
      const secretBytes = new Uint8Array(10);
      globalThis.crypto?.getRandomValues(secretBytes);
      const pairingSecret = Array.from(secretBytes, (byte) => String(byte % 10)).join("");
      const escapeQr = (value: string) => value.replace(/[\\;,:]/g, (character) => "\\" + character);
      const payload = "WIFI:T:ADB;S:" + escapeQr(instanceName) + ";P:" + escapeQr(pairingSecret) + ";;";
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      setQrPair({ instanceName, pairingSecret, payload, dataUrl });
      setPairingCode(pairingSecret);
      setStatusText(t("adb.wireless.qrReady"));
      await refreshMdnsServices(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatusText(t("adb.wireless.qrFailed", { msg: message }));
      void alert(t("adb.wireless.qrFailed", { msg: message }));
    } finally {
      setQrBusy(false);
    }
  };

  const pairGeneratedQr = async () => {
    if (!qrPair) return;
    const services = await refreshMdnsServices(true);
    const pairingService = findPairingService(services, qrPair.instanceName);
    if (!pairingService) {
      setStatusText(t("adb.wireless.qrServiceMissing", { name: qrPair.instanceName }));
      void alert(t("adb.wireless.qrServiceMissing", { name: qrPair.instanceName }));
      return;
    }
    await pairWirelessAddress(pairingService.address, qrPair.pairingSecret);
  };

  const pairQrPayload = async (rawPayload: string) => {
    const parsed = parseAdbQrPayload(rawPayload);
    if (!parsed) {
      setStatusText(t("adb.wireless.qrImportInvalid"));
      void alert(t("adb.wireless.qrImportInvalid"));
      return;
    }
    setPairingCode(parsed.pairingSecret);
    setStatusText(t("adb.wireless.qrImportSearching", { name: parsed.instanceName }));
    const services = await refreshMdnsServices(true);
    const pairingService = findPairingService(services, parsed.instanceName);
    if (!pairingService) {
      setStatusText(t("adb.wireless.qrServiceMissing", { name: parsed.instanceName }));
      void alert(t("adb.wireless.qrServiceMissing", { name: parsed.instanceName }));
      return;
    }
    setPairAddress(pairingService.address);
    const paired = await pairWirelessAddress(pairingService.address, parsed.pairingSecret);
    if (!paired) return;
    const connectService = (await refreshMdnsServices(true)).find(
      (service) => isAdbConnectService(service) && service.instanceName === parsed.instanceName,
    );
    if (connectService) {
      setSavedAddresses((entries) => upsertSavedWirelessAddress(entries, connectService.address, parsed.instanceName));
      setStatusText(t("adb.wireless.qrImportSaved", { address: connectService.address }));
    }
  };

  const importQrPairing = () => void pairQrPayload(qrInput);

  const stopQrCamera = () => {
    qrStream.current?.getTracks().forEach((track) => track.stop());
    qrStream.current = null;
    setQrScannerMode(null);
  };

  useEffect(() => () => {
    qrStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (qrScannerMode !== "camera" || !qrStream.current || !qrVideoRef.current || !qrCanvasRef.current) return;
    const video = qrVideoRef.current;
    const canvas = qrCanvasRef.current;
    video.srcObject = qrStream.current;
    void video.play().catch(() => {
      /* autoplay may require a user gesture in some WebViews */
    });
    let active = true;
    let frame = 0;
    const scan = () => {
      if (!active) return;
      const payload = decodeQrVideoFrame(video, canvas);
      if (payload) {
        active = false;
        qrStream.current?.getTracks().forEach((track) => track.stop());
        qrStream.current = null;
        setQrScannerMode(null);
        setQrInput(payload);
        void pairQrPayload(payload);
        return;
      }
      frame = window.requestAnimationFrame(scan);
    };
    frame = window.requestAnimationFrame(scan);
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      video.srcObject = null;
    };
  }, [qrScannerMode]);

  const startQrCamera = async () => {
    if (qrScannerMode === "camera") {
      stopQrCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatusText(t("adb.wireless.qrCameraUnsupported"));
      void alert(t("adb.wireless.qrCameraUnsupported"));
      return;
    }
    try {
      qrStream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      setQrScannerMode("camera");
      setStatusText(t("adb.wireless.qrCameraReady"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatusText(t("adb.wireless.qrCameraFailed", { msg: message }));
      void alert(t("adb.wireless.qrCameraFailed", { msg: message }));
    }
  };

  const handleQrImageSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setQrImageBusy(true);
    try {
      const payload = await decodeQrImageFile(file);
      if (!payload) {
        setStatusText(t("adb.wireless.qrImageInvalid"));
        void alert(t("adb.wireless.qrImageInvalid"));
        return;
      }
      setQrInput(payload);
      await pairQrPayload(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatusText(t("adb.wireless.qrImageFailed", { msg: message }));
      void alert(t("adb.wireless.qrImageFailed", { msg: message }));
    } finally {
      setQrImageBusy(false);
    }
  };

  const saveWirelessAddress = () => {
    const target = normalizeWirelessAddress(address);
    if (!target) {
      setStatusText(t("adb.wireless.invalidAddress"));
      void alert(t("adb.wireless.invalidAddress"));
      return;
    }
    setSavedAddresses((entries) => upsertSavedWirelessAddress(entries, target));
    setStatusText(t("adb.wireless.saved", { address: target }));
  };

  const startEditingSavedAddress = (entry: SavedWirelessAddress) => {
    setEditingAddress(entry.address);
    setEditingLabel(entry.label);
  };

  const finishEditingSavedAddress = () => {
    if (!editingAddress) return;
    setSavedAddresses((entries) => renameSavedWirelessAddress(entries, editingAddress, editingLabel));
    setStatusText(t("adb.wireless.renamed", { label: editingLabel.trim() || editingAddress }));
    setEditingAddress(null);
    setEditingLabel("");
  };

  const reconnectSavedAddresses = async (entries = savedAddresses) => {
    if (!entries.length || reconnectBusy) return;
    setReconnectBusy(true);
    setReconnectResults((current) => {
      const next = { ...current };
      entries.forEach((entry) => {
        next[entry.address] = { status: "connecting", message: "" };
      });
      return next;
    });
    setStatusText(t("adb.wireless.reconnecting", { n: entries.length }));
    try {
      const results = await runWithConcurrency(entries, reconnectConcurrency, async (entry) => {
        try {
          const result = await DeviceService.adbConnect(entry.address);
          const message = (result.success ? result.stdout : result.stderr || result.stdout || t("adb.connectFailed")).trim();
          const reconnectResult = {
            status: result.success ? "success" : "failed",
            message,
          } as SavedReconnectResult;
          setReconnectResults((current) => ({ ...current, [entry.address]: reconnectResult }));
          return { entry, success: result.success, message };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          setReconnectResults((current) => ({
            ...current,
            [entry.address]: { status: "failed", message: message || t("adb.connectFailed") },
          }));
          return { entry, success: false, message: message || t("adb.connectFailed") };
        }
      });
      const successful = results.filter((result) => result.success).map((result) => result.entry);
      setSavedAddresses((entries) => successful.reduce(
        (next, entry) => upsertSavedWirelessAddress(next, entry.address, entry.label),
        entries,
      ));
      setStatusText(t("adb.wireless.reconnectedSummary", {
        ok: successful.length,
        n: entries.length,
      }));
      await load();
    } finally {
      setReconnectBusy(false);
    }
  };

  const retryFailedSavedAddresses = () => {
    const failed = savedAddresses.filter((entry) => reconnectResults[entry.address]?.status === "failed");
    void reconnectSavedAddresses(failed);
  };

  const toggleSavedAddressSelection = (target: string) => {
    setSelectedSavedAddresses((current) => current.includes(target)
      ? current.filter((address) => address !== target)
      : [...current, target]);
  };

  const toggleAllSavedAddresses = () => {
    setSelectedSavedAddresses((current) => current.length === savedAddresses.length
      ? []
      : savedAddresses.map((entry) => entry.address));
  };

  const deleteSelectedSavedAddresses = async () => {
    if (!selectedSavedAddresses.length) return;
    const selected = new Set(selectedSavedAddresses);
    const targets = savedAddresses.filter((entry) => selected.has(entry.address));
    if (!(await askConfirm(t("adb.wireless.confirmBatchDelete", { n: targets.length })))) return;
    setSavedAddresses((entries) => entries.filter((entry) => !selected.has(entry.address)));
    setReconnectResults((current) => {
      const next = { ...current };
      selectedSavedAddresses.forEach((address) => delete next[address]);
      return next;
    });
    setSelectedSavedAddresses([]);
    setStatusText(t("adb.wireless.batchDeleted", { n: targets.length }));
  };

  const switchTcpip = async () => {
    const port = Number(tcpipPort);
    if (!tcpipSerial || !Number.isInteger(port) || port < 1 || port > 65535) {
      setStatusText(t("adb.wireless.invalidTcpip"));
      void alert(t("adb.wireless.invalidTcpip"));
      return;
    }
    setStatusText(t("adb.wireless.tcpipStarting", { serial: tcpipSerial, port }));
    try {
      const r = await DeviceService.adbTcpip(tcpipSerial, port);
      const message = (r.success ? r.stdout : r.stderr || r.stdout || t("adb.wireless.tcpipFailed")).trim();
      setStatusText(message || (r.success ? t("adb.wireless.tcpipDone") : t("adb.wireless.tcpipFailed")));
      if (!r.success) void alert(message || t("adb.wireless.tcpipFailed"));
      else await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatusText(message || t("adb.wireless.tcpipFailed"));
      void alert(message || t("adb.wireless.tcpipFailed"));
    }
  };

  const load = async () => {
    const token = loadSequence.begin();
    setLoading(true);
    try {
      const [adb, docker] = await Promise.all([
        probeTool("adb", settings?.adbPath),
        probeTool("docker", settings?.dockerPath),
      ]);
      if (!loadSequence.isCurrent(token)) return;
      setTools({ adb, docker });
      if (adb.ok) {
        const nextInfo = await DeviceService.getAdbInfo();
        if (!loadSequence.isCurrent(token)) return;
        setInfo(nextInfo);
      } else {
        setInfo(null);
      }
    } catch (e) {
      if (!loadSequence.isCurrent(token)) return;
      setStatusText(e instanceof Error ? t("adb.refreshFailedWith", { msg: e.message }) : t("adb.refreshFailed"));
    } finally {
      if (!loadSequence.isCurrent(token)) return;
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => loadSequence.invalidate();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("rdc.adb.address", address);
    } catch {
      /* ignore */
    }
  }, [address]);

  useEffect(() => {
    try {
      localStorage.setItem("rdc.adb.savedWirelessAddresses", JSON.stringify(savedAddresses));
    } catch {
      /* ignore */
    }
  }, [savedAddresses]);

  useEffect(() => {
    try {
      localStorage.setItem("rdc.adb.savedWirelessConcurrency", String(reconnectConcurrency));
    } catch {
      /* ignore */
    }
  }, [reconnectConcurrency]);

  useEffect(() => {
    if (!adbOk) return;
    const refresh = () => void refreshMdnsServices(true);
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [adbOk]);

  useEffect(() => {
    if (tcpipSerial || !info?.devices.length) return;
    const usbDevice = info.devices.find((device) => !device.serial.includes(":"));
    if (usbDevice) setTcpipSerial(usbDevice.serial);
  }, [info, tcpipSerial]);

  const failedSavedCount = savedAddresses.filter(
    (entry) => reconnectResults[entry.address]?.status === "failed",
  ).length;
  const selectedSavedEntries = savedAddresses.filter((entry) => selectedSavedAddresses.includes(entry.address));
  const allSavedAddressesSelected = Boolean(savedAddresses.length) && selectedSavedEntries.length === savedAddresses.length;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{t("adb.page.title")}</div>
          <div className="page-subtitle">{t("adb.page.subtitle")}</div>
        </div>
        <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>
          {t("adb.scan")}
        </Button>
      </div>

      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 16 }}>
        <ToolStatus kind="adb" hit={tools.adb} />
        <ToolStatus kind="docker" hit={tools.docker} />
      </div>

      <div className="grid-stats">
        <Card>
          <div className="muted">{t("adb.version")}</div>
          <div style={{ fontWeight: 700 }}>{loading ? "..." : info?.version || "—"}</div>
        </Card>
        <Card>
          <div className="muted">{t("adb.serverStatus")}</div>
          <div style={{ fontWeight: 700, color: info?.serverRunning ? "var(--success)" : "var(--danger)" }}>
            {loading ? "..." : info?.serverRunning ? t("common.status.dockerRunning") : t("adb.serverError")}
          </div>
        </Card>
        <Card>
          <div className="muted">{t("adb.deviceCount")}</div>
          <div style={{ fontWeight: 700 }}>{info?.devices.length ?? 0}</div>
        </Card>
      </div>

      <Card
        title={t("adb.lan.title")}
        action={
          <div className="row">
            <input
              value={lanSubnet}
              onChange={(e) => setLanSubnet(e.target.value)}
              placeholder="192.168.1.0/24"
              title={t("adb.lan.subnet")}
              style={{ height: 30, width: 170, padding: "0 10px", borderRadius: 8 }}
            />
            <input
              value={lanPort}
              onChange={(e) => setLanPort(e.target.value)}
              placeholder="5555"
              title={t("adb.lan.port")}
              style={{ height: 30, width: 76, padding: "0 10px", borderRadius: 8 }}
            />
            <Button
              variant="primary"
              loading={lanScanning}
              disabled={lanScanning}
              onClick={() => void runLanScan()}
            >
              {t("adb.lan.start")}
            </Button>
          </div>
        }
      >
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <label className="row" style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={lanAuto}
              onChange={(e) => setLanAuto(e.target.checked)}
            />
            {t("adb.lan.autoConnect")}
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("adb.lan.hint")}
          </span>
        </div>
        {lanResult && (
          <>
            {lanResult.found.length === 0 ? (
              <div className="empty-state">
                {lanResult.message || t("adb.lan.none", { subnet: lanResult.subnet, scanned: lanResult.scanned })}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("adb.lan.table.address")}</th>
                    <th>{t("adb.table.model")}</th>
                    <th>{t("devices.table.result")}</th>
                    <th>{t("volumes.table.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lanResult.found.map((d) => (
                    <tr key={d.address}>
                      <td className="mono">{d.address}</td>
                      <td>{d.model || "—"}</td>
                      <td className={d.connected ? "ok" : "bad"}>
                        {d.connected ? t("adb.lan.state.connected") : d.message || t("adb.lan.state.failed")}
                      </td>
                      <td>
                        <div className="row">
                          {!d.connected && (
                            <Button size="sm" onClick={() => void connectLanDevice(d.address)}>
                              {t("adb.connect")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSelected(d.address);
                              navigate(`/devices/${encodeURIComponent(d.address)}`);
                            }}
                          >
                            {t("common.open")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t("adb.lan.summary", {
                scanned: lanResult.scanned,
                found: lanResult.found.length,
                n: lanResult.found.filter((d) => d.connected).length,
                ms: lanResult.durationMs,
              })}
            </div>
          </>
        )}
      </Card>

      <div className="grid-2 wireless-debug-grid">
        <Card title={t("adb.wireless.title")}>
          <div className="wireless-form-grid">
            <div className="field">
              <label>{t("adb.wireless.pairAddress")}</label>
              <input
                aria-label={t("adb.wireless.pairAddress")}
                value={pairAddress}
                onChange={(e) => setPairAddress(e.target.value)}
                placeholder="192.168.1.20:37145"
                disabled={pairingBusy}
              />
            </div>
            <div className="field">
              <label>{t("adb.wireless.pairingCode")}</label>
              <input
                aria-label={t("adb.wireless.pairingCode")}
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value)}
                placeholder="123456"
                disabled={pairingBusy}
              />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            <Button
              variant="primary"
              loading={pairingBusy}
              disabled={!adbOk || pairingBusy}
              onClick={() => void pairWirelessAddress()}
            >
              {t("adb.wireless.pair")}
            </Button>
            <span className="muted wireless-help">{t("adb.wireless.pairHint")}</span>
          </div>
          <div className="wireless-qr-block">
            <div className="row-between">
              <div>
                <div className="wireless-section-title"><QrCode size={14} />{t("adb.wireless.qrTitle")}</div>
                <div className="muted wireless-help">{t("adb.wireless.qrHint")}</div>
              </div>
              <Button size="sm" variant="ghost" icon={<QrCode size={14} />} loading={qrBusy} disabled={!adbOk} onClick={() => void createQrPairing()}>
                {t("adb.wireless.generateQr")}
              </Button>
            </div>
            <div className="wireless-qr-import">
              <div className="wireless-section-title"><QrCode size={14} />{t("adb.wireless.qrImportTitle")}</div>
              <div className="muted wireless-help">{t("adb.wireless.qrImportHint")}</div>
              <textarea
                aria-label={t("adb.wireless.qrImportLabel")}
                value={qrInput}
                onChange={(event) => setQrInput(event.target.value)}
                placeholder="WIFI:T:ADB;S:device;P:secret;;"
                rows={2}
                disabled={pairingBusy}
              />
              <Button size="sm" variant="secondary" loading={pairingBusy} disabled={!adbOk || pairingBusy || !qrInput.trim()} onClick={() => void importQrPairing()}>
                {t("adb.wireless.qrImportButton")}
              </Button>
              <div className="row wireless-qr-scan-actions">
                <input ref={qrFileInput} type="file" accept="image/*" hidden onChange={(event) => void handleQrImageSelected(event)} />
                <Button size="sm" variant="ghost" icon={<ImagePlus size={14} />} loading={qrImageBusy} disabled={!adbOk || pairingBusy || qrImageBusy} onClick={() => qrFileInput.current?.click()}>
                  {t("adb.wireless.qrImageButton")}
                </Button>
                <Button size="sm" variant={qrScannerMode === "camera" ? "danger" : "ghost"} icon={<Camera size={14} />} disabled={!adbOk || pairingBusy || qrImageBusy} onClick={() => void startQrCamera()}>
                  {qrScannerMode === "camera" ? t("adb.wireless.qrCameraStop") : t("adb.wireless.qrCameraButton")}
                </Button>
              </div>
              {qrScannerMode === "camera" ? (
                <div className="wireless-qr-camera">
                  <video ref={qrVideoRef} muted playsInline aria-label={t("adb.wireless.qrCameraPreview")} />
                  <canvas ref={qrCanvasRef} hidden />
                  <span className="muted">{t("adb.wireless.qrCameraHint")}</span>
                </div>
              ) : null}
            </div>
            {qrPair ? (
              <div className="wireless-qr-result">
                <img src={qrPair.dataUrl} alt={t("adb.wireless.qrAlt")} width={180} height={180} />
                <div className="wireless-qr-meta">
                  <span className="muted">{t("adb.wireless.qrScanStatus")}</span>
                  <span className="mono">{qrPair.instanceName}</span>
                  <span className="muted">{t("adb.wireless.qrSecret")}</span>
                  <span className="mono">{qrPair.pairingSecret}</span>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <Button size="sm" variant="primary" loading={pairingBusy} disabled={pairingBusy} onClick={() => void pairGeneratedQr()}>
                      {t("adb.wireless.qrPair")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void copyText(qrPair.payload)}>
                      {t("adb.wireless.copyQr")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card
          title={t("adb.wireless.savedTitle")}
          action={
            <div className="row wireless-saved-actions">
              <label>
                <span className="muted">{t("adb.wireless.concurrency")}</span>
                <select
                  aria-label={t("adb.wireless.concurrency")}
                  value={reconnectConcurrency}
                  onChange={(event) => setReconnectConcurrency(normalizeReconnectConcurrency(event.target.value))}
                  disabled={!adbOk || reconnectBusy || !savedAddresses.length}
                >
                  {[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              {failedSavedCount > 0 ? (
                <Button size="sm" variant="ghost" loading={reconnectBusy} disabled={!adbOk || reconnectBusy} onClick={retryFailedSavedAddresses}>
                  {t("adb.wireless.retryFailed")}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" loading={reconnectBusy} disabled={!adbOk || !savedAddresses.length} onClick={() => void reconnectSavedAddresses()}>
                {t("adb.wireless.reconnectAll")}
              </Button>
            </div>
          }
        >
          {savedAddresses.length ? (
            <div className="wireless-selection-bar">
              <Button size="sm" variant="ghost" onClick={toggleAllSavedAddresses}>
                {allSavedAddressesSelected ? t("adb.wireless.cancelSelectAll") : t("adb.wireless.selectAll")}
              </Button>
              {selectedSavedEntries.length ? (
                <>
                  <span className="badge">{t("adb.wireless.selectedCount", { n: selectedSavedEntries.length })}</span>
                  <Button size="sm" variant="secondary" disabled={!adbOk || reconnectBusy} onClick={() => void reconnectSavedAddresses(selectedSavedEntries)}>
                    {t("adb.wireless.batchConnect")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void deleteSelectedSavedAddresses()}>
                    <Trash2 size={14} />
                    {t("adb.wireless.batchDelete")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {savedAddresses.length ? (
            <div className="wireless-saved-list">
              {savedAddresses.map((entry) => {
                const result = reconnectResults[entry.address];
                const status = getSavedWirelessAddressStatus(entry, info?.devices || [], mdnsServices, reconnectResults);
                const isEditing = editingAddress === entry.address;
                return (
                  <div className="wireless-saved-row" key={entry.address}>
                    <input
                      type="checkbox"
                      aria-label={t("adb.wireless.selectAddress", { label: entry.label })}
                      checked={selectedSavedAddresses.includes(entry.address)}
                      onChange={() => toggleSavedAddressSelection(entry.address)}
                      disabled={reconnectBusy}
                    />
                    <div className="wireless-saved-row-content">
                      {isEditing ? (
                        <div className="wireless-saved-edit">
                          <input
                            aria-label={t("adb.wireless.labelInput")}
                            value={editingLabel}
                            onChange={(event) => setEditingLabel(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") finishEditingSavedAddress();
                              if (event.key === "Escape") {
                                setEditingAddress(null);
                                setEditingLabel("");
                              }
                            }}
                            autoFocus
                          />
                          <Button size="sm" variant="primary" icon={<Check size={14} />} title={t("adb.wireless.saveLabel")} onClick={finishEditingSavedAddress} />
                          <Button size="sm" variant="ghost" icon={<X size={14} />} title={t("adb.wireless.cancelLabel")} onClick={() => { setEditingAddress(null); setEditingLabel(""); }} />
                        </div>
                      ) : (
                        <div className="wireless-saved-label">
                          <span>{entry.label}</span>
                          <Button size="sm" variant="ghost" icon={<Pencil size={13} />} title={t("adb.wireless.editLabel", { label: entry.label })} aria-label={t("adb.wireless.editLabel", { label: entry.label })} onClick={() => startEditingSavedAddress(entry)} />
                        </div>
                      )}
                      <div className="muted mono">{entry.address}</div>
                      <div className={`wireless-saved-status ${status}`}>
                        <span className="wireless-status-dot" aria-hidden="true" />
                        {t(`adb.wireless.status.${status}`)}
                        {status === "failed" && result?.message ? <span className="muted"> · {result.message}</span> : null}
                        {entry.lastConnectedAt ? <span className="muted"> · {t("adb.wireless.lastSeen", { time: new Date(entry.lastConnectedAt).toLocaleString() })}</span> : null}
                      </div>
                    </div>
                    <div className="row">
                      <Button size="sm" variant="ghost" disabled={!adbOk || reconnectBusy || isEditing} onClick={() => void connectWirelessAddress(entry.address, entry.label)}>
                        {t("adb.connect")}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} title={t("adb.wireless.removeAddress")} onClick={() => {
                        setSavedAddresses((items) => items.filter((item) => item.address !== entry.address));
                        setSelectedSavedAddresses((items) => items.filter((address) => address !== entry.address));
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">{t("adb.wireless.noSaved")}</div>
          )}
          <div className="wireless-divider" />
          <div className="wireless-section-title"><Usb size={14} />{t("adb.wireless.tcpipTitle")}</div>
          <div className="row wireless-tcpip-row">
            <select value={tcpipSerial} onChange={(e) => setTcpipSerial(e.target.value)} disabled={!adbOk}>
              <option value="">{t("adb.wireless.selectUsb")}</option>
              {info?.devices.filter((device) => !device.serial.includes(":")).map((device) => (
                <option key={device.serial} value={device.serial}>{device.serial}</option>
              ))}
            </select>
            <input value={tcpipPort} onChange={(e) => setTcpipPort(e.target.value)} inputMode="numeric" aria-label={t("adb.wireless.tcpipPort")} />
            <Button size="sm" variant="secondary" disabled={!adbOk || !tcpipSerial} onClick={() => void switchTcpip()}>
              {t("adb.wireless.enableTcpip")}
            </Button>
          </div>
          <div className="muted wireless-help">{t("adb.wireless.tcpipHint")}</div>
        </Card>
      </div>

      <Card
        title={t("adb.wireless.mdnsTitle")}
        action={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={mdnsLoading} disabled={!adbOk} onClick={() => void refreshMdnsServices()}>
            {t("adb.wireless.refreshMdns")}
          </Button>
        }
      >
        <div className="row wireless-mdns-summary">
          <Radio size={14} />
          <span className="muted">{t("adb.wireless.mdnsHint")}</span>
          <span className="badge">{mdnsServices.length}</span>
        </div>
        {mdnsServices.length ? (
          <div className="wireless-mdns-list">
            {mdnsServices.map((service) => {
              const pairing = isAdbPairingService(service);
              const connect = isAdbConnectService(service);
              return (
                <div className="wireless-mdns-row" key={service.instanceName + service.serviceType + service.address}>
                  <div>
                    <div className="mono">{service.instanceName}</div>
                    <div className="muted">{service.serviceType} · {service.address}</div>
                  </div>
                  {pairing ? (
                    <Button size="sm" variant="secondary" disabled={!pairingCode || pairingBusy} onClick={() => void pairWirelessAddress(service.address)}>
                      {t("adb.wireless.usePairingService")}
                    </Button>
                  ) : connect ? (
                    <Button size="sm" variant="primary" disabled={!adbOk} onClick={() => void connectWirelessAddress(service.address, service.instanceName)}>
                      {t("adb.wireless.connectService")}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">{t("adb.wireless.noMdns")}</div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={t("adb.connectManager")}>
          <div className="field">
            <label>{t("adb.manualAddress")}</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !adbOk) return;
                  e.preventDefault();
                  void connectWirelessAddress(address);
                }}
                placeholder="ip:port"
              />
              <Button
                variant="primary"
                icon={<Link2 size={14} />}
                disabled={!adbOk}
                title={tools.adb && !tools.adb.ok ? t("adb.unavailable", { text: tools.adb.text }) : undefined}
                onClick={() => void connectWirelessAddress(address)}
              >
                {t("adb.connect")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<BookmarkPlus size={14} />}
                disabled={!adbOk}
                onClick={saveWirelessAddress}
              >
                {t("adb.wireless.saveAddress")}
              </Button>
              <Button
                disabled={!address.includes(":")}
                onClick={() => {
                  setSelected(address.trim());
                  navigate(`/devices/${encodeURIComponent(address.trim())}`);
                }}
              >
                {t("adb.openThis")}
              </Button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
            <Button
              icon={<Cable size={14} />}
              disabled={!adbOk}
              title={tools.adb && !tools.adb.ok ? t("adb.unavailable", { text: tools.adb.text }) : undefined}
              onClick={async () => {
                const r = await DeviceService.adbStartServer();
                setStatusText(r.success ? t("adb.serverStarted") : r.stderr || t("adb.startFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.startFailed"));
                await load();
              }}
            >
              {t("adb.startServer")}
            </Button>
            <Button
              disabled={!adbOk}
              onClick={async () => {
                if (!(await askConfirm(t("adb.confirmKillServer")))) return;
                const r = await DeviceService.adbKillServer();
                setStatusText(r.success ? t("adb.serverStopped") : r.stderr || t("adb.stopFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.stopFailed"));
                await load();
              }}
            >
              {t("adb.stopServer")}
            </Button>
            <Button
              icon={<RefreshCw size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                const r = await DeviceService.adbRestartServer();
                setStatusText(r.success ? t("adb.serverRestarted") : r.stderr || t("adb.restartFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.restartFailed"));
                await load();
              }}
            >
              {t("adb.restartServer")}
            </Button>
            <Button
              variant="secondary"
              icon={<Wrench size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                setStatusText(t("adb.fixing"));
                const r = await DeviceService.adbAutoFix();
                setStatusText(r.success ? r.stdout || t("adb.fixDone") : r.stderr || t("adb.fixFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.fixFailed"));
                await load();
              }}
            >
              {t("adb.autoFix")}
            </Button>
            <Button
              icon={<Unplug size={14} />}
              disabled={!adbOk}
              onClick={async () => {
                if (!(await askConfirm(t("adb.confirmDisconnectAll")))) return;
                const r = await DeviceService.adbDisconnect("");
                setStatusText(r.success ? t("adb.disconnectedAll") : r.stderr || t("adb.disconnectFailed"));
                if (!r.success) void alert(r.stderr || r.stdout || t("adb.disconnectFailed"));
                await load();
              }}
            >
              {t("adb.disconnectAll")}
            </Button>
          </div>
        </Card>

        <Card title={t("adb.deviceList")}>
          {loading ? (
            <Skeleton count={4} height={32} />
          ) : info?.devices.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>{t("adb.table.state")}</th>
                  <th>{t("adb.table.model")}</th>
                  <th>{t("adb.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {info.devices.map((d) => (
                  <tr key={d.serial}>
                    <td className="mono">
                      <button
                        type="button"
                        title={t("adb.copySerial")}
                        style={{
                          textDecoration: "underline",
                          background: "none",
                          border: 0,
                          padding: 0,
                          color: "inherit",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          void copyText(d.serial).then(
                            () => setStatusText(t("common.panel.copied", { value: d.serial })),
                            () => setStatusText(t("common.panel.copyFailed")),
                          );
                        }}
                      >
                        {d.serial}
                      </button>
                    </td>
                    <td>
                      <span className={`badge ${d.state === "device" ? "online" : "warn"}`}>{d.state}</span>
                    </td>
                    <td>{d.model || d.product || "—"}</td>
                    <td>
                      <div className="row">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelected(d.serial);
                            navigate(`/devices/${encodeURIComponent(d.serial)}`);
                          }}
                        >
                          {t("common.open")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={!adbOk}
                          onClick={async () => {
                            const r = await DeviceService.adbReconnect(d.serial);
                            setStatusText(r.success ? t("adb.reconnected", { serial: d.serial }) : r.stderr || t("adb.restartFailed"));
                            if (!r.success) void alert(r.stderr || r.stdout || t("adb.restartFailed"));
                            await load();
                          }}
                        >
                          {t("adb.reconnect")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!adbOk}
                          onClick={async () => {
                            const r = await DeviceService.adbDisconnect(d.serial);
                            setStatusText(r.success ? t("adb.disconnected", { serial: d.serial }) : r.stderr || t("adb.disconnectFailed"));
                            if (!r.success) void alert(r.stderr || r.stdout || t("adb.disconnectFailed"));
                            await load();
                          }}
                        >
                          {t("adb.disconnect")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              {t("adb.noDevices")}
              <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
                <Button size="sm" variant="primary" onClick={() => navigate("/docker")}>
                  {t("common.panel.goCreate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate("/devices")}>
                  {t("devices.page.title")}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
