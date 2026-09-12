import { describe, expect, it } from "vitest";
import { getStreamPresentation, mapContainedPoint } from "../src/lib/streamState";
import { parseScrcpyStreamOptions } from "../src/lib/streamOptions";
import { normalizeClipboardText } from "../src/lib/clipboard";
import { buildScrcpyArgs, resolveStoredScrcpyArgs } from "../src/lib/scrcpyPreferences";

describe("getStreamPresentation", () => {
  it("requires an online device before starting a stream", () => {
    expect(
      getStreamPresentation({ online: false, adbStatus: "offline", streamStatus: "stopped" }),
    ).toEqual({ kind: "offline", label: "需在线" });
  });

  it("keeps a failed stream actionable", () => {
    expect(
      getStreamPresentation({ online: true, adbStatus: "device", streamStatus: "error" }),
    ).toEqual({ kind: "error", label: "投屏失败" });
  });

  it("exposes the running state only when both device and stream are ready", () => {
    expect(
      getStreamPresentation({ online: true, adbStatus: "device", streamStatus: "running" }),
    ).toEqual({ kind: "running", label: "投屏中" });
  });

  it("maps pointer coordinates inside object-fit contain letterboxing", () => {
    expect(mapContainedPoint({ left: 0, top: 0, width: 1000, height: 600 }, 1080, 1920, 340, 300)).toEqual({ x: 28, y: 960 });
  });

  it("preserves every supported value option when starting embedded scrcpy", () => {
    const parsed = parseScrcpyStreamOptions(
      "--max-size 720 --video-bit-rate 4M --max-fps 30 --video-buffer 50 --v4l2-buffer 300 --angle 15 --video-source camera --camera-size 1920x1080 --camera-fps 60 --display-id 2 --display-ime-policy local --flex-display --no-vd-destroy-content --audio-output-buffer 10 --audio-encoder c2.android.opus.encoder --camera-facing front --camera-zoom 2.5 --screen-off-timeout 30 --mouse-bind bhsn:++++ --background-color #112233 --window-width 600 --window-height 900 --window-title demo",
    );
    expect(parsed.maxSize).toBe(720);
    expect(parsed.bitRate).toBe(4);
    expect(parsed.extra).toContain("--max-fps=30");
    expect(parsed.extra).toContain("--video-buffer=50");
    expect(parsed.extra).toContain("--v4l2-buffer=300");
    expect(parsed.extra).toContain("--angle=15");
    expect(parsed.extra).toContain("--video-source=camera");
    expect(parsed.extra).toContain("--camera-size=1920x1080");
    expect(parsed.extra).toContain("--camera-fps=60");
    expect(parsed.extra).toContain("--display-id=2");
    expect(parsed.extra).toContain("--display-ime-policy=local");
    expect(parsed.extra).toContain("--flex-display");
    expect(parsed.extra).toContain("--no-vd-destroy-content");
    expect(parsed.extra).toContain("--audio-encoder=c2.android.opus.encoder");
    expect(parsed.extra).toContain("--camera-facing=front");
    expect(parsed.extra).toContain("--camera-zoom=2.5");
    expect(parsed.extra).toContain("--screen-off-timeout=30");
    expect(parsed.extra).toContain("--mouse-bind=bhsn:++++");
    expect(parsed.extra).toContain("--background-color=#112233");
    expect(parsed.extra).not.toContain("--max-size");
    expect(parsed.extra).not.toContain("--window-title");
  });

  it("removes only the clipboard transport newline", () => {
    expect(normalizeClipboardText("  hello  \n")).toBe("  hello  ");
    expect(normalizeClipboardText("hello\n\n")).toBe("hello\n");
  });

  it("uses persisted group Scrcpy settings when no session draft exists", () => {
    const store = new Map([
      ["rdc.scrcpy.global", JSON.stringify({ maxSize: 720, bitRate: 4 })],
      ["rdc.scrcpy.group.lab", JSON.stringify({ maxSize: 900, bitRate: 6 })],
    ]);
    const read = (key: string) => store.get(key) || null;
    const args = resolveStoredScrcpyArgs("device-1", "lab", buildScrcpyArgs({}), read);
    expect(args).toContain("--max-size 900");
    expect(args).toContain("--video-bit-rate 6M");
  });
});
