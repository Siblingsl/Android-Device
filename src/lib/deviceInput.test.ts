import { describe, expect, it } from "vitest";
import { shortcutForScreenKey, validateDeviceText } from "./deviceInput";

describe("device input", () => {
  it("rejects whitespace-only device text", () => {
    expect(validateDeviceText("  ", "请输入内容")).toBe("请输入内容");
  });

  it("accepts non-empty device text", () => {
    expect(validateDeviceText(" hello ", "请输入内容")).toBeNull();
  });

  it("does not map shortcuts while an input field is focused", () => {
    const event = { key: "Home", target: { tagName: "INPUT" } } as unknown as KeyboardEvent;
    expect(shortcutForScreenKey(event)).toBeNull();
  });

  it("maps Home when the screen receives the key event", () => {
    const event = { key: "Home", target: { tagName: "DIV" } } as unknown as KeyboardEvent;
    expect(shortcutForScreenKey(event)).toBe("home");
  });
});
