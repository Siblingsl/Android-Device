import { describe, expect, it } from "vitest";
import { appendResourceSample, type ResourceSample } from "./resourceMetrics";

describe("appendResourceSample", () => {
  it("keeps a bounded oldest-to-newest trend and clamps invalid usage", () => {
    const samples: ResourceSample[] = [
      { at: 1, cpuUsage: 10, memoryUsage: 20 },
      { at: 2, cpuUsage: 30, memoryUsage: 40 },
    ];

    expect(
      appendResourceSample(samples, { at: 3, cpuUsage: 120, memoryUsage: -5 }, 2),
    ).toEqual([
      { at: 2, cpuUsage: 30, memoryUsage: 40 },
      { at: 3, cpuUsage: 100, memoryUsage: 0 },
    ]);
  });

  it("normalizes non-finite samples to safe zero values", () => {
    expect(
      appendResourceSample([], { at: 1, cpuUsage: Number.NaN, memoryUsage: Number.POSITIVE_INFINITY }),
    ).toEqual([{ at: 1, cpuUsage: 0, memoryUsage: 0 }]);
  });
});
