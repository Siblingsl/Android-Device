import { describe, expect, it } from "vitest";
import {
  normalizeActionError,
  formatShellOutput,
  runDeviceAction,
  shellResultFailure,
} from "./deviceActions";

describe("shellResultFailure", () => {
  it("returns stderr when a resolved shell result reports failure", () => {
    expect(
      shellResultFailure(
        { success: false, stdout: "", stderr: "permission denied", exitCode: 1 },
        "操作失败",
      ),
    ).toBe("permission denied");
  });

  it("uses the fallback when a failed result has no output", () => {
    expect(shellResultFailure({ success: false, stdout: "", stderr: "" }, "操作失败")).toBe(
      "操作失败",
    );
  });

  it("normalizes non-Error exceptions", () => {
    expect(normalizeActionError("ADB unavailable", "操作失败").message).toBe("ADB unavailable");
  });

  it("runs onFinally after a resolved failed ShellResult", async () => {
    const events: string[] = [];

    await expect(
      runDeviceAction(
        async () => ({ success: false, stdout: "device offline", stderr: "", exitCode: 1 }),
        {
          fallback: "设备操作失败",
          onStart: () => {
            events.push("start");
          },
          onError: (error) => {
            events.push(`error:${error.message}`);
          },
          onFinally: () => {
            events.push("finally");
          },
        },
      ),
    ).rejects.toThrow("device offline");

    expect(events).toEqual(["start", "error:device offline", "finally"]);
  });

  it("preserves stderr and exit code in command diagnostics", () => {
    expect(formatShellOutput("stdout text", "stderr text", 7)).toBe(
      "stdout text\nstderr text\n[exit 7]",
    );
  });
});
