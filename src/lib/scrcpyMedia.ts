import type {
  ScrcpyCameraFacing,
  ScrcpyCameraOptions,
  ScrcpyRecordingFormat,
  ScrcpyRecordingOptions,
} from "../types";

export const MAX_RECORDING_TIME_SECS = 60 * 60;

export const DEFAULT_CAMERA_OPTIONS: ScrcpyCameraOptions = {
  cameraId: "",
  cameraSize: "1920x1080",
  cameraAr: "16:9",
  cameraFps: 30,
  cameraFacing: "back",
  cameraTorch: false,
  cameraZoom: 1,
};

export const DEFAULT_RECORDING_OPTIONS: Omit<ScrcpyRecordingOptions, "outputPath"> = {
  ...DEFAULT_CAMERA_OPTIONS,
  format: "mp4",
  audio: false,
  audioOnly: false,
  audioSource: "output",
  videoSource: "display",
  timeLimitSecs: 0,
};

function finiteNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Math.round(finiteNumber(value, fallback));
  return Math.min(max, Math.max(min, number));
}

function positiveDecimal(value: unknown, fallback: number, min: number, max: number): number {
  const number = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, Number(number.toFixed(2))));
}

export function normalizeCameraOptions(
  input: Partial<ScrcpyCameraOptions> = {},
): ScrcpyCameraOptions {
  const facing: ScrcpyCameraFacing = input.cameraFacing === "front" || input.cameraFacing === "external"
    ? input.cameraFacing
    : "back";
  return {
    cameraId: String(input.cameraId ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 32),
    cameraSize: /^\d{2,5}x\d{2,5}$/.test(String(input.cameraSize ?? ""))
      ? String(input.cameraSize)
      : DEFAULT_CAMERA_OPTIONS.cameraSize,
    cameraAr: /^(?:sensor|\d{1,3}(?::\d{1,3})?|\d{1,3}\.\d{1,3})$/.test(String(input.cameraAr ?? ""))
      ? String(input.cameraAr)
      : DEFAULT_CAMERA_OPTIONS.cameraAr,
    cameraFps: positiveInteger(input.cameraFps, DEFAULT_CAMERA_OPTIONS.cameraFps, 1, 240),
    cameraFacing: facing,
    cameraTorch: Boolean(input.cameraTorch),
    cameraZoom: positiveDecimal(input.cameraZoom, DEFAULT_CAMERA_OPTIONS.cameraZoom, 1, 20),
  };
}

export function normalizeRecordingOptions(
  input: Partial<ScrcpyRecordingOptions> & Pick<ScrcpyRecordingOptions, "outputPath">,
): ScrcpyRecordingOptions {
  const camera = normalizeCameraOptions(input);
  const format: ScrcpyRecordingFormat = input.format === "mkv" ? "mkv" : "mp4";
  const audioSource = input.audioSource === "mic" || input.audioSource === "playback"
    ? input.audioSource
    : "output";
  return {
    ...camera,
    outputPath: String(input.outputPath).trim(),
    format,
    audio: Boolean(input.audio),
    audioOnly: Boolean(input.audioOnly),
    audioSource,
    videoSource: input.videoSource === "camera" ? "camera" : "display",
    timeLimitSecs: positiveInteger(input.timeLimitSecs, 0, 0, MAX_RECORDING_TIME_SECS),
  };
}

export function ensureRecordingExtension(path: string, format: ScrcpyRecordingFormat): string {
  const clean = path.trim();
  if (!clean) return clean;
  return /\.(mp4|mkv)$/i.test(clean)
    ? clean.replace(/\.(mp4|mkv)$/i, `.${format}`)
    : `${clean}.${format}`;
}

export function cameraOptionArgs(options: ScrcpyCameraOptions): string[] {
  const args = [
    "--camera-size",
    options.cameraSize,
    "--camera-ar",
    options.cameraAr,
    "--camera-fps",
    String(options.cameraFps),
    "--camera-zoom",
    String(options.cameraZoom),
  ];
  if (options.cameraId) args.push("--camera-id", options.cameraId);
  else args.push("--camera-facing", options.cameraFacing);
  if (options.cameraTorch) args.push("--camera-torch");
  return args;
}
