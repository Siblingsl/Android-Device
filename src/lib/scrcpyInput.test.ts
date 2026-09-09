import { describe, expect, it } from "vitest";
import {
  DEFAULT_OTG_OPTIONS,
  DEFAULT_UHID_OPTIONS,
  inputModeArgs,
  normalizeInputOptions,
} from "./scrcpyInput";

describe("scrcpy input modes", () => {
  it("keeps UHID as the wireless-capable keyboard and mouse default", () => {
    expect(inputModeArgs("uhid", DEFAULT_UHID_OPTIONS)).toEqual([
      "--no-video",
      "--no-audio",
      "--keyboard=uhid",
      "--mouse=uhid",
    ]);
  });

  it("does not enable the OTG gamepad unless the user explicitly selects it", () => {
    expect(inputModeArgs("otg", DEFAULT_OTG_OPTIONS)).toEqual([
      "--otg",
      "--keyboard=aoa",
      "--mouse=aoa",
    ]);
    expect(inputModeArgs("otg", { ...DEFAULT_OTG_OPTIONS, gamepad: true })).toContain("--gamepad=aoa");
  });

  it("normalizes disabled devices without letting UHID inherit OTG-only gamepad input", () => {
    expect(normalizeInputOptions("uhid", { keyboard: false, mouse: false, gamepad: true })).toEqual({
      keyboard: false,
      mouse: false,
      gamepad: false,
    });
  });
});
