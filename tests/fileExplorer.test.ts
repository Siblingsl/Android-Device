import { afterEach, describe, expect, it, vi } from "vitest";
import { readInitialPath } from "../src/lib/filePathState";

describe("file explorer path restoration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the saved remote path before the first directory load", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => key === "rdc.files.path.serial-1" ? "/sdcard/Download" : null,
    });
    expect(readInitialPath("serial-1")).toBe("/sdcard/Download");
  });

  it("falls back to the device storage root when no path was saved", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    expect(readInitialPath("serial-2")).toBe("/sdcard");
  });
});
