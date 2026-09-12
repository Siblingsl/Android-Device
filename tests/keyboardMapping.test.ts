import { describe, expect, it } from "vitest";
import { mappingError, matchingMapping, normalizeMapping, parseForegroundPackage, type KeyboardMapping } from "../src/lib/keyboardMapping";

const base: KeyboardMapping = normalizeMapping({ id: "a", trigger: "W", action: "tap", x: 20, y: 30 });

describe("keyboardMapping", () => {
  it("clamps coordinates and only matches the selected context", () => {
    expect(normalizeMapping({ ...base, x: -1, y: 9000 }).x).toBe(0);
    expect(matchingMapping([base], "w")).toEqual(base);
    expect(matchingMapping([{ ...base, deviceId: "device-a" }], "w", "device-b")).toBeUndefined();
    expect(matchingMapping([{ ...base, appPackage: "com.example.game" }], "w", "device-a", "com.example.game")).toEqual({ ...base, appPackage: "com.example.game" });
    expect(matchingMapping([{ ...base, appPackage: "com.example.game" }], "w", "device-a", "com.example.home")).toBeUndefined();
  });

  it("validates swipe geometry", () => {
    expect(mappingError(normalizeMapping({ ...base, action: "swipe", x2: 20, y2: 30 }))).toContain("起点");
  });

  it("preserves joystick mappings and rejects a zero-length joystick", () => {
    const mapping = normalizeMapping({ ...base, action: "joystick", x: 100, y: 200, x2: 180, y2: 200 });
    expect(mapping.action).toBe("joystick");
    expect(mappingError(mapping)).toBeNull();
    expect(mappingError(normalizeMapping({ ...mapping, x2: 100, y2: 200 }))).toContain("起点");
  });

  it("requires an automation script for automation mappings", () => {
    const mapping = normalizeMapping({ ...base, action: "automation" });
    expect(mapping.action).toBe("automation");
    expect(mapping.automationId).toBe("");
    expect(mappingError(mapping)).toContain("自动化脚本");
    expect(mappingError(normalizeMapping({ ...mapping, automationId: "script-1" }))).toBeNull();
  });

  it("extracts the foreground package from Android window dumpsys output", () => {
    expect(parseForegroundPackage("mCurrentFocus=Window{123 u0 com.example.game/.MainActivity}"))
      .toBe("com.example.game");
    expect(parseForegroundPackage("topResumedActivity=ActivityRecord{456 u0 com.example.home/.HomeActivity t1}"))
      .toBe("com.example.home");
    expect(parseForegroundPackage("mCurrentFocus=null")).toBe("");
  });
});
