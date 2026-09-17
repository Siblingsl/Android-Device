import { describe, expect, it } from "vitest";
import { runtimeProfileDefaults } from "./runtimeProfile";

describe("runtime profile defaults", () => {
  it("keeps the lean 4 GiB node at a 1536 MiB starting limit", () => {
    expect(runtimeProfileDefaults("lean", 4, 4096)).toMatchObject({
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
});
