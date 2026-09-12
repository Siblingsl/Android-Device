import { useEffect, useState } from "react";
import { CircleStop, FolderOpen, Mic, Video } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { DeviceService } from "../../services/deviceService";
import type { RecordingSession } from "../../types";
import { Button } from "../ui/Button";

type Mode = "video" | "audio" | "av" | "camera" | "camera-record" | "otg";
type OtgGamepad = "" | "disabled" | "uhid" | "aoa";

interface Props {
  serial: string;
  online: boolean;
  setStatusText: (text: string) => void;
}

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "video", label: "屏幕录制" },
  { value: "audio", label: "仅录音" },
  { value: "av", label: "音视频" },
  { value: "camera", label: "摄像头镜像" },
  { value: "camera-record", label: "摄像头录制" },
  { value: "otg", label: "OTG 输入" },
];

export function RecordingPanel({ serial, online, setStatusText }: Props) {
  const [mode, setMode] = useState<Mode>("video");
  const [session, setSession] = useState<RecordingSession>({
    serial,
    mode: "video",
    status: "stopped",
    outputPath: "",
    message: "",
  });
  const [outputPath, setOutputPath] = useState("");
  const [cameraFacing, setCameraFacing] = useState("back");
  const [cameraId, setCameraId] = useState("");
  const [cameraAr, setCameraAr] = useState("");
  const [cameraHighSpeed, setCameraHighSpeed] = useState(false);
  const [cameraTorch, setCameraTorch] = useState(false);
  const [cameraZoom, setCameraZoom] = useState<number | null>(null);
  const [cameraSize, setCameraSize] = useState("");
  const [cameraFps, setCameraFps] = useState(30);
  const [timeLimit, setTimeLimit] = useState(0);
  const [recordFormat, setRecordFormat] = useState("");
  const [recordOrientation, setRecordOrientation] = useState("");
  const [otgGamepad, setOtgGamepad] = useState<OtgGamepad>("");

  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      if (!online) return;
      try {
        const next = await DeviceService.recordingStatus(serial);
        if (!disposed) setSession(next);
      } catch {
        // The native status probe is best-effort while the device route changes.
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [serial, online]);

  const start = async () => {
    if (!online) return;
    const next = await DeviceService.recordingStart(
      serial,
      mode,
      outputPath,
      cameraFacing,
      cameraId,
      cameraAr,
      cameraHighSpeed,
      cameraSize,
      cameraFps,
      timeLimit,
      recordFormat,
      recordOrientation,
      cameraTorch,
      cameraZoom,
      otgGamepad,
    );
    setSession(next);
    setStatusText(next.status === "running" ? `已开始${MODES.find((item) => item.value === mode)?.label}` : next.message);
  };

  const stop = async () => {
    const result = await DeviceService.recordingStop(serial);
    setSession((current) => ({ ...current, status: result.success ? "stopped" : "error", message: result.success ? "录制已停止" : result.stderr || result.stdout || "停止录制失败" }));
    setStatusText(result.success ? "录制已停止" : result.stderr || result.stdout || "停止录制失败");
  };

  const chooseDirectory = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) {
      const extension = recordFormat || (mode === "audio" ? "mka" : "mp4");
      setOutputPath(`${picked.replace(/[\\/]$/, "")}/recording-${Date.now()}.${extension}`);
    }
  };

  const running = session.status === "running";
  const otg = mode === "otg";

  return (
    <section className="module recording-panel" aria-label="录制与设备输入">
      <div className="module-head">
        <div className="module-title">录制与设备输入</div>
        <span className={`badge ${running ? "online" : session.status === "error" ? "offline" : "info"}`}>
          {running ? "进行中" : session.status === "error" ? "失败" : "已停止"}
        </span>
      </div>
      <div className="recording-panel-body">
        <div className="row recording-modes">
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={mode === item.value ? "active" : ""}
              disabled={running}
              onClick={() => setMode(item.value)}
            >
              {item.value === "audio" ? <Mic size={13} /> : <Video size={13} />}
              {item.label}
            </button>
          ))}
        </div>
        {!otg && (
          <div className="recording-options">
            {mode !== "camera" ? (
              <div className="field">
                <label>输出文件（留空使用设置中的录制目录）</label>
                <div className="row">
                  <input value={outputPath} disabled={running} onChange={(event) => setOutputPath(event.target.value)} placeholder="自动生成文件名" />
                  <Button size="sm" variant="ghost" disabled={running} icon={<FolderOpen size={13} />} onClick={() => void chooseDirectory()}>目录</Button>
                </div>
              </div>
            ) : (
              <div className="notice">摄像头镜像直接打开设备画面，不生成录制文件。</div>
            )}
            {(mode === "camera" || mode === "camera-record") && (
              <div className="row recording-camera-options">
                <label>摄像头<select value={cameraFacing} disabled={running || Boolean(cameraId.trim())} onChange={(event) => setCameraFacing(event.target.value)}><option value="back">后置</option><option value="front">前置</option><option value="external">外接</option></select></label>
                <label>摄像头 ID<input value={cameraId} disabled={running} onChange={(event) => setCameraId(event.target.value)} placeholder="默认" /></label>
                <label>画面比例<input value={cameraAr} disabled={running} onChange={(event) => setCameraAr(event.target.value)} placeholder="例如 4:3" /></label>
                <label>分辨率<input value={cameraSize} disabled={running} onChange={(event) => setCameraSize(event.target.value)} placeholder="1920x1080" /></label>
                <label>FPS<input type="number" min={1} max={240} value={cameraFps} disabled={running} onChange={(event) => setCameraFps(Math.max(1, Number(event.target.value) || 30))} /></label>
                <label>变焦<input type="number" min={0} max={100} step={0.1} value={cameraZoom ?? ""} disabled={running} onChange={(event) => setCameraZoom(event.target.value === "" ? null : Number(event.target.value))} placeholder="设备支持时可用" /></label>
                <label className="row"><input type="checkbox" checked={cameraTorch} disabled={running} onChange={(event) => setCameraTorch(event.target.checked)} />闪光灯</label>
                <label className="row"><input type="checkbox" checked={cameraHighSpeed} disabled={running} onChange={(event) => setCameraHighSpeed(event.target.checked)} />高速</label>
              </div>
            )}
            {mode !== "camera" && (
              <>
                <label className="recording-limit">时长限制（秒，0 为不限）<input type="number" min={0} max={86400} value={timeLimit} disabled={running} onChange={(event) => setTimeLimit(Math.max(0, Number(event.target.value) || 0))} /></label>
                <div className="row recording-format-options">
                  <label>录制格式<select value={recordFormat} disabled={running} onChange={(event) => setRecordFormat(event.target.value)}><option value="">按文件名</option><option value="mp4">MP4</option><option value="mkv">MKV</option>{mode === "audio" && <><option value="mka">MKA</option><option value="m4a">M4A</option><option value="opus">Opus</option><option value="aac">AAC</option><option value="flac">FLAC</option><option value="wav">WAV</option></>}</select></label>
                  <label>录制方向<select value={recordOrientation} disabled={running} onChange={(event) => setRecordOrientation(event.target.value)}><option value="">跟随屏幕</option><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
                </div>
              </>
            )}
          </div>
        )}
        {otg && (
          <div className="recording-otg-options">
            <label>游戏手柄模式
              <select value={otgGamepad} disabled={running} onChange={(event) => setOtgGamepad(event.target.value as OtgGamepad)}>
                <option value="">默认（禁用）</option>
                <option value="disabled">禁用</option>
                <option value="uhid">UHID</option>
                <option value="aoa">AOA</option>
              </select>
            </label>
            <span className="muted">OTG 不传输画面和音频，只转发输入。</span>
          </div>
        )}
        <div className="row recording-actions">
          {running ? <Button variant="danger" icon={<CircleStop size={14} />} onClick={() => void stop()}>停止</Button> : <Button variant="primary" disabled={!online} onClick={() => void start()}>{otg ? "启动 OTG" : "开始"}</Button>}
          <span className="muted recording-message">{session.message || (online ? "可开始新的会话" : "设备离线，需在线")}</span>
          {session.outputPath && <button type="button" className="mono muted recording-output" onClick={() => void DeviceService.revealInFolder(session.outputPath)}>{session.outputPath}</button>}
        </div>
      </div>
    </section>
  );
}
