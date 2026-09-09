import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_OPTIONS,
  MAX_RECORDING_TIME_SECS,
  cameraOptionArgs,
  ensureRecordingExtension,
  normalizeCameraOptions,
  normalizeRecordingOptions,
} from "./scrcpyMedia";

describe("scrcpy media options", () => {
  it("normalizes unsafe camera values without changing the safe defaults", () => {
    expect(normalizeCameraOptions({
      cameraId: "0; rm -rf",
      cameraSize: "bad",
      cameraAr: "bad",
      cameraFps: 999,
      cameraFacing: "unknown" as never,
      cameraZoom: 0,
      cameraTorch: true,
    })).toEqual({
      cameraId: "0rm-rf",
      cameraSize: "1920x1080",
      cameraAr: "16:9",
      cameraFps: 240,
      cameraFacing: "back",
      cameraTorch: true,
      cameraZoom: 1,
    });
  });

  it("keeps recording time within the one-hour UI limit", () => {
    const result = normalizeRecordingOptions({
      ...DEFAULT_RECORDING_OPTIONS,
      outputPath: "capture",
      format: "mkv",
      audio: true,
      audioSource: "mic",
      videoSource: "camera",
      timeLimitSecs: MAX_RECORDING_TIME_SECS + 30,
    });
    expect(result.outputPath).toBe("capture");
    expect(result.format).toBe("mkv");
    expect(result.audioSource).toBe("mic");
    expect(result.videoSource).toBe("camera");
    expect(result.timeLimitSecs).toBe(MAX_RECORDING_TIME_SECS);
  });

  it("adds a selected extension and builds camera flags as separate argv values", () => {
    expect(ensureRecordingExtension("C:\\captures\\demo", "mp4")).toBe("C:\\captures\\demo.mp4");
    expect(ensureRecordingExtension("demo.MKV", "mp4")).toBe("demo.mp4");
    expect(cameraOptionArgs({
      cameraId: "1",
      cameraSize: "1280x720",
      cameraAr: "16:9",
      cameraFps: 60,
      cameraFacing: "front",
      cameraTorch: true,
      cameraZoom: 1.5,
    })).toEqual([
      "--camera-size", "1280x720",
      "--camera-ar", "16:9",
      "--camera-fps", "60",
      "--camera-zoom", "1.5",
      "--camera-id", "1",
      "--camera-torch",
    ]);
  });
});
