import { describe, expect, it } from "vitest";
import { getControlActions } from "../src/lib/controlActions";

describe("getControlActions", () => {
  it("exposes the common device workbench actions", () => {
    expect(getControlActions(true).map((action) => action.id)).toEqual([
      "home",
      "back",
      "recent",
      "power",
      "lock",
      "wake",
      "screen-off",
      "rotate",
      "volume-up",
      "volume-down",
      "mute",
      "restart",
      "recording",
      "stream",
      "notifications",
      "settings",
      "screenshot",
      "install-apk",
      "apps",
      "network",
      "scrcpy-config",
      "files",
      "terminal",
    ]);
  });

  it("marks ADB actions unavailable while the device is offline", () => {
    expect(getControlActions(false).every((action) => action.disabled)).toBe(true);
    expect(getControlActions(false).every((action) => action.disabledReason === "需在线")).toBe(true);
  });
});
