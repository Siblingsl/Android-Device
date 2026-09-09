import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRCPY_CONTROL_ORDER,
  moveScrcpyControl,
  normalizeScrcpyControlOrder,
} from "./scrcpyControlLayout";

describe("scrcpy control layout", () => {
  it("repairs stored layouts without losing newly added controls", () => {
    expect(normalizeScrcpyControlOrder(["back", "back", "unknown", "start"])).toEqual([
      "back",
      "start",
      ...DEFAULT_SCRCPY_CONTROL_ORDER.filter((id) => id !== "back" && id !== "start"),
    ]);
  });

  it("moves a dragged control and keeps an invalid drag a no-op", () => {
    const order = [...DEFAULT_SCRCPY_CONTROL_ORDER];
    expect(moveScrcpyControl(order, "power", "start").slice(0, 2)).toEqual(["power", "start"]);
    expect(moveScrcpyControl(order, "power", "missing" as never)).toBe(order);
  });
});
