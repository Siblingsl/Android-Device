import { describe, expect, it } from "vitest";
import { runtimeMemoryPressure, runtimeProfileAvailable, runtimeProfileDefaults } from "./runtimeProfile";

describe("runtime profile defaults", () => {
  it("keeps the lean 4 GiB node at a 1536 MiB starting limit", () => {
    expect(runtimeProfileDefaults("lean", 4, 4096)).toMatchObject({
      cpus: 1,
      memoryMib: 1536,
      installGapps: false,
      installMagisk: false,
    });
  });

  it("keeps the lean 3 GiB node at the measured 1536 MiB floor", () => {
    expect(runtimeProfileDefaults("lean", 4, 3072)).toMatchObject({
      cpus: 1,
      memoryMib: 1536,
      installGapps: false,
      installMagisk: false,
    });
  });

  it("reserves node headroom before offering a full profile", () => {
    expect(runtimeProfileDefaults("full", 4, 4096)).toMatchObject({
      cpus: 2,
      memoryMib: 3072,
      installGapps: true,
      installMagisk: true,
    });
  });

  it("keeps the standard 4 GiB starting limit at 2048 MiB", () => {
    expect(runtimeProfileDefaults("standard", 4, 4096)).toMatchObject({
      cpus: 1,
      memoryMib: 2048,
      installGapps: false,
      installMagisk: false,
    });
  });

  it("still scales the standard profile on a large node", () => {
    expect(runtimeProfileDefaults("standard", 16, 65536).memoryMib).toBe(8192);
  });

  it("classifies per-instance cgroup saturation independently from host pressure", () => {
    expect(runtimeMemoryPressure(749, 1_000)).toBe("normal");
    expect(runtimeMemoryPressure(750, 1_000)).toBe("caution");
    expect(runtimeMemoryPressure(899, 1_000)).toBe("caution");
    expect(runtimeMemoryPressure(900, 1_000)).toBe("critical");
    expect(runtimeMemoryPressure(null, 1_000)).toBe("unknown");
    expect(runtimeMemoryPressure(1_000, 0)).toBe("unknown");
  });

  it("does not offer the full profile on a 4 GiB node", () => {
    expect(runtimeProfileAvailable("full", 4096)).toBe(false);
    expect(runtimeProfileAvailable("full", 6144)).toBe(true);
    expect(runtimeProfileAvailable("standard", 4096)).toBe(true);
    expect(runtimeProfileAvailable("lean", 4096)).toBe(true);
  });
});
