import { describe, expect, it } from "vitest";
import { normalizeActionError, shellResultFailure } from "./deviceActions";

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
});
