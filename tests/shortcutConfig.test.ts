import { describe, expect, it } from "vitest";
import {
  findShortcutConflicts,
  normalizeShortcutKey,
  shortcutKeyError,
  type ShortcutBinding,
} from "../src/lib/shortcutConfig";

describe("shortcutConfig", () => {
  it("normalizes common desktop key notation", () => {
    expect(normalizeShortcutKey(" ctrl + shift + s ")).toBe("CommandOrControl+Shift+S");
    expect(normalizeShortcutKey("Alt+a")).toBe("Alt+A");
  });

  it("rejects modifier-only shortcuts and finds enabled conflicts", () => {
    expect(shortcutKeyError("Ctrl+Shift")).toContain("实际按键");
    const bindings: ShortcutBinding[] = [
      { id: "a", key: "Ctrl+S", action: "screenshot", deviceId: "", enabled: true },
      { id: "b", key: "CommandOrControl+S", action: "home", deviceId: "", enabled: true },
      { id: "c", key: "CommandOrControl+S", action: "back", deviceId: "", enabled: false },
    ];
    expect(findShortcutConflicts(bindings)).toEqual([["a", "b"]]);
  });
});
