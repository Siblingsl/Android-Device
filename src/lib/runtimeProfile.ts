import type { ResourceProfile } from "../types";

export interface RuntimeProfileDefaults {
  cpus: number;
  memoryMib: number;
  installGapps: boolean;
  installMagisk: boolean;
}

export type RuntimeMemoryPressure = "normal" | "caution" | "critical" | "unknown";

/** Matches the authoritative qemu-center admission boundary for full. */
export const FULL_PROFILE_MIN_NODE_MEMORY_MIB = 6144;

export function runtimeProfileAvailable(
  profile: ResourceProfile,
  nodeMemMib: number,
): boolean {
  if (!Number.isFinite(nodeMemMib) || nodeMemMib <= 0) return false;
  return profile !== "full" || nodeMemMib >= FULL_PROFILE_MIN_NODE_MEMORY_MIB;
}

/** Classify one instance's cgroup usage; host pressure is a separate signal. */
export function runtimeMemoryPressure(
  currentBytes: number | null | undefined,
  limitBytes: number | null | undefined,
): RuntimeMemoryPressure {
  if (
    typeof currentBytes !== "number" ||
    typeof limitBytes !== "number" ||
    !Number.isFinite(currentBytes) ||
    !Number.isFinite(limitBytes) ||
    currentBytes < 0 ||
    limitBytes <= 0
  ) {
    return "unknown";
  }
  const ratio = currentBytes / limitBytes;
  if (!Number.isFinite(ratio)) return "unknown";
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.75) return "caution";
  return "normal";
}

/** Match the qemu-center profile ladder for the create form. */
export function runtimeProfileDefaults(
  profile: ResourceProfile,
  nodeVcpus: number,
  nodeMemMib: number,
): RuntimeProfileDefaults {
  const memory = Math.max(1024, nodeMemMib);
  const reserved = Math.max(512, Math.floor(memory / 4));
  const available = Math.max(0, memory - reserved);
  if (profile === "lean") {
    // The 3 GiB/4 GiB XHS baseline needs a 1536 MiB cgroup ceiling. Keep a
    // smaller-node fallback, but do not offer the 1152 MiB value that can
    // turn a usable lean instance into an avoidable OOM experiment.
    const leanFloor = memory >= 3072 ? 1536 : 1024;
    return {
      cpus: Math.max(1, Math.floor(nodeVcpus / 4)),
      memoryMib: Math.min(4096, Math.max(leanFloor, Math.floor(available / 2))),
      installGapps: false,
      installMagisk: false,
    };
  }
  if (profile === "full") {
    return {
      cpus: Math.max(1, Math.floor(nodeVcpus / 2)),
      memoryMib: Math.min(8192, Math.max(1536, available)),
      installGapps: true,
      installMagisk: true,
    };
  }
  return {
    cpus: Math.max(1, Math.floor(nodeVcpus / 3)),
    memoryMib: Math.min(
      8192,
      Math.max(1024, Math.min(Math.max(1024, available), Math.max(2048, Math.floor(memory / 4)))),
    ),
    installGapps: false,
    installMagisk: false,
  };
}
