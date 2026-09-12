import { afterEach, describe, expect, it, vi } from "vitest";
import { arrangementAutoRestoreEnabled, buildGridLayout, readArrangement, saveArrangement, setArrangementAutoRestoreEnabled, updateArrangementBounds } from "../src/stores/layoutStore";
import type { DeviceInfo } from "../src/types";

const device = (id: string): DeviceInfo => ({
  id, name: id, serial: id, androidVersion: "", online: true, cpu: "", ram: "", fps: 0,
  adbStatus: "device", scrcpyStatus: "", dockerStatus: "", ip: "", mac: "", resolution: "",
  dpi: "", containerId: "", image: "", startedAt: "", uptime: "", adbPort: 5555, scrcpyPort: 0,
});

describe("device arrangement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates resizable layout items with safe default heights", () => {
    expect(buildGridLayout([device("a"), device("b")])).toEqual([
      { id: "a", order: 0, span: 1, height: 360, x: 0, y: 0, width: 560 },
      { id: "b", order: 1, span: 1, height: 360, x: 560, y: 0, width: 560 },
    ]);
  });

  it("persists the opt-in window restore switch", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
    setArrangementAutoRestoreEnabled(true);
    expect(arrangementAutoRestoreEnabled()).toBe(true);
    setArrangementAutoRestoreEnabled(false);
    expect(arrangementAutoRestoreEnabled()).toBe(false);
    storage.removeItem("rdc.device-arrangement.restore");
  });

  it("persists native window bounds for the matching device only", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    saveArrangement(buildGridLayout([device("a"), device("b")]));
    updateArrangementBounds("b", 24, 48, 720, 520);
    const result = readArrangement([device("a"), device("b")]);
    expect(result.find((item) => item.id === "a")).toMatchObject({ x: 0, y: 0, width: 560, height: 360 });
    expect(result.find((item) => item.id === "b")).toMatchObject({ x: 24, y: 48, width: 720, height: 520 });
  });
});
