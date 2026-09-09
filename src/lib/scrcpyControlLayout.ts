export const DEFAULT_SCRCPY_CONTROL_ORDER = [
  "start",
  "stop",
  "restart",
  "screenshot",
  "home",
  "back",
  "recent",
  "volumeUp",
  "volumeDown",
  "power",
  "lock",
  "wake",
  "rotate",
  "fullscreen",
] as const;

export type ScrcpyControlId = (typeof DEFAULT_SCRCPY_CONTROL_ORDER)[number];

export function normalizeScrcpyControlOrder(raw: unknown): ScrcpyControlId[] {
  const known = new Set<string>(DEFAULT_SCRCPY_CONTROL_ORDER);
  const source = Array.isArray(raw) ? raw : [];
  const normalized = source.filter((value): value is ScrcpyControlId => typeof value === "string" && known.has(value));
  const seen = new Set<string>();
  const result: ScrcpyControlId[] = [];
  for (const value of [...normalized, ...DEFAULT_SCRCPY_CONTROL_ORDER]) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function moveScrcpyControl(
  order: ScrcpyControlId[],
  source: ScrcpyControlId,
  target: ScrcpyControlId,
): ScrcpyControlId[] {
  if (source === target) return order;
  const next = [...order];
  const from = next.indexOf(source);
  const to = next.indexOf(target);
  if (from < 0 || to < 0) return order;
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
