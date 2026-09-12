import type { ScrcpyWindowPlacement } from "../types";

export interface ScrcpyLayoutConfig {
  columns: number;
  width: number;
  height: number;
  gap: number;
  originX: number;
  originY: number;
}

export const DEFAULT_SCRCPY_LAYOUT: ScrcpyLayoutConfig = {
  columns: 2,
  width: 480,
  height: 800,
  gap: 16,
  originX: 0,
  originY: 0,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function normalizeScrcpyLayout(
  input: Partial<ScrcpyLayoutConfig> = {},
): ScrcpyLayoutConfig {
  const columns = Number(input.columns);
  const width = Number(input.width);
  const height = Number(input.height);
  const gap = Number(input.gap);
  const originX = Number(input.originX);
  const originY = Number(input.originY);
  return {
    columns: Number.isFinite(columns)
      ? Math.round(clamp(columns, 1, 8))
      : DEFAULT_SCRCPY_LAYOUT.columns,
    width: Number.isFinite(width)
      ? Math.round(clamp(width, 240, 1600))
      : DEFAULT_SCRCPY_LAYOUT.width,
    height: Number.isFinite(height)
      ? Math.round(clamp(height, 240, 1600))
      : DEFAULT_SCRCPY_LAYOUT.height,
    gap: Number.isFinite(gap)
      ? Math.round(clamp(gap, 0, 120))
      : DEFAULT_SCRCPY_LAYOUT.gap,
    originX: Number.isFinite(originX)
      ? Math.round(clamp(originX, -10000, 10000))
      : DEFAULT_SCRCPY_LAYOUT.originX,
    originY: Number.isFinite(originY)
      ? Math.round(clamp(originY, -10000, 10000))
      : DEFAULT_SCRCPY_LAYOUT.originY,
  };
}

export function scrcpyWindowPlacement(
  index: number,
  layout: ScrcpyLayoutConfig,
): ScrcpyWindowPlacement {
  const normalized = normalizeScrcpyLayout(layout);
  const safeIndex = Math.max(0, Math.floor(index));
  const column = safeIndex % normalized.columns;
  const row = Math.floor(safeIndex / normalized.columns);
  return {
    x: normalized.originX + column * (normalized.width + normalized.gap),
    y: normalized.originY + row * (normalized.height + normalized.gap),
    width: normalized.width,
    height: normalized.height,
  };
}
