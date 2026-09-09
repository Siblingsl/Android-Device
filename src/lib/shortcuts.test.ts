// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  matchesShortcut,
  persistShortcuts,
  readShortcuts,
  shortcutActionForEvent,
  type ShortcutAction,
} from "./shortcuts";

describe("application shortcuts", () => {
  afterEach(() => localStorage.clear());

  it("loads defaults and persists customized bindings", () => {
    expect(readShortcuts()).toEqual(DEFAULT_SHORTCUTS);

    persistShortcuts({ ...DEFAULT_SHORTCUTS, openDevices: "Alt+D" });

    expect(readShortcuts().openDevices).toBe("Alt+D");
  });

  it("formats a keyboard event into a stable display value", () => {
    const event = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(formatShortcut(event)).toBe("Ctrl+Shift+P");
    expect(formatShortcut(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
  });

  it("matches configured shortcuts without stealing editable fields", () => {
    const event = new KeyboardEvent("keydown", { key: "2", ctrlKey: true });
    expect(matchesShortcut(event, "Ctrl+2")).toBe(true);

    const input = document.createElement("input");
    document.body.appendChild(input);
    const inputEvent = new KeyboardEvent("keydown", { key: "2", ctrlKey: true });
    Object.defineProperty(inputEvent, "target", { value: input });
    expect(matchesShortcut(inputEvent, "Ctrl+2")).toBe(false);
    input.remove();
  });

  it("finds conflicts while allowing the current action to keep its binding", () => {
    const bindings = { ...DEFAULT_SHORTCUTS, openDevices: "Alt+D" };
    expect(findShortcutConflict(bindings, "Alt+D", "openDevices")).toBeNull();
    expect(findShortcutConflict(bindings, "Alt+D", "openSettings" as ShortcutAction)).toBe("openDevices");
  });

  it("resolves a pressed combination to its configured action", () => {
    const bindings = { ...DEFAULT_SHORTCUTS, openDevices: "Alt+D" };
    expect(
      shortcutActionForEvent(new KeyboardEvent("keydown", { key: "d", altKey: true }), bindings),
    ).toBe("openDevices");
  });
});
