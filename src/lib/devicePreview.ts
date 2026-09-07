export type PreviewStatus = "empty" | "loading" | "ready" | "error";

export interface PreviewState {
  status: PreviewStatus;
  image: string | null;
  path: string;
  updatedAt: number | null;
  error: string;
}

export interface ScreenshotLike {
  success: boolean;
  base64?: string;
  path?: string;
  error?: string;
}

export function emptyPreview(): PreviewState {
  return {
    status: "empty",
    image: null,
    path: "",
    updatedAt: null,
    error: "",
  };
}

export function startPreviewRequest(previous: PreviewState): PreviewState {
  return { ...previous, status: "loading", error: "" };
}

export function finishPreviewRequest(
  previous: PreviewState,
  result: ScreenshotLike,
  now: number,
): PreviewState {
  if (!result.success) return failPreviewRequest(previous, result.error || "截图失败");

  return {
    ...previous,
    status: "ready",
    image: result.base64 ? `data:image/png;base64,${result.base64}` : previous.image,
    path: result.path || previous.path,
    updatedAt: now,
    error: "",
  };
}

export function failPreviewRequest(previous: PreviewState, message: string): PreviewState {
  return {
    ...previous,
    status: "error",
    error: message.trim() || "截图失败",
  };
}

export function canRefreshPreview(input: { disabled: boolean; visible: boolean }): boolean {
  return !input.disabled && input.visible;
}

export function createPreviewRefreshGate(refresh: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  return {
    resume() {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) refresh();
      }, delayMs);
    },
    pause() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      disposed = true;
    },
  };
}
