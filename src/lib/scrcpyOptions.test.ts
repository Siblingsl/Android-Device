import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRCPY_OPTIONS,
  mergeScrcpyOptions,
  parseScrcpyOptions,
  type ScrcpyVisualOptions,
} from "./scrcpyOptions";

describe("scrcpy visual options", () => {
  it("parses known values and keeps safe defaults for omitted flags", () => {
    expect(parseScrcpyOptions("--max-size=1440 --video-bit-rate 16M --max-fps 60 --fullscreen --always-on-top --no-control --audio-source=mic --stay-awake --video-codec=h265")).toEqual({
      maxSize: 1440,
      bitRate: 16,
      maxFps: 60,
      windowMode: "fullscreen",
      alwaysOnTop: true,
      control: false,
      audio: true,
    });
  });

  it("replaces managed flags while preserving custom scrcpy arguments", () => {
    const next: ScrcpyVisualOptions = {
      maxSize: 720,
      bitRate: 4,
      maxFps: 30,
      windowMode: "borderless",
      alwaysOnTop: false,
      control: true,
      audio: false,
    };

    expect(
      mergeScrcpyOptions(
        '--max-size 1440 --video-bit-rate 16M --max-fps=120 --window-borderless --always-on-top --no-control --video-codec=h264 --display-id 1',
        next,
      ),
    ).toBe("--max-size 720 --video-bit-rate 4M --max-fps 30 --window-borderless --no-audio --video-codec=h264 --display-id 1");
  });

  it("removes stale managed flags when options return to defaults", () => {
    expect(
      mergeScrcpyOptions(
        "--max-size 720 --video-bit-rate 2M --max-fps 60 --fullscreen --always-on-top --no-control --no-audio",
        DEFAULT_SCRCPY_OPTIONS,
      ),
    ).toBe("--max-size 1080 --video-bit-rate 8M --no-audio");
  });

  it("preserves a custom audio source while changing another visual option", () => {
    expect(
      mergeScrcpyOptions(
        "--max-size 1080 --video-bit-rate 8M --audio-source=mic",
        { ...DEFAULT_SCRCPY_OPTIONS, audio: true, maxSize: 1440 },
      ),
    ).toContain("--audio-source=mic");
  });
});
