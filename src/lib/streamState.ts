export type StreamPresentation =
  | { kind: "offline"; label: "需在线" }
  | { kind: "starting"; label: "启动中" }
  | { kind: "running"; label: "投屏中" }
  | { kind: "error"; label: "投屏失败" }
  | { kind: "stopped"; label: "未启动" };

export function getStreamPresentation(input: {
  online: boolean;
  adbStatus: string;
  streamStatus: string;
}): StreamPresentation {
  if (!input.online || input.adbStatus !== "device") {
    return { kind: "offline", label: "需在线" };
  }
  if (input.streamStatus === "starting") return { kind: "starting", label: "启动中" };
  if (input.streamStatus === "running") return { kind: "running", label: "投屏中" };
  if (input.streamStatus === "error") return { kind: "error", label: "投屏失败" };
  return { kind: "stopped", label: "未启动" };
}

export function mapContainedPoint(
  rect: { left: number; top: number; width: number; height: number },
  contentWidth: number,
  contentHeight: number,
  clientX: number,
  clientY: number,
) {
  const safeWidth = Math.max(1, contentWidth);
  const safeHeight = Math.max(1, contentHeight);
  const scale = Math.min(rect.width / safeWidth, rect.height / safeHeight);
  const renderedWidth = safeWidth * scale;
  const renderedHeight = safeHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const x = Math.max(0, Math.min(1, (clientX - rect.left - offsetX) / Math.max(1, renderedWidth)));
  const y = Math.max(0, Math.min(1, (clientY - rect.top - offsetY) / Math.max(1, renderedHeight)));
  return { x: Math.round(x * safeWidth), y: Math.round(y * safeHeight) };
}
