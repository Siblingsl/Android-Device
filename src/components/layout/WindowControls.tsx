import { useEffect, useState } from "react";
import { Copy, Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "../../i18n";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const resizeHandles: Array<{ name: string; direction: ResizeDirection }> = [
  { name: "n", direction: "North" },
  { name: "ne", direction: "NorthEast" },
  { name: "e", direction: "East" },
  { name: "se", direction: "SouthEast" },
  { name: "s", direction: "South" },
  { name: "sw", direction: "SouthWest" },
  { name: "w", direction: "West" },
  { name: "nw", direction: "NorthWest" },
];

const isTauriWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function runNative(action: () => Promise<void>) {
  void action().catch(() => {
    /* The native window may disappear while the action is in flight. */
  });
}

export function WindowDragRegion() {
  const beginDragging = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isTauriWindow() || event.button !== 0) return;
    event.preventDefault();
    runNative(() => getCurrentWindow().startDragging());
  };

  const toggleMaximized = () => {
    if (isTauriWindow()) runNative(() => getCurrentWindow().toggleMaximize());
  };

  return (
    <div
      className="topbar-drag-region"
      aria-hidden="true"
      data-testid="window-drag-region"
      onMouseDown={beginDragging}
      onDoubleClick={toggleMaximized}
    />
  );
}

export function WindowResizeHandles() {
  if (!isTauriWindow()) return null;

  const beginResizing = (event: React.MouseEvent<HTMLSpanElement>, direction: ResizeDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    runNative(() => getCurrentWindow().startResizeDragging(direction));
  };

  return (
    <div className="window-resize-handles" aria-hidden="true">
      {resizeHandles.map(({ name, direction }) => (
        <span
          key={name}
          className={`window-resize-handle window-resize-${name}`}
          data-testid={`window-resize-${name}`}
          onMouseDown={(event) => beginResizing(event, direction)}
        />
      ))}
    </div>
  );
}

export function WindowControls() {
  const { t } = useI18n();
  const isTauri = isTauriWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    const syncMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch {
        /* Browser preview and unsupported shells have no native window state. */
      }
    };

    void syncMaximized();
    void appWindow.onResized(() => { void syncMaximized(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => {
      /* Browser preview has no native resize event bridge. */
    });
    void appWindow.onScaleChanged(() => { void syncMaximized(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenScale = cleanup;
    }).catch(() => {
      /* Browser preview has no native scale-change event bridge. */
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenScale?.();
    };
  }, [isTauri]);

  if (!isTauri) return null;

  return (
    <div className="window-controls">
      <span className="window-controls-divider" aria-hidden="true" />
      <button
        type="button"
        className="window-control"
        aria-label={t("common.window.minimize")}
        title={t("common.window.minimize")}
        onClick={() => runNative(() => getCurrentWindow().minimize())}
      >
        <Minus size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={t(maximized ? "common.window.restore" : "common.window.maximize")}
        title={t(maximized ? "common.window.restore" : "common.window.maximize")}
        onClick={() => runNative(() => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? <Copy size={13} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
      </button>
      <button
        type="button"
        className="window-control close"
        aria-label={t("common.window.close")}
        title={t("common.window.close")}
        onClick={() => runNative(() => getCurrentWindow().close())}
      >
        <X size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
