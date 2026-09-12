export interface ScrcpyStreamOptions {
  maxSize: number;
  bitRate: number;
  extra: string;
}

const PROTECTED_FLAGS = new Set([
  "--max-size",
  "-m",
  "--video-bit-rate",
  "-b",
  "--window-title",
  "--record",
  "-r",
  "--record-format",
  "--raw-video-stream",
]);

const VALUE_FLAGS = new Set([
  "--max-fps",
  "--video-codec",
  "--video-encoder",
  "--video-source",
  "--camera-size",
  "--camera-fps",
  "--video-buffer",
  "--v4l2-buffer",
  "--angle",
  "--crop",
  "--display",
  "--display-id",
  "--new-display",
  "--display-ime-policy",
  "--display-orientation",
  "--flip",
  "--audio-source",
  "--audio-codec",
  "--audio-encoder",
  "--audio-bit-rate",
  "--audio-buffer",
  "--audio-output-buffer",
  "--camera-id",
  "--camera-facing",
  "--camera-ar",
  "--camera-zoom",
  "--screen-off-timeout",
  "--mouse-bind",
  "--background-color",
  "--keyboard",
  "--mouse",
  "--gamepad",
  "--window-width",
  "--window-height",
  "--window-x",
  "--window-y",
]);

export function parseScrcpyStreamOptions(args: string): ScrcpyStreamOptions {
  const size = args.match(/--max-size[=\s]+(\d+)/)?.[1];
  const rate = args.match(/--video-bit-rate[=\s]+(\d+)/)?.[1];
  const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const extraTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (PROTECTED_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if ([...PROTECTED_FLAGS].some((flag) => token.startsWith(`${flag}=`))) continue;
    if (VALUE_FLAGS.has(token) && tokens[index + 1]) {
      extraTokens.push(`${token}=${tokens[index + 1]}`);
      index += 1;
      continue;
    }
    extraTokens.push(token);
  }

  return {
    maxSize: Number(size) || 1080,
    bitRate: Number(rate) || 8,
    extra: extraTokens.join(" "),
  };
}
