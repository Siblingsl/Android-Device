import type { QemuRedroidInstance } from "../types";

/**
 * Return rows that prove a container is running, preserving display order and
 * removing duplicate instance ids. The backend still decides whether each row
 * is actually idle, protected, or otherwise safe to stop.
 */
export function runningInstanceNames(instances: QemuRedroidInstance[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const instance of instances) {
    const status = instance.status.trim().toLowerCase();
    const running = status === "running" || status === "up" || status.startsWith("up ");
    if (running && !seen.has(instance.instance)) {
      seen.add(instance.instance);
      names.push(instance.instance);
    }
  }
  return names;
}
