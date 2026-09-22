import { describe, expect, it } from "vitest";
import type { QemuRedroidInstance } from "../types";
import { runningInstanceNames } from "./runtimeIdleRelease";

function row(instance: string, status: string): QemuRedroidInstance {
  return { instance, container: `qc-${instance}`, port: 24500, serial: `emulator-${instance}`, status };
}

describe("runningInstanceNames", () => {
  it("selects only rows whose status proves the container is running", () => {
    expect(
      runningInstanceNames([
        row("r1", "Up 2 hours"),
        row("r2", "running"),
        row("r3", "Exited (0)"),
        row("r4", "unknown"),
        row("r5", ""),
      ]),
    ).toEqual(["r1", "r2"]);
  });

  it("preserves row order and removes duplicate instance names", () => {
    expect(runningInstanceNames([row("r2", "running"), row("r1", "UP"), row("r2", "Up")])).toEqual([
      "r2",
      "r1",
    ]);
  });
});
