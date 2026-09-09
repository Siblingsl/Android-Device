import { useEffect, useState } from "react";
import { Camera, CircleStop, LockKeyhole, Power, RotateCw, VolumeX } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";
import {
  DEFAULT_CAMERA_OPTIONS,
  DEFAULT_RECORDING_OPTIONS,
  ensureRecordingExtension,
  normalizeCameraOptions,
  normalizeRecordingOptions,
} from "../../lib/scrcpyMedia";
import type { ScrcpyCameraOptions, ScrcpyRecordingOptions } from "../../types";

type RotationMode = "portrait" | "landscape" | "auto" | "lock";
type DeviceMediaAction = "mute" | "screenOff" | "reboot" | "shutdown";

interface DeviceMediaControlsProps {
  disabled?: boolean;
  busy?: string | null;
  onRecordingStart: (options: ScrcpyRecordingOptions) => Promise<boolean>;
  onRecordingStop: () => Promise<boolean>;
  onRecordingStatus?: () => Promise<string>;
  onCameraStart: (options: ScrcpyCameraOptions) => Promise<boolean>;
  onCameraStop: () => Promise<boolean>;
  onCameraStatus?: () => Promise<string>;
  onRotation: (mode: RotationMode) => Promise<boolean>;
  onDeviceAction: (action: DeviceMediaAction) => Promise<boolean>;
}

function defaultRecordingName(format: "mp4" | "mkv"): string {
  const stamp = new Date().toISOString().replace(/[T:]/g, "-").replace(/\.\d{3}Z$/, "");
  return `redroid-${stamp}.${format}`;
}

export function DeviceMediaControls({
  disabled = false,
  busy = null,
  onRecordingStart,
  onRecordingStop,
  onRecordingStatus,
  onCameraStart,
  onCameraStop,
  onCameraStatus,
  onRotation,
  onDeviceAction,
}: DeviceMediaControlsProps) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [cameraMirroring, setCameraMirroring] = useState(false);
  const [recordingFormat, setRecordingFormat] = useState<"mp4" | "mkv">(DEFAULT_RECORDING_OPTIONS.format);
  const [recordingSource, setRecordingSource] = useState<"display" | "camera">("display");
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [recordingAudioOnly, setRecordingAudioOnly] = useState(false);
  const [audioSource, setAudioSource] = useState<"output" | "playback" | "mic">("output");
  const [timeLimit, setTimeLimit] = useState(0);
  const [camera, setCamera] = useState<ScrcpyCameraOptions>(DEFAULT_CAMERA_OPTIONS);
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const blocked = disabled || Boolean(busy) || Boolean(localBusy);

  useEffect(() => {
    if (!recording || !onRecordingStatus) return;
    const timer = window.setInterval(() => {
      void onRecordingStatus().then((status) => {
        if (status !== "running") setRecording(false);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [onRecordingStatus, recording]);

  useEffect(() => {
    if (!cameraMirroring || !onCameraStatus) return;
    const timer = window.setInterval(() => {
      void onCameraStatus().then((status) => {
        if (status !== "running") setCameraMirroring(false);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [cameraMirroring, onCameraStatus]);

  const updateCamera = (patch: Partial<ScrcpyCameraOptions>) => {
    // Keep the in-progress text while editing; normalize only when starting a
    // process so a value such as "1280x" can still be completed to a size.
    setCamera((current) => ({ ...current, ...patch }));
  };

  const startRecording = async () => {
    if (blocked || recording) return;
    setLocalBusy("recording-start");
    try {
      const selected = await save({
        defaultPath: defaultRecordingName(recordingFormat),
        filters: [{ name: "Video", extensions: [recordingFormat] }],
      });
      if (!selected) return;
      const options = normalizeRecordingOptions({
        ...DEFAULT_RECORDING_OPTIONS,
        ...camera,
        outputPath: ensureRecordingExtension(selected, recordingFormat),
        format: recordingFormat,
        videoSource: recordingAudioOnly ? "display" : recordingSource,
        audio: recordingAudio || recordingAudioOnly,
        audioOnly: recordingAudioOnly,
        audioSource,
        timeLimitSecs: timeLimit,
      });
      if (await onRecordingStart(options)) setRecording(true);
    } finally {
      setLocalBusy(null);
    }
  };

  const stopRecording = async () => {
    if (blocked || !recording) return;
    setLocalBusy("recording-stop");
    try {
      if (await onRecordingStop()) setRecording(false);
    } finally {
      setLocalBusy(null);
    }
  };

  const toggleCamera = async () => {
    if (blocked) return;
    setLocalBusy(cameraMirroring ? "camera-stop" : "camera-start");
    try {
      const success = cameraMirroring
        ? await onCameraStop()
        : await onCameraStart(normalizeCameraOptions(camera));
      if (success) setCameraMirroring(!cameraMirroring);
    } finally {
      setLocalBusy(null);
    }
  };

  const runRotation = (mode: RotationMode) => {
    if (blocked) return;
    setLocalBusy(`rotation-${mode}`);
    void onRotation(mode).finally(() => setLocalBusy(null));
  };

  const runDeviceAction = (action: DeviceMediaAction) => {
    if (blocked) return;
    setLocalBusy(action);
    void onDeviceAction(action).finally(() => setLocalBusy(null));
  };

  return (
    <Card title={t("detail.media.title")} padding>
      <div className="media-control-grid">
        <section className="media-control-block">
          <div className="media-control-heading"><Camera size={14} />{t("detail.media.recording")}</div>
          <div className="media-control-row">
            <select aria-label={t("detail.media.videoSource")} value={recordingSource} onChange={(event) => setRecordingSource(event.target.value as "display" | "camera")} disabled={blocked || recording}>
              <option value="display">{t("detail.media.screen")}</option>
              <option value="camera">{t("detail.media.camera")}</option>
            </select>
            <select aria-label={t("detail.media.format")} value={recordingFormat} onChange={(event) => setRecordingFormat(event.target.value as "mp4" | "mkv")} disabled={blocked || recording}>
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
            </select>
            <label className="media-control-number">{t("detail.media.limit")}
              <input aria-label={t("detail.media.limit")} type="number" min={0} max={3600} step={10} value={timeLimit} onChange={(event) => setTimeLimit(Math.max(0, Math.min(3600, Number(event.target.value) || 0)))} disabled={blocked || recording} />
              <span>s</span>
            </label>
          </div>
          <div className="media-control-row media-control-checks">
            <label><input type="checkbox" checked={recordingAudio} onChange={(event) => setRecordingAudio(event.target.checked)} disabled={blocked || recording} />{t("detail.media.audio")}</label>
            <label><input type="checkbox" checked={recordingAudioOnly} onChange={(event) => setRecordingAudioOnly(event.target.checked)} disabled={blocked || recording} />{t("detail.media.audioOnly")}</label>
            <select aria-label={t("detail.media.audioSource")} value={audioSource} onChange={(event) => setAudioSource(event.target.value as "output" | "playback" | "mic")} disabled={blocked || recording || (!recordingAudio && !recordingAudioOnly)}>
              <option value="output">{t("detail.media.audioOutput")}</option>
              <option value="playback">{t("detail.media.audioPlayback")}</option>
              <option value="mic">{t("detail.media.audioMic")}</option>
            </select>
          </div>
          <div className="media-control-row">
            <Button size="sm" variant={recording ? "danger" : "primary"} loading={localBusy === "recording-start" || localBusy === "recording-stop"} disabled={blocked} icon={recording ? <CircleStop size={13} /> : <Camera size={13} />} onClick={() => void (recording ? stopRecording() : startRecording())}>
              {recording ? t("detail.media.stopRecording") : t("detail.media.startRecording")}
            </Button>
            {recording && <span className="media-control-live">{t("detail.media.recordingActive")}</span>}
          </div>
        </section>

        <section className="media-control-block">
          <div className="media-control-heading"><Camera size={14} />{t("detail.media.cameraMirror")}</div>
          <div className="media-control-row">
            <select aria-label={t("detail.media.facing")} value={camera.cameraFacing} onChange={(event) => updateCamera({ cameraFacing: event.target.value as ScrcpyCameraOptions["cameraFacing"] })} disabled={blocked || cameraMirroring}>
              <option value="back">{t("detail.media.backCamera")}</option>
              <option value="front">{t("detail.media.frontCamera")}</option>
              <option value="external">{t("detail.media.externalCamera")}</option>
            </select>
            <input aria-label={t("detail.media.cameraId")} value={camera.cameraId} placeholder={t("detail.media.cameraId")} onChange={(event) => updateCamera({ cameraId: event.target.value })} disabled={blocked || cameraMirroring} />
            <input aria-label={t("detail.media.size")} value={camera.cameraSize} onChange={(event) => updateCamera({ cameraSize: event.target.value })} disabled={blocked || cameraMirroring} />
          </div>
          <div className="media-control-row">
            <select aria-label={t("detail.media.aspect")} value={camera.cameraAr} onChange={(event) => updateCamera({ cameraAr: event.target.value })} disabled={blocked || cameraMirroring}>
              <option value="16:9">16:9</option><option value="4:3">4:3</option><option value="sensor">{t("detail.media.sensorAspect")}</option>
            </select>
            <label className="media-control-number">{t("detail.media.fps")}<input aria-label={t("detail.media.fps")} type="number" min={1} max={240} value={camera.cameraFps} onChange={(event) => updateCamera({ cameraFps: Number(event.target.value) })} disabled={blocked || cameraMirroring} /><span>fps</span></label>
            <label className="media-control-number">{t("detail.media.zoom")}<input aria-label={t("detail.media.zoom")} type="number" min={1} max={20} step={0.1} value={camera.cameraZoom} onChange={(event) => updateCamera({ cameraZoom: Number(event.target.value) })} disabled={blocked || cameraMirroring} /><span>x</span></label>
            <label><input type="checkbox" checked={camera.cameraTorch} onChange={(event) => updateCamera({ cameraTorch: event.target.checked })} disabled={blocked || cameraMirroring} />{t("detail.media.torch")}</label>
          </div>
          <Button size="sm" variant={cameraMirroring ? "danger" : "secondary"} loading={localBusy === "camera-start" || localBusy === "camera-stop"} disabled={blocked} onClick={() => void toggleCamera()}>
            {cameraMirroring ? t("detail.media.stopCamera") : t("detail.media.startCamera")}
          </Button>
        </section>

        <section className="media-control-block">
          <div className="media-control-heading"><RotateCw size={14} />{t("detail.media.rotation")}</div>
          <div className="media-control-row media-control-segmented">
            {(["portrait", "landscape", "auto", "lock"] as RotationMode[]).map((mode) => (
              <Button key={mode} size="sm" variant="ghost" disabled={blocked} loading={localBusy === `rotation-${mode}`} onClick={() => runRotation(mode)}>
                {t(`detail.media.rotation.${mode}`)}
              </Button>
            ))}
          </div>
        </section>

        <section className="media-control-block">
          <div className="media-control-heading"><Power size={14} />{t("detail.media.power")}</div>
          <div className="media-control-row media-control-segmented">
            <Button size="sm" variant="ghost" icon={<VolumeX size={13} />} disabled={blocked} loading={localBusy === "mute"} onClick={() => runDeviceAction("mute")}>{t("detail.media.mute")}</Button>
            <Button size="sm" variant="ghost" icon={<LockKeyhole size={13} />} disabled={blocked} loading={localBusy === "screenOff"} onClick={() => runDeviceAction("screenOff")}>{t("detail.media.screenOff")}</Button>
            <Button size="sm" variant="ghost" disabled={blocked} loading={localBusy === "reboot"} onClick={() => runDeviceAction("reboot")}>{t("detail.media.reboot")}</Button>
            <Button size="sm" variant="ghost" disabled={blocked} loading={localBusy === "shutdown"} onClick={() => runDeviceAction("shutdown")}>{t("detail.media.shutdown")}</Button>
          </div>
        </section>
      </div>
    </Card>
  );
}

export type { DeviceMediaAction, RotationMode };
