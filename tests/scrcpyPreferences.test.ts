import { describe, expect, it } from "vitest";
import { buildScrcpyArgs, parseScrcpyArgs, resolveStoredScrcpyArgs } from "../src/lib/scrcpyPreferences";

describe("scrcpy preferences", () => {
  it("maps advanced options deterministically", () => {
    const args = buildScrcpyArgs({ maxSize: 720, bitRate: 4, maxFps: 30, videoBuffer: 50, v4l2Buffer: 300, angle: 15, crop: "1080:1920:0:0", newDisplay: "1080x1920/160", displayImePolicy: "local", flexDisplay: true, noVdDestroyContent: true, cameraFacing: "front", cameraSize: "1920x1080", cameraFps: 60, audioDuplicate: true, audioOutputBuffer: 10, noPlayback: true, noVideoPlayback: true, noAudioPlayback: true, disableScreensaver: true, fullscreen: true, cameraTorch: true, cameraZoom: 2.5, cameraAspectRatio: "4:3", turnScreenOff: true, borderless: true, gamepad: "uhid", flip: "1", windowTitle: "测试设备" });
    expect(args).toContain("--max-size 720");
    expect(args).toContain("--video-bit-rate 4M");
    expect(args).toContain("--max-fps 30");
    expect(args).toContain("--video-buffer 50");
    expect(args).toContain("--v4l2-buffer 300");
    expect(args).toContain("--angle 15");
    expect(args).toContain("--crop 1080:1920:0:0");
    expect(args).toContain("--new-display 1080x1920/160");
    expect(args).toContain("--display-ime-policy local");
    expect(args).toContain("--flex-display");
    expect(args).toContain("--no-vd-destroy-content");
    expect(args).toContain("--camera-size 1920x1080");
    expect(args).toContain("--camera-fps 60");
    expect(args).toContain("--audio-dup");
    expect(args).toContain("--audio-output-buffer 10");
    expect(args).toContain("--no-playback");
    expect(args).toContain("--no-video-playback");
    expect(args).toContain("--no-audio-playback");
    expect(args).toContain("--disable-screensaver");
    expect(args).toContain("--fullscreen");
    expect(args).toContain("--camera-facing front");
    expect(args).toContain("--camera-torch");
    expect(args).toContain("--camera-zoom 2.5");
    expect(args).toContain("--turn-screen-off");
    expect(args).toContain("--window-borderless");
    expect(args).toContain("--gamepad uhid");
    expect(args).toContain("--flip 1");
    expect(args).toContain("--window-title 测试设备");
  });

  it("rejects unsafe custom values and round-trips supported flags", () => {
    expect(() => buildScrcpyArgs({ crop: "1:2:3;rm" })).toThrow();
    const parsed = parseScrcpyArgs("--max-size 720 --video-bit-rate 4M --max-fps 30 --video-buffer 50 --v4l2-buffer 300 --angle 15 --new-display 1080x1920/160 --display-ime-policy local --flex-display --no-vd-destroy-content --camera-size 1920x1080 --camera-fps 60 --audio-output-buffer 10 --no-audio --no-playback --no-video-playback --no-audio-playback --disable-screensaver --fullscreen --always-on-top --camera-facing front --camera-torch --camera-zoom 2.5");
    expect(parsed.maxSize).toBe(720);
    expect(parsed.bitRate).toBe(4);
    expect(parsed.maxFps).toBe(30);
    expect(parsed.videoBuffer).toBe(50);
    expect(parsed.v4l2Buffer).toBe(300);
    expect(parsed.angle).toBe(15);
    expect(parsed.audioOutputBuffer).toBe(10);
    expect(parsed.noAudio).toBe(true);
    expect(parsed.noPlayback).toBe(true);
    expect(parsed.noVideoPlayback).toBe(true);
    expect(parsed.noAudioPlayback).toBe(true);
    expect(parsed.disableScreensaver).toBe(true);
    expect(parsed.fullscreen).toBe(true);
    expect(parsed.alwaysOnTop).toBe(true);
    expect(parsed.cameraFacing).toBe("front");
    expect(parsed.cameraTorch).toBe(true);
    expect(parsed.cameraZoom).toBe(2.5);
    expect(parsed.newDisplay).toBe("1080x1920/160");
    expect(parsed.displayImePolicy).toBe("local");
    expect(parsed.flexDisplay).toBe(true);
    expect(parsed.noVdDestroyContent).toBe(true);
    expect(parsed.cameraSize).toBe("1920x1080");
    expect(parsed.cameraFps).toBe(60);
  });

  it("does not emit conflicting camera selectors", () => {
    const byId = buildScrcpyArgs({ cameraId: "1", cameraFacing: "front" });
    expect(byId).toContain("--camera-id 1");
    expect(byId).not.toContain("--camera-facing");

    const byDirection = buildScrcpyArgs({ cameraFacing: "front" });
    expect(byDirection).toContain("--camera-facing front");
  });

  it("maps the remaining device and input preferences", () => {
    const args = buildScrcpyArgs({
      screenOffTimeout: 30,
      keepActive: true,
      powerOffOnClose: true,
      noPowerOn: true,
      mouseBind: "bhsn:++++",
      keyboardInject: "prefer-text",
      backgroundColor: "#112233",
      displayId: "2",
    });
    expect(args).toContain("--screen-off-timeout 30");
    expect(args).toContain("--keep-active");
    expect(args).toContain("--power-off-on-close");
    expect(args).toContain("--no-power-on");
    expect(args).toContain("--mouse-bind bhsn:++++");
    expect(args).toContain("--prefer-text");
    expect(args).toContain("--background-color #112233");
    expect(args).toContain("--display-id 2");

    const parsed = parseScrcpyArgs(args);
    expect(parsed.screenOffTimeout).toBe(30);
    expect(parsed.keepActive).toBe(true);
    expect(parsed.powerOffOnClose).toBe(true);
    expect(parsed.noPowerOn).toBe(true);
    expect(parsed.mouseBind).toBe("bhsn:++++");
    expect(parsed.keyboardInject).toBe("prefer-text");
    expect(parsed.backgroundColor).toBe("#112233");
    expect(parsed.displayId).toBe("2");
    expect(parseScrcpyArgs("--raw-key-events").keyboardInject).toBe("raw-key-events");
  });

  it("rejects unsafe mouse bindings and colors", () => {
    expect(() => buildScrcpyArgs({ mouseBind: "bhsn:bad!" })).toThrow();
    expect(() => buildScrcpyArgs({ backgroundColor: "red;rm" })).toThrow();
  });

  it("resolves device, group, and global scopes by precedence", () => {
    const values = new Map([
      ["rdc.scrcpy.global", JSON.stringify({ maxSize: 720 })],
      ["rdc.scrcpy.group.work", JSON.stringify({ maxSize: 900 })],
    ]);
    const read = (key: string) => values.get(key) || null;

    expect(resolveStoredScrcpyArgs("serial-1", "work", "fallback", read)).toContain("--max-size 900");
    values.set("rdc.scrcpy.device.serial-1", JSON.stringify({ maxSize: 1080 }));
    expect(resolveStoredScrcpyArgs("serial-1", "work", "fallback", read)).toContain("--max-size 1080");
    values.delete("rdc.scrcpy.group.work");
    values.delete("rdc.scrcpy.device.serial-1");
    expect(resolveStoredScrcpyArgs("serial-1", "work", "fallback", read)).toContain("--max-size 720");
    values.clear();
    expect(resolveStoredScrcpyArgs("serial-1", "work", "fallback", read)).toBe("fallback");
  });
});
