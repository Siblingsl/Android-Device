export interface ResourceSample {
  at: number;
  cpuUsage: number;
  memoryUsage: number;
}

function safeUsage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function appendResourceSample(
  samples: ResourceSample[],
  sample: ResourceSample,
  limit = 12,
): ResourceSample[] {
  const normalized: ResourceSample = {
    at: sample.at,
    cpuUsage: safeUsage(sample.cpuUsage),
    memoryUsage: safeUsage(sample.memoryUsage),
  };
  const boundedLimit = Math.max(1, Math.floor(limit));
  return [...samples, normalized].slice(-boundedLimit);
}
