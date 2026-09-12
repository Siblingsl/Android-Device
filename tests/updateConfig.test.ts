import { describe, expect, it } from "vitest";
import { isUpdaterConfigured, updateStateAfterCancellation } from "../src/lib/updateConfig";

describe("updater build configuration", () => {
  it("only treats an explicit release flag as configured", () => {
    expect(isUpdaterConfigured("1")).toBe(true);
    expect(isUpdaterConfigured(undefined)).toBe(false);
    expect(isUpdaterConfigured("0")).toBe(false);
  });

  it("returns an idle state after a user cancels download", () => {
    expect(updateStateAfterCancellation()).toEqual({ state: "idle", progress: 0, message: "已取消更新下载" });
  });
});
