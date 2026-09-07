import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRefreshPreview,
  createPreviewRefreshGate,
  emptyPreview,
  failPreviewRequest,
  finishPreviewRequest,
  startPreviewRequest,
} from "./devicePreview";

describe("device preview state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the last successful image when a later screenshot fails", () => {
    const ready = finishPreviewRequest(
      startPreviewRequest(emptyPreview()),
      { success: true, base64: "abc", path: "C:\\shots\\one.png" },
      1000,
    );

    const failed = failPreviewRequest(ready, "ADB timeout");

    expect(failed.status).toBe("error");
    expect(failed.image).toBe("data:image/png;base64,abc");
    expect(failed.path).toBe("C:\\shots\\one.png");
    expect(failed.error).toBe("ADB timeout");
  });

  it("does not create duplicate refresh timers after pause and resume", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const gate = createPreviewRefreshGate(refresh, 2000);

    gate.resume();
    gate.resume();
    vi.advanceTimersByTime(1999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    gate.pause();
    gate.resume();
    gate.dispose();
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the device is offline or the page is hidden", () => {
    expect(canRefreshPreview({ disabled: true, visible: true })).toBe(false);
    expect(canRefreshPreview({ disabled: false, visible: false })).toBe(false);
    expect(canRefreshPreview({ disabled: false, visible: true })).toBe(true);
  });
});
