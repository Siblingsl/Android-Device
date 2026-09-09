import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRCPY_LAYOUT,
  normalizeScrcpyLayout,
  scrcpyWindowPlacement,
} from "./scrcpyWindowLayout";

describe("scrcpy window layout", () => {
  it("places windows row by row using the configured columns and gap", () => {
    const layout = { ...DEFAULT_SCRCPY_LAYOUT, columns: 2, gap: 16 };
    expect(scrcpyWindowPlacement(0, layout)).toEqual({ x: 0, y: 0, width: 480, height: 800 });
    expect(scrcpyWindowPlacement(1, layout)).toEqual({ x: 496, y: 0, width: 480, height: 800 });
    expect(scrcpyWindowPlacement(2, layout)).toEqual({ x: 0, y: 816, width: 480, height: 800 });
  });

  it("clamps invalid saved values instead of creating unusable windows", () => {
    expect(normalizeScrcpyLayout({ columns: 0, width: 20, height: 9999, gap: -4 })).toEqual(
      { ...DEFAULT_SCRCPY_LAYOUT, columns: 1, width: 240, height: 1600, gap: 0 },
    );
  });
});
