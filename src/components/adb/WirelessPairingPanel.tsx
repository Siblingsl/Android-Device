import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Cable, Copy, Link2, QrCode, RefreshCw, Search, Unplug } from "lucide-react";
import { DeviceService } from "../../services/deviceService";
import { Button } from "../ui/Button";
import type { AdbDevice, WirelessDiscovery } from "../../types";

interface Props {
  adbOk: boolean;
  devices: AdbDevice[];
  setStatusText: (text: string) => void;
  onRefresh: () => Promise<void>;
}

const SAVED_KEY = "rdc.adb.wireless.saved";
const AUTO_RECONNECT_KEY = "rdc.adb.wireless.auto-reconnect";

function readSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function WirelessPairingPanel({ adbOk, devices, setStatusText, onRefresh }: Props) {
  const [address, setAddress] = useState(() => readSaved()[0] || "192.168.1.10:37123");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(readSaved);
  const [autoReconnect, setAutoReconnect] = useState(() => localStorage.getItem(AUTO_RECONNECT_KEY) === "true");
  const [discovery, setDiscovery] = useState<WirelessDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [qr, setQr] = useState("");
  const [tcpipSerial, setTcpipSerial] = useState("");
  const [tcpipPort, setTcpipPort] = useState("5555");

  useEffect(() => {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch {
      /* optional */
    }
  }, [saved]);

  useEffect(() => {
    try { localStorage.setItem(AUTO_RECONNECT_KEY, String(autoReconnect)); } catch { /* optional */ }
  }, [autoReconnect]);

  useEffect(() => {
    if (!adbOk || !autoReconnect || !saved.length) return;
    let disposed = false;
    void (async () => {
      for (const service of saved.slice(0, 12)) {
        if (disposed) return;
        const result = await DeviceService.adbConnect(service);
        if (result.success) setStatusText(`已自动重连 ${service}`);
      }
      if (!disposed) await onRefresh();
    })();
    return () => { disposed = true; };
  }, [adbOk, autoReconnect, saved, setStatusText]);

  useEffect(() => {
    if (!address.trim() || !code.trim()) {
      setQr("");
      return;
    }
    void QRCode.toDataURL(`WIFI:T:ADB;S:${address.trim()};P:${code.trim()};;`, { margin: 1, width: 150 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [address, code]);

  const pair = async () => {
    if (!address.trim() || !code.trim()) {
      setStatusText("请输入配对地址和配对码");
      return;
    }
    setPairing(true);
    const result = await DeviceService.adbPair(address.trim(), code.trim());
    setPairing(false);
    const message = result.success ? result.stdout || "ADB 配对成功" : result.stderr || result.stdout || "ADB 配对失败";
    setStatusText(message);
    if (result.success) setSaved((current) => [address.trim(), ...current.filter((item) => item !== address.trim())].slice(0, 12));
    if (result.success) await onRefresh();
  };

  const discover = async () => {
    setDiscovering(true);
    const result = await DeviceService.adbDiscover();
    setDiscovery(result);
    setDiscovering(false);
    setStatusText(result.message || (result.services.length ? `发现 ${result.services.length} 个无线服务` : "没有发现无线服务"));
  };

  const connect = async (service: string) => {
    setStatusText(`正在连接 ${service}`);
    const result = await DeviceService.adbConnect(service);
    setStatusText(result.success ? result.stdout || "ADB 已连接" : result.stderr || result.stdout || "ADB 连接失败");
    if (result.success) await onRefresh();
  };

  const tcpip = async () => {
    if (!tcpipSerial || !Number.isInteger(Number(tcpipPort)) || Number(tcpipPort) < 1 || Number(tcpipPort) > 65535) return;
    const result = await DeviceService.adbTcpip(tcpipSerial, Number(tcpipPort));
    setStatusText(result.success ? result.stdout || "已切换无线 ADB" : result.stderr || result.stdout || "切换无线 ADB 失败");
  };

  return (
    <section className="module wireless-panel">
      <div className="module-head">
        <div className="row"><QrCode size={14} /><div className="module-title">无线 ADB 配对与发现</div></div>
        <Button size="sm" variant="ghost" disabled={!adbOk || discovering} loading={discovering} onClick={() => void discover()}><Search size={13} />发现服务</Button>
      </div>
      <div className="wireless-panel-body">
        <div className="wireless-form">
          <div className="field"><label>配对地址</label><input list="saved-wireless-addresses" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="192.168.1.10:37123" /><datalist id="saved-wireless-addresses">{saved.map((item) => <option key={item} value={item} />)}</datalist></div>
          <div className="field"><label>配对码</label><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 16))} inputMode="numeric" placeholder="输入 Android 无线调试配对码" /></div>
          <div className="row wireless-form-actions">
            <Button variant="primary" disabled={!adbOk || pairing} loading={pairing} onClick={() => void pair()}><Link2 size={13} />ADB Pair</Button>
            <Button size="sm" variant="ghost" onClick={() => setSaved((current) => current.includes(address.trim()) ? current.filter((item) => item !== address.trim()) : [address.trim(), ...current])}><Copy size={13} />{saved.includes(address.trim()) ? "移除地址" : "保存地址"}</Button>
            <label className="row muted wireless-auto-reconnect"><input type="checkbox" checked={autoReconnect} onChange={(event) => setAutoReconnect(event.target.checked)} />启动时自动重连已保存地址</label>
          </div>
          {qr && <div className="wireless-qr"><img src={qr} alt="ADB 配对信息二维码" /><span>可扫描此二维码携带配对地址和配对码</span></div>}
        </div>
        <div className="wireless-discovery">
          <div className="row-between"><strong>发现的服务</strong><span className="muted">{discovery?.services.length ?? 0}</span></div>
          {discovery?.services.length ? discovery.services.map((service) => <div className="wireless-service" key={service}><span className="mono">{service}</span><Button size="sm" onClick={() => void connect(service)}><Link2 size={13} />连接</Button></div>) : <div className="empty-state">点击“发现服务”扫描 mDNS 无线 ADB 服务</div>}
          <div className="wireless-tcpip">
            <div className="row"><Cable size={13} /><strong>USB 转 Wi-Fi</strong></div>
            <div className="row"><select value={tcpipSerial} onChange={(event) => setTcpipSerial(event.target.value)}><option value="">选择在线设备</option>{devices.filter((device) => device.state === "device").map((device) => <option key={device.serial} value={device.serial}>{device.serial}</option>)}</select><input value={tcpipPort} onChange={(event) => setTcpipPort(event.target.value)} aria-label="无线 ADB 端口" /><Button size="sm" disabled={!tcpipSerial} onClick={() => void tcpip()}><RefreshCw size={13} />切换</Button></div>
            <span className="muted">切换后请用设备显示的 IP:端口进行连接</span>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><Button size="sm" variant="ghost" disabled={!adbOk} onClick={() => void DeviceService.adbDisconnect("").then((result) => setStatusText(result.success ? "已断开无线设备" : result.stderr || "断开失败"))}><Unplug size={13} />断开全部无线设备</Button></div>
        </div>
      </div>
    </section>
  );
}
