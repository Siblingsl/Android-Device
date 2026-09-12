import { useEffect, useState } from "react";
import { Battery, Save } from "lucide-react";
import { DeviceService } from "../../services/deviceService";
import { getDeviceMetadata, setDeviceMetadata, type DeviceMetadata } from "../../lib/deviceMetadata";
import type { DeviceInfo, DeviceTelemetry } from "../../types";
import { Button } from "../ui/Button";

export function DeviceMetadataPanel({ device }: { device: DeviceInfo }) {
  const [form, setForm] = useState<DeviceMetadata>(() => getDeviceMetadata(device.id));
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);

  useEffect(() => setForm(getDeviceMetadata(device.id)), [device.id]);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (!device.online || device.adbStatus !== "device") return;
      try {
        const next = await DeviceService.getDeviceTelemetry(device.serial);
        if (!disposed) setTelemetry(next);
      } catch {
        if (!disposed) setTelemetry(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [device.id, device.serial, device.online, device.adbStatus]);

  const set = <K extends keyof DeviceMetadata>(key: K, value: DeviceMetadata[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => setDeviceMetadata(device.id, form);
  const addLabel = () => {
    const label = prompt("添加标签", "")?.trim();
    if (label) set("labels", [...new Set([...form.labels, label])].slice(0, 30));
  };

  return (
    <section className="module device-metadata-panel" aria-label="设备资产信息">
      <div className="module-head"><div className="row"><Battery size={14} /><div className="module-title">设备资产与遥测</div></div><Button size="sm" variant="primary" icon={<Save size={13} />} onClick={save}>保存</Button></div>
      <div className="device-metadata-body">
        <div className="form-grid device-metadata-fields">
          <label className="field">设备备注<input value={form.remark} onChange={(event) => set("remark", event.target.value)} placeholder="例如：测试机 A" /></label>
          <label className="field">设备分组<input value={form.group} onChange={(event) => set("group", event.target.value)} placeholder="未分组" /></label>
          <div className="field"><label>标签</label><div className="row metadata-labels">{form.labels.map((label) => <button key={label} type="button" onClick={() => set("labels", form.labels.filter((item) => item !== label))}>{label} ×</button>)}<Button size="sm" variant="ghost" onClick={addLabel}>添加标签</Button></div></div>
        </div>
        <div className="row metadata-switches"><label className="row"><input type="checkbox" checked={form.autoConnect} onChange={(event) => set("autoConnect", event.target.checked)} />启动时自动连接</label><label className="row"><input type="checkbox" checked={form.autoMirror} onChange={(event) => set("autoMirror", event.target.checked)} />连接后自动投屏</label></div>
        <div className="metadata-telemetry"><span>电量 <strong>{telemetry?.batteryLevel != null && telemetry.batteryLevel >= 0 ? `${telemetry.batteryLevel}%` : "—"}</strong></span><span>温度 <strong>{telemetry?.batteryTemperature || "—"}</strong></span><span>电源 <strong>{telemetry?.powerState || "—"}</strong></span><span>电压 <strong>{telemetry?.voltage || "—"}</strong></span><span className="muted">{telemetry?.updatedAt ? new Date(telemetry.updatedAt).toLocaleTimeString() : "遥测未读取"}</span></div>
      </div>
    </section>
  );
}
