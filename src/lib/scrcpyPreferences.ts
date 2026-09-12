export interface ScrcpyPreferences {
  maxSize: number;
  bitRate: number;
  maxFps: number;
  videoBuffer: number;
  v4l2Buffer: number;
  angle: number;
  videoCodec: "" | "h264" | "h265" | "av1";
  videoEncoder: string;
  videoSource: "" | "display" | "camera";
  cameraSize: string;
  cameraFps: number;
  crop: string;
  displayId: string;
  newDisplay: string;
  displayImePolicy: "" | "local";
  flexDisplay: boolean;
  noVdDestroyContent: boolean;
  orientation: "" | "0" | "90" | "180" | "270" | "flip0" | "flip90" | "flip180" | "flip270";
  flip: "" | "0" | "1";
  noVideo: boolean;
  noAudio: boolean;
  audioSource: "" | "output" | "playback" | "mic" | "mic-unprocessed" | "mic-camcorder" | "mic-voice-recognition" | "mic-voice-communication" | "voice-call" | "voice-call-uplink" | "voice-call-downlink" | "voice-performance";
  audioCodec: "" | "opus" | "aac" | "flac" | "raw";
  audioEncoder: string;
  audioBitRate: number;
  audioBuffer: number;
  audioOutputBuffer: number;
  audioDuplicate: boolean;
  noPlayback: boolean;
  noVideoPlayback: boolean;
  noAudioPlayback: boolean;
  cameraId: string;
  cameraFacing: "" | "front" | "back" | "external";
  cameraAspectRatio: string;
  cameraHighSpeed: boolean;
  cameraTorch: boolean;
  cameraZoom: number | null;
  screenOffTimeout: number;
  stayAwake: boolean;
  keepActive: boolean;
  turnScreenOff: boolean;
  powerOffOnClose: boolean;
  noPowerOn: boolean;
  disableScreensaver: boolean;
  showTouches: boolean;
  noControl: boolean;
  keyboard: "" | "disabled" | "sdk" | "uhid" | "aoa";
  mouse: "" | "disabled" | "sdk" | "uhid" | "aoa";
  gamepad: "" | "disabled" | "sdk" | "uhid" | "aoa";
  mouseBind: string;
  keyboardInject: "" | "prefer-text" | "raw-key-events";
  windowWidth: number;
  windowHeight: number;
  windowX: number | null;
  windowY: number | null;
  alwaysOnTop: boolean;
  borderless: boolean;
  fullscreen: boolean;
  windowTitle: string;
  backgroundColor: string;
}

export const defaultScrcpyPreferences: ScrcpyPreferences = {
  maxSize: 1080,
  bitRate: 8,
  maxFps: 0,
  videoBuffer: 0,
  v4l2Buffer: 0,
  angle: 0,
  videoCodec: "",
  videoEncoder: "",
  videoSource: "",
  cameraSize: "",
  cameraFps: 0,
  crop: "",
  displayId: "",
  newDisplay: "",
  displayImePolicy: "",
  flexDisplay: false,
  noVdDestroyContent: false,
  orientation: "",
  flip: "",
  noVideo: false,
  noAudio: true,
  audioSource: "",
  audioCodec: "",
  audioEncoder: "",
  audioBitRate: 8,
  audioBuffer: 50,
  audioOutputBuffer: 0,
  audioDuplicate: false,
  noPlayback: false,
  noVideoPlayback: false,
  noAudioPlayback: false,
  cameraId: "",
  cameraFacing: "",
  cameraAspectRatio: "",
  cameraHighSpeed: false,
  cameraTorch: false,
  cameraZoom: null,
  screenOffTimeout: 0,
  stayAwake: true,
  keepActive: false,
  turnScreenOff: false,
  powerOffOnClose: false,
  noPowerOn: false,
  disableScreensaver: false,
  showTouches: false,
  noControl: false,
  keyboard: "",
  mouse: "",
  gamepad: "",
  mouseBind: "",
  keyboardInject: "",
  windowWidth: 0,
  windowHeight: 0,
  windowX: null,
  windowY: null,
  alwaysOnTop: false,
  borderless: false,
  fullscreen: false,
  windowTitle: "",
  backgroundColor: "",
};

function integer(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function safeToken(value: string, pattern: RegExp, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!pattern.test(trimmed)) throw new Error(`${label}包含非法字符`);
  return trimmed;
}

export type ScrcpyPreferenceScope = "device" | "global" | "group";

export function scrcpyScopeStorageKey(scope: ScrcpyPreferenceScope, serial: string, group = "") {
  return scope === "global"
    ? "rdc.scrcpy.global"
    : scope === "group"
      ? `rdc.scrcpy.group.${group.trim()}`
      : `rdc.scrcpy.device.${serial}`;
}

export function resolveStoredScrcpyArgs(
  serial: string,
  group: string,
  fallback: string,
  read: (key: string) => string | null = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
) {
  const scopes: Array<[ScrcpyPreferenceScope, string]> = [["device", serial]];
  if (group.trim()) scopes.push(["group", group]);
  scopes.push(["global", ""]);

  for (const [scope, scopeGroup] of scopes) {
    try {
      const raw = read(scrcpyScopeStorageKey(scope, serial, scopeGroup));
      if (!raw) continue;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      return buildScrcpyArgs(parsed as Partial<ScrcpyPreferences>);
    } catch {
      // A malformed scope must not prevent lower-priority defaults from loading.
    }
  }
  return fallback;
}

export function normalizeScrcpyPreferences(input: Partial<ScrcpyPreferences>): ScrcpyPreferences {
  const next = { ...defaultScrcpyPreferences, ...input };
  return {
    ...next,
    maxSize: integer(next.maxSize, 1080, 240, 8192),
    bitRate: integer(next.bitRate, 8, 1, 200),
    maxFps: integer(next.maxFps, 0, 0, 240),
    videoBuffer: integer(next.videoBuffer, 0, 0, 10_000),
    v4l2Buffer: integer(next.v4l2Buffer, 0, 0, 10_000),
    angle: Number.isFinite(Number(next.angle)) ? Math.max(-360, Math.min(360, Number(next.angle))) : 0,
    videoSource: ["", "display", "camera"].includes(next.videoSource) ? next.videoSource : "",
    cameraFps: integer(next.cameraFps, 0, 0, 240),
    audioBitRate: integer(next.audioBitRate, 8, 1, 200),
    audioBuffer: integer(next.audioBuffer, 50, 0, 5000),
    audioOutputBuffer: integer(next.audioOutputBuffer, 0, 0, 10_000),
    screenOffTimeout: integer(next.screenOffTimeout, 0, 0, 86_400),
    cameraFacing: ["", "front", "back", "external"].includes(next.cameraFacing)
      ? next.cameraFacing
      : "",
    cameraZoom: next.cameraZoom === null || next.cameraZoom === undefined
      ? null
      : Number.isFinite(Number(next.cameraZoom))
        ? Math.max(0, Math.min(100, Number(next.cameraZoom)))
        : null,
    windowWidth: integer(next.windowWidth, 0, 0, 10000),
    windowHeight: integer(next.windowHeight, 0, 0, 10000),
    windowX: next.windowX === null ? null : integer(next.windowX, 0, -10000, 10000),
    windowY: next.windowY === null ? null : integer(next.windowY, 0, -10000, 10000),
    mouseBind: typeof next.mouseBind === "string" && /^[+\-bhsn]{4}:[+\-bhsn]{4}$/.test(next.mouseBind.trim()) ? next.mouseBind.trim() : "",
    keyboardInject: ["", "prefer-text", "raw-key-events"].includes(next.keyboardInject) ? next.keyboardInject : "",
    backgroundColor: typeof next.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(next.backgroundColor.trim()) ? next.backgroundColor.trim() : "",
  };
}

export function buildScrcpyArgs(input: Partial<ScrcpyPreferences>): string {
  if (typeof input.mouseBind === "string" && input.mouseBind.trim() && !/^[+\-bhsn]{4}:[+\-bhsn]{4}$/.test(input.mouseBind.trim())) {
    throw new Error("鼠标绑定格式无效");
  }
  if (typeof input.backgroundColor === "string" && input.backgroundColor.trim() && !/^#[0-9a-f]{6}$/i.test(input.backgroundColor.trim())) {
    throw new Error("窗口背景色格式无效");
  }
  const prefs = normalizeScrcpyPreferences(input);
  const args: string[] = ["--max-size", String(prefs.maxSize), "--video-bit-rate", `${prefs.bitRate}M`];
  if (prefs.maxFps > 0) args.push("--max-fps", String(prefs.maxFps));
  if (prefs.videoBuffer > 0) args.push("--video-buffer", String(prefs.videoBuffer));
  if (prefs.v4l2Buffer > 0) args.push("--v4l2-buffer", String(prefs.v4l2Buffer));
  if (prefs.angle !== 0) args.push("--angle", String(prefs.angle));
  if (prefs.videoCodec) args.push("--video-codec", prefs.videoCodec);
  if (prefs.videoEncoder) args.push("--video-encoder", safeToken(prefs.videoEncoder, /^[\w.:-]+$/, "视频编码器"));
  if (prefs.videoSource) args.push("--video-source", prefs.videoSource);
  if (prefs.crop) args.push("--crop", safeToken(prefs.crop, /^\d+:\d+:\d+:\d+$/, "裁剪参数"));
  if (prefs.displayId) args.push("--display-id", safeToken(prefs.displayId, /^\d+$/, "Display ID"));
  if (prefs.newDisplay) args.push("--new-display", safeToken(prefs.newDisplay, /^\d+x\d+(?:\/\d+)?$/i, "虚拟 Display"));
  if (prefs.displayImePolicy) args.push("--display-ime-policy", prefs.displayImePolicy);
  if (prefs.flexDisplay) args.push("--flex-display");
  if (prefs.noVdDestroyContent) args.push("--no-vd-destroy-content");
  if (prefs.orientation) args.push("--display-orientation", prefs.orientation);
  if (prefs.flip) args.push("--flip", prefs.flip);
  if (prefs.noVideo) args.push("--no-video");
  if (prefs.noAudio) args.push("--no-audio");
  if (prefs.audioSource) args.push("--audio-source", prefs.audioSource);
  if (prefs.audioCodec) args.push("--audio-codec", prefs.audioCodec);
  if (prefs.audioEncoder) args.push("--audio-encoder", safeToken(prefs.audioEncoder, /^[\w.:-]+$/, "音频编码器"));
  if (prefs.audioBitRate > 0) args.push("--audio-bit-rate", `${prefs.audioBitRate}M`);
  if (prefs.audioBuffer > 0) args.push("--audio-buffer", String(prefs.audioBuffer));
  if (prefs.audioOutputBuffer > 0) args.push("--audio-output-buffer", String(prefs.audioOutputBuffer));
  if (prefs.audioDuplicate) args.push("--audio-dup");
  if (prefs.noPlayback) args.push("--no-playback");
  if (prefs.noVideoPlayback) args.push("--no-video-playback");
  if (prefs.noAudioPlayback) args.push("--no-audio-playback");
  // scrcpy treats camera-id and camera-facing as mutually exclusive selectors.
  // Prefer the explicit ID so imported/legacy preferences cannot produce an
  // invalid command when both fields happen to be populated.
  if (prefs.cameraId) {
    args.push("--camera-id", safeToken(prefs.cameraId, /^\d+$/, "摄像头 ID"));
  } else if (prefs.cameraFacing) {
    args.push("--camera-facing", prefs.cameraFacing);
  }
  if (prefs.cameraSize) args.push("--camera-size", safeToken(prefs.cameraSize, /^\d+x\d+$/i, "摄像头分辨率"));
  if (prefs.cameraFps > 0) args.push("--camera-fps", String(prefs.cameraFps));
  if (prefs.cameraAspectRatio) args.push("--camera-ar", safeToken(prefs.cameraAspectRatio, /^(sensor|\d+(?::\d+)?(?:\.\d+)?)$/i, "摄像头比例"));
  if (prefs.cameraHighSpeed) args.push("--camera-high-speed");
  if (prefs.cameraTorch) args.push("--camera-torch");
  if (prefs.cameraZoom !== null) args.push("--camera-zoom", String(prefs.cameraZoom));
  if (prefs.screenOffTimeout > 0) args.push("--screen-off-timeout", String(prefs.screenOffTimeout));
  if (prefs.stayAwake) args.push("--stay-awake");
  if (prefs.keepActive) args.push("--keep-active");
  if (prefs.turnScreenOff) args.push("--turn-screen-off");
  if (prefs.powerOffOnClose) args.push("--power-off-on-close");
  if (prefs.noPowerOn) args.push("--no-power-on");
  if (prefs.disableScreensaver) args.push("--disable-screensaver");
  if (prefs.showTouches) args.push("--show-touches");
  if (prefs.noControl) args.push("--no-control");
  if (prefs.keyboard) args.push("--keyboard", prefs.keyboard);
  if (prefs.mouse) args.push("--mouse", prefs.mouse);
  if (prefs.gamepad) args.push("--gamepad", prefs.gamepad);
  if (prefs.mouseBind) args.push("--mouse-bind", safeToken(prefs.mouseBind, /^[+\-bhsn]{4}:[+\-bhsn]{4}$/, "鼠标绑定"));
  if (prefs.keyboardInject === "prefer-text") args.push("--prefer-text");
  if (prefs.keyboardInject === "raw-key-events") args.push("--raw-key-events");
  if (prefs.windowWidth > 0) args.push("--window-width", String(prefs.windowWidth));
  if (prefs.windowHeight > 0) args.push("--window-height", String(prefs.windowHeight));
  if (prefs.windowX !== null) args.push("--window-x", String(prefs.windowX));
  if (prefs.windowY !== null) args.push("--window-y", String(prefs.windowY));
  if (prefs.alwaysOnTop) args.push("--always-on-top");
  if (prefs.borderless) args.push("--window-borderless");
  if (prefs.fullscreen) args.push("--fullscreen");
  if (prefs.windowTitle) args.push("--window-title", safeToken(prefs.windowTitle, /^[^\s"';&|`]+$/u, "窗口标题"));
  if (prefs.backgroundColor) args.push("--background-color", safeToken(prefs.backgroundColor, /^#[0-9a-f]{6}$/i, "窗口背景色"));
  return args.join(" ");
}

export function parseScrcpyArgs(raw: string): ScrcpyPreferences {
  const tokens: string[] = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const valueAfter = (name: string) => {
    const index = tokens.findIndex((token) => token === name || token.startsWith(`${name}=`));
    if (index < 0) return "";
    return tokens[index].includes("=") ? tokens[index].slice(tokens[index].indexOf("=") + 1) : tokens[index + 1] || "";
  };
  const bool = (name: string) => tokens.includes(name);
  const rate = valueAfter("--video-bit-rate").match(/\d+/)?.[0];
  const audioRate = valueAfter("--audio-bit-rate").match(/\d+/)?.[0];
  const int = (name: string) => Number(valueAfter(name).match(/-?\d+/)?.[0] || 0);
  return normalizeScrcpyPreferences({
    maxSize: int("--max-size") || 1080,
    bitRate: Number(rate) || 8,
    maxFps: int("--max-fps"),
    videoBuffer: int("--video-buffer"),
    v4l2Buffer: int("--v4l2-buffer"),
    angle: Number(valueAfter("--angle")) || 0,
    videoCodec: valueAfter("--video-codec") as ScrcpyPreferences["videoCodec"],
    videoEncoder: valueAfter("--video-encoder"),
    videoSource: valueAfter("--video-source") as ScrcpyPreferences["videoSource"],
    cameraSize: valueAfter("--camera-size"),
    cameraFps: int("--camera-fps"),
    crop: valueAfter("--crop"),
    displayId: valueAfter("--display-id") || valueAfter("--display"),
    newDisplay: valueAfter("--new-display"),
    displayImePolicy: valueAfter("--display-ime-policy") as ScrcpyPreferences["displayImePolicy"],
    flexDisplay: bool("--flex-display"),
    noVdDestroyContent: bool("--no-vd-destroy-content"),
    orientation: valueAfter("--display-orientation") as ScrcpyPreferences["orientation"],
    flip: valueAfter("--flip") as ScrcpyPreferences["flip"],
    noVideo: bool("--no-video"),
    noAudio: bool("--no-audio"),
    audioSource: valueAfter("--audio-source") as ScrcpyPreferences["audioSource"],
    audioCodec: valueAfter("--audio-codec") as ScrcpyPreferences["audioCodec"],
    audioEncoder: valueAfter("--audio-encoder"),
    audioBitRate: Number(audioRate) || 8,
    audioBuffer: int("--audio-buffer") || 50,
    audioOutputBuffer: int("--audio-output-buffer"),
    audioDuplicate: bool("--audio-dup"),
    noPlayback: bool("--no-playback"),
    noVideoPlayback: bool("--no-video-playback"),
    noAudioPlayback: bool("--no-audio-playback"),
    cameraId: valueAfter("--camera-id"),
    cameraFacing: valueAfter("--camera-facing") as ScrcpyPreferences["cameraFacing"],
    cameraAspectRatio: valueAfter("--camera-ar"),
    cameraHighSpeed: bool("--camera-high-speed"),
    cameraTorch: bool("--camera-torch"),
    cameraZoom: tokens.some((token) => token === "--camera-zoom" || token.startsWith("--camera-zoom="))
      ? Number(valueAfter("--camera-zoom"))
      : null,
    screenOffTimeout: int("--screen-off-timeout"),
    stayAwake: bool("--stay-awake"),
    keepActive: bool("--keep-active"),
    turnScreenOff: bool("--turn-screen-off"),
    powerOffOnClose: bool("--power-off-on-close"),
    noPowerOn: bool("--no-power-on"),
    disableScreensaver: bool("--disable-screensaver"),
    showTouches: bool("--show-touches"),
    noControl: bool("--no-control"),
    keyboard: valueAfter("--keyboard") as ScrcpyPreferences["keyboard"],
    mouse: valueAfter("--mouse") as ScrcpyPreferences["mouse"],
    gamepad: valueAfter("--gamepad") as ScrcpyPreferences["gamepad"],
    mouseBind: valueAfter("--mouse-bind"),
    keyboardInject: bool("--prefer-text") ? "prefer-text" : bool("--raw-key-events") ? "raw-key-events" : "",
    windowWidth: int("--window-width"),
    windowHeight: int("--window-height"),
    windowX: tokens.some((token) => token === "--window-x" || token.startsWith("--window-x=")) ? int("--window-x") : null,
    windowY: tokens.some((token) => token === "--window-y" || token.startsWith("--window-y=")) ? int("--window-y") : null,
    alwaysOnTop: bool("--always-on-top"),
    borderless: bool("--window-borderless"),
    fullscreen: bool("--fullscreen"),
    windowTitle: valueAfter("--window-title").replace(/^"|"$/g, ""),
    backgroundColor: valueAfter("--background-color"),
  });
}
