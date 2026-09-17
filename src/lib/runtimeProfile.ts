import type { ResourceProfile } from "../types";

export interface RuntimeProfileDefaults {
  cpus: number;
  memoryMib: number;
  installGapps: boolean;
  installMagisk: boolean;
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
    return {
      cpus: Math.max(1, Math.floor(nodeVcpus / 4)),
      memoryMib: Math.min(4096, Math.max(1024, Math.floor(available / 2))),
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
    memoryMib: Math.min(8192, Math.max(1024, Math.floor(memory / 4))),
    installGapps: false,
    installMagisk: false,
  };
}
