export type ScrcpyWindowMode = "normal" | "borderless" | "fullscreen";

export interface ScrcpyVisualOptions {
  maxSize: number;
  bitRate: number;
  maxFps: number | null;
  windowMode: ScrcpyWindowMode;
  alwaysOnTop: boolean;
  control: boolean;
  audio: boolean;
}

export const DEFAULT_SCRCPY_OPTIONS: ScrcpyVisualOptions = {
  maxSize: 1080,
  bitRate: 8,
  maxFps: null,
  windowMode: "normal",
  alwaysOnTop: false,
  control: true,
  audio: false,
};

const VALUE_FLAGS = ["--max-size", "--video-bit-rate", "--max-fps", "--audio-source"] as const;
const BOOLEAN_FLAGS = [
  "--window-borderless",
  "--fullscreen",
  "--always-on-top",
  "--no-control",
  "--no-audio",
] as const;

function tokens(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

function readValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) return args[index + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((token) => token === flag || token.startsWith(`${flag}=`));
}

function validInteger(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function parseBitRate(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kmg]?)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "g" ? 1000 : unit === "k" ? 0.001 : 1;
  const bitRate = amount * multiplier;
  return Number.isFinite(bitRate) && bitRate >= 1 && bitRate <= 1000 ? Math.round(bitRate * 100) / 100 : null;
}

export function parseScrcpyOptions(raw: string): ScrcpyVisualOptions {
  const args = tokens(raw);
  const maxSize = validInteger(readValue(args, "--max-size"), 240, 4096);
  const bitRate = parseBitRate(readValue(args, "--video-bit-rate"));
  const maxFps = validInteger(readValue(args, "--max-fps"), 1, 240);
  const windowMode: ScrcpyWindowMode = hasFlag(args, "--fullscreen")
    ? "fullscreen"
    : hasFlag(args, "--window-borderless")
      ? "borderless"
      : "normal";

  return {
    maxSize: maxSize ?? DEFAULT_SCRCPY_OPTIONS.maxSize,
    bitRate: bitRate ?? DEFAULT_SCRCPY_OPTIONS.bitRate,
    maxFps,
    windowMode,
    alwaysOnTop: hasFlag(args, "--always-on-top"),
    control: !hasFlag(args, "--no-control"),
    // The project historically adds --no-audio for the legacy start command.
    audio: Boolean(readValue(args, "--audio-source")) && !hasFlag(args, "--no-audio"),
  };
}

function isManagedToken(token: string): boolean {
  return VALUE_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))
    || BOOLEAN_FLAGS.includes(token as (typeof BOOLEAN_FLAGS)[number]);
}

function removeManagedTokens(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (VALUE_FLAGS.some((flag) => token === flag)) {
      index += 1;
      continue;
    }
    if (isManagedToken(token)) continue;
    result.push(token);
  }
  return result;
}

export function mergeScrcpyOptions(raw: string, options: ScrcpyVisualOptions): string {
  const currentArgs = tokens(raw);
  const currentAudioSource = readValue(currentArgs, "--audio-source");
  const audioSource = currentAudioSource && !currentAudioSource.startsWith("-") ? currentAudioSource : "output";
  const managed = [
    `--max-size ${options.maxSize}`,
    `--video-bit-rate ${options.bitRate}M`,
    ...(options.maxFps === null ? [] : [`--max-fps ${options.maxFps}`]),
    ...(options.windowMode === "borderless" ? ["--window-borderless"] : []),
    ...(options.windowMode === "fullscreen" ? ["--fullscreen"] : []),
    ...(options.alwaysOnTop ? ["--always-on-top"] : []),
    ...(options.control ? [] : ["--no-control"]),
    ...(options.audio ? [`--audio-source=${audioSource}`] : ["--no-audio"]),
  ];
  return [...managed, ...removeManagedTokens(currentArgs)].join(" ");
}
