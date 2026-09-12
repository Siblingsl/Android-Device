import { beforeEach, describe, expect, it } from "vitest";
import { getAllDeviceMetadata, getDeviceMetadata, removeDeviceMetadata, setDeviceMetadata } from "../src/lib/deviceMetadata";

const values = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

describe("device metadata", () => {
  beforeEach(() => values.clear());

  it("stores and removes historical records without affecting device data", () => {
    setDeviceMetadata("stale-device", {
      remark: "旧测试机",
      group: "回收",
      labels: ["旧", "旧"],
      autoConnect: true,
      autoMirror: false,
    });

    expect(getAllDeviceMetadata()["stale-device"].labels).toEqual(["旧"]);
    expect(removeDeviceMetadata("stale-device")).toBe(true);
    expect(getAllDeviceMetadata()).toEqual({});
    expect(getDeviceMetadata("stale-device").remark).toBe("");
    expect(removeDeviceMetadata("stale-device")).toBe(false);
  });
});
