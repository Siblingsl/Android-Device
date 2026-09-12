import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Grid2X2, RotateCcw, X } from "lucide-react";
import { arrangementAutoRestoreEnabled, readArrangement, resetArrangement, saveArrangement, setArrangementAutoRestoreEnabled, type ArrangementItem } from "../../stores/layoutStore";
import type { DeviceInfo } from "../../types";
import { DeviceService } from "../../services/deviceService";
import { DeviceStream } from "../device/DeviceStream";
import { Button } from "../ui/Button";

interface Props {
  devices: DeviceInfo[];
  setStatusText: (text: string) => void;
  onClose: () => void;
}

export function ArrangementDialog({ devices, setStatusText, onClose }: Props) {
  const [items, setItems] = useState<ArrangementItem[]>(() => readArrangement(devices));
  const [dragged, setDragged] = useState<string | null>(null);
  const [columns, setColumns] = useState(2);
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(arrangementAutoRestoreEnabled);
  const byId = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
  const ordered = [...items].sort((a, b) => a.order - b.order).filter((item) => byId.has(item.id));

  const move = (id: string, delta: -1 | 1) => {
    const index = ordered.findIndex((item) => item.id === id);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setItems(next.map((item, itemIndex) => ({ ...item, order: itemIndex })));
  };

  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId) return;
    const source = ordered.findIndex((item) => item.id === dragged);
    const target = ordered.findIndex((item) => item.id === targetId);
    if (source < 0 || target < 0) return;
    const next = [...ordered];
    const [picked] = next.splice(source, 1);
    next.splice(target, 0, picked);
    setItems(next.map((item, itemIndex) => ({ ...item, order: itemIndex })));
    setDragged(null);
  };

  const updateSpan = (id: string, span: 1 | 2) => setItems((current) => current.map((item) => item.id === id ? { ...item, span } : item));
  const updateItem = (id: string, patch: Partial<ArrangementItem>) => setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const openNative = async (item: ArrangementItem, device: DeviceInfo) => {
    try {
      // A user opening a single window expects the current editor values to be
      // the values restored on the next launch as well.
      saveArrangement(items);
      await DeviceService.openDeviceWindow(device.id, device.name || device.serial, item.x, item.y, item.width * (item.span === 2 ? 2 : 1), item.height);
      setStatusText(`${device.name} 已打开独立窗口`);
    } catch (error) {
      setStatusText(`打开 ${device.name} 独立窗口失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="arrangement-layer" role="dialog" aria-modal="true" aria-label="设备窗口编排">
      <section className="arrangement-dialog module">
        <div className="module-head arrangement-head">
          <div className="row"><Grid2X2 size={15} /><div><div className="module-title">设备窗口编排</div><div className="muted arrangement-subtitle">拖动设备调整顺序，选择宽度后保存布局</div></div></div>
          <div className="row">
            <label className="arrangement-columns">列数<select value={columns} onChange={(event) => setColumns(Number(event.target.value))}><option value={1}>1 列</option><option value={2}>2 列</option><option value={3}>3 列</option><option value={4}>4 列</option></select></label>
            <Button size="sm" variant="ghost" onClick={() => setItems(resetArrangement(devices))}><RotateCcw size={13} />重置</Button>
            <label className="row muted arrangement-restore-toggle"><input type="checkbox" checked={restoreOnLaunch} onChange={(event) => { setRestoreOnLaunch(event.target.checked); setArrangementAutoRestoreEnabled(event.target.checked); }} />下次启动恢复窗口</label>
            <Button size="sm" variant="ghost" onClick={() => { saveArrangement(items); for (const item of ordered) { const device = byId.get(item.id); if (device) void openNative(item, device); } }}>打开全部独立窗口</Button>
            <Button size="sm" variant="primary" onClick={() => { saveArrangement(items); setStatusText("设备布局已保存"); onClose(); }}>保存</Button>
            <Button size="sm" variant="ghost" onClick={onClose}><X size={14} /></Button>
          </div>
        </div>
        <div className="arrangement-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {ordered.map((item, index) => {
            const device = byId.get(item.id)!;
            const online = device.online && device.adbStatus === "device";
            return <article key={item.id} className="arrangement-tile module" style={{ gridColumn: `span ${Math.min(item.span, columns)}`, minHeight: item.height }} draggable onDragStart={() => setDragged(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => drop(item.id)}>
              <div className="arrangement-tile-head">
                <div className="row arrangement-device-name"><span className="drag-grip">⋮⋮</span><strong>{device.name}</strong><span className={`badge ${online ? "online" : "offline"}`}>{online ? "在线" : "离线"}</span></div>
                <div className="row"><button type="button" title="上移" disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp size={12} /></button><button type="button" title="下移" disabled={index === ordered.length - 1} onClick={() => move(item.id, 1)}><ArrowDown size={12} /></button><select aria-label={`${device.name} 宽度`} value={item.span} onChange={(event) => updateSpan(item.id, Number(event.target.value) === 2 ? 2 : 1)}><option value={1}>半宽</option><option value={2}>通栏</option></select><label className="arrangement-size-field">宽<input type="number" min={320} max={2400} step={20} value={item.width} onChange={(event) => updateItem(item.id, { width: Math.max(320, Math.min(2400, Number(event.target.value) || 560)) })} /></label><label className="arrangement-size-field">高<input type="number" min={240} max={1400} step={20} value={item.height} onChange={(event) => updateItem(item.id, { height: Math.max(240, Math.min(1400, Number(event.target.value) || 360)) })} /></label><label className="arrangement-size-field">X<input type="number" value={item.x} onChange={(event) => updateItem(item.id, { x: Number(event.target.value) || 0 })} /></label><label className="arrangement-size-field">Y<input type="number" value={item.y} onChange={(event) => updateItem(item.id, { y: Number(event.target.value) || 0 })} /></label><Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} disabled={!online} onClick={() => void openNative(item, device)}>独立窗口</Button></div>
              </div>
              <DeviceStream serial={device.serial} resolution={device.resolution} disabled={!online} setStatusText={setStatusText} onTakeScreenshot={() => void DeviceService.screenshot(device.serial).then((result) => setStatusText(result.success ? `${device.name} 截图已保存：${result.path}` : result.error || `${device.name} 截图失败`)).catch((error) => setStatusText(`${device.name} 截图失败：${error instanceof Error ? error.message : String(error)}`))} />
            </article>;
          })}
          {!ordered.length && <div className="empty-state">没有可编排的设备</div>}
        </div>
      </section>
    </div>
  );
}
