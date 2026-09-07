export const RES_PRESETS = [
  "720x1280",
  "1080x1920",
  "1080x2400",
  "1440x3200",
  "1200x1920",
] as const;

export const DPI_PRESETS = ["240", "320", "400", "480", "560"] as const;

export function validResolution(raw: string): boolean {
  return /^\d{2,5}\s*[x×]\s*\d{2,5}$/i.test(raw.trim());
}

export function validDpi(raw: string): boolean {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 120 && n <= 640;
}

export function presetOrCustom(value: string, presets: readonly string[]): string {
  return presets.includes(value) ? value : "__custom__";
}
