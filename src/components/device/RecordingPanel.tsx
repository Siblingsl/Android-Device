import { useEffect, useState } from "react";
import { CircleStop, FolderOpen, Mic, Video } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { DeviceService } from "../../services/deviceService";
import type { RecordingSession } from "../../types";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";

type Mode = "video" | "audio" | "av" | "camera" | "camera-record" | "otg";
type OtgGamepad = "" | "disabled" | "uhid" | "aoa";

interface Props {
  serial: string;
  online: boolean;
  setStatusText: (text: string) => void;
}

const MODES: Array<{ value: Mode; key: string }> = [
  { value: "video", key: "detail.recording.mode.video" },
  { value: "audio", key: "detail.recording.mode.audio" },
  { value: "av", key: "detail.recording.mode.av" },
  { value: "camera", key: "detail.recording.mode.camera" },
  { value: "camera-record", key: "detail.recording.mode.cameraRecord" },
  { value: "otg", key: "detail.recording.mode.otg" },
];

export function RecordingPanel({ serial, online, setStatusText }: Props) {
  const { t } = useI18n();
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

  const modeLabel = (value: Mode) =>
    t(MODES.find((item) => item.value === value)?.key ?? "detail.recording.mode.video");

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
    setStatusText(next.status === "running" ? t("detail.recording.started", { mode: modeLabel(mode) }) : next.message);
  };

  const stop = async () => {
    const result = await DeviceService.recordingStop(serial);
    setSession((current) => ({ ...current, status: result.success ? "stopped" : "error", message: result.success ? t("detail.recording.stoppedMsg") : result.stderr || result.stdout || t("detail.recording.stopFailed") }));
    setStatusText(result.success ? t("detail.recording.stoppedMsg") : result.stderr || result.stdout || t("detail.recording.stopFailed"));
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
    <section className="module recording-panel" aria-label={t("detail.recording.title")}>
      <div className="module-head">
        <div className="module-title">{t("detail.recording.title")}</div>
        <span className={`badge ${running ? "online" : session.status === "error" ? "offline" : "info"}`}>
          {running ? t("detail.recording.running") : session.status === "error" ? t("detail.recording.error") : t("detail.recording.idle")}
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
              {t(item.key)}
            </button>
          ))}
        </div>
        {!otg && (
          <div className="recording-options">
            {mode !== "camera" ? (
              <div className="field">
                <label>{t("detail.recording.outputLabel")}</label>
                <div className="row">
                  <input value={outputPath} disabled={running} onChange={(event) => setOutputPath(event.target.value)} placeholder={t("detail.recording.outputPlaceholder")} />
                  <Button size="sm" variant="ghost" disabled={running} icon={<FolderOpen size={13} />} onClick={() => void chooseDirectory()}>{t("detail.recording.chooseDir")}</Button>
                </div>
              </div>
            ) : (
              <div className="notice">{t("detail.recording.cameraNotice")}</div>
            )}
            {(mode === "camera" || mode === "camera-record") && (
              <div className="row recording-camera-options">
                <label>{t("detail.recording.camera")}<select value={cameraFacing} disabled={running || Boolean(cameraId.trim())} onChange={(event) => setCameraFacing(event.target.value)}><option value="back">{t("detail.recording.back")}</option><option value="front">{t("detail.recording.front")}</option><option value="external">{t("detail.recording.external")}</option></select></label>
                <label>{t("detail.recording.cameraId")}<input value={cameraId} disabled={running} onChange={(event) => setCameraId(event.target.value)} placeholder={t("detail.recording.default")} /></label>
                <label>{t("detail.recording.aspect")}<input value={cameraAr} disabled={running} onChange={(event) => setCameraAr(event.target.value)} placeholder="4:3" /></label>
                <label>{t("detail.recording.resolution")}<input value={cameraSize} disabled={running} onChange={(event) => setCameraSize(event.target.value)} placeholder="1920x1080" /></label>
                <label>FPS<input type="number" min={1} max={240} value={cameraFps} disabled={running} onChange={(event) => setCameraFps(Math.max(1, Number(event.target.value) || 30))} /></label>
                <label>{t("detail.recording.zoom")}<input type="number" min={0} max={100} step={0.1} value={cameraZoom ?? ""} disabled={running} onChange={(event) => setCameraZoom(event.target.value === "" ? null : Number(event.target.value))} placeholder={t("detail.recording.zoomHint")} /></label>
                <label className="row"><input type="checkbox" checked={cameraTorch} disabled={running} onChange={(event) => setCameraTorch(event.target.checked)} />{t("detail.recording.torch")}</label>
                <label className="row"><input type="checkbox" checked={cameraHighSpeed} disabled={running} onChange={(event) => setCameraHighSpeed(event.target.checked)} />{t("detail.recording.highSpeed")}</label>
              </div>
            )}
            {mode !== "camera" && (
              <>
                <label className="recording-limit">{t("detail.recording.limitLabel")}<input type="number" min={0} max={86400} value={timeLimit} disabled={running} onChange={(event) => setTimeLimit(Math.max(0, Number(event.target.value) || 0))} /></label>
                <div className="row recording-format-options">
                  <label>{t("detail.recording.format")}<select value={recordFormat} disabled={running} onChange={(event) => setRecordFormat(event.target.value)}><option value="">{t("detail.recording.formatByExt")}</option><option value="mp4">MP4</option><option value="mkv">MKV</option>{mode === "audio" && <><option value="mka">MKA</option><option value="m4a">M4A</option><option value="opus">Opus</option><option value="aac">AAC</option><option value="flac">FLAC</option><option value="wav">WAV</option></>}</select></label>
                  <label>{t("detail.recording.orientation")}<select value={recordOrientation} disabled={running} onChange={(event) => setRecordOrientation(event.target.value)}><option value="">{t("detail.recording.followScreen")}</option><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
                </div>
              </>
            )}
          </div>
        )}
        {otg && (
          <div className="recording-otg-options">
            <label>{t("detail.recording.gamepad")}
              <select value={otgGamepad} disabled={running} onChange={(event) => setOtgGamepad(event.target.value as OtgGamepad)}>
                <option value="">{t("detail.recording.gamepadDefault")}</option>
                <option value="disabled">{t("detail.recording.gamepadDisabled")}</option>
                <option value="uhid">UHID</option>
                <option value="aoa">AOA</option>
              </select>
            </label>
            <span className="muted">{t("detail.recording.otgHint")}</span>
          </div>
        )}
        <div className="row recording-actions">
          {running ? <Button variant="danger" icon={<CircleStop size={14} />} onClick={() => void stop()}>{t("detail.recording.stop")}</Button> : <Button variant="primary" disabled={!online} onClick={() => void start()}>{otg ? t("detail.recording.startOtg") : t("detail.recording.start")}</Button>}
          <span className="muted recording-message">{session.message || (online ? t("detail.recording.ready") : t("detail.recording.offline"))}</span>
          {session.outputPath && <button type="button" className="mono muted recording-output" onClick={() => void DeviceService.revealInFolder(session.outputPath)}>{session.outputPath}</button>}
        </div>
      </div>
    </section>
  );
}
