import type { KeyboardEvent, MouseEvent, RefObject, WheelEvent } from "react";
import { Camera, Expand, RotateCcw } from "lucide-react";
import { Button } from "../ui/Button";
import type { PreviewState } from "../../lib/devicePreview";
import { useI18n } from "../../i18n";

interface DevicePreviewProps {
  serial: string;
  disabled?: boolean;
  scrcpyStatus: string;
  preview: PreviewState;
  previewFlash: boolean;
  livePreview: boolean;
  fullscreen: boolean;
  hideChrome: boolean;
  screenRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLElement | null>;
  onMouseMove: (event: MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseUp: (event: MouseEvent<HTMLDivElement>) => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onStartScrcpy: () => void;
  onStopScrcpy: () => void;
  onRestartScrcpy: () => void;
  onTakeShot: () => void;
  onRefreshPreview: () => void;
  onToggleLivePreview: () => void;
  onClosePreview: () => void;
  onOpenFolder: () => void;
  onFullscreen: () => void;
  onRotate: () => void;
}

export function DevicePreview({
  disabled = false,
  scrcpyStatus,
  preview,
  previewFlash,
  livePreview,
  fullscreen,
  hideChrome,
  screenRef,
  frameRef,
  onMouseMove,
  onKeyDown,
  onClick,
  onDoubleClick,
  onContextMenu,
  onAuxClick,
  onMouseDown,
  onMouseUp,
  onWheel,
  onStartScrcpy,
  onStopScrcpy,
  onRestartScrcpy,
  onTakeShot,
  onRefreshPreview,
  onToggleLivePreview,
  onClosePreview,
  onOpenFolder,
  onFullscreen,
  onRotate,
}: DevicePreviewProps) {
  const { t } = useI18n();
  const chromeStyle = {
    opacity: hideChrome ? 0 : 1,
    pointerEvents: hideChrome ? "none" : "auto",
    transition: "opacity .2s",
  } as const;

  return (
    <div
      className="screen-area"
      ref={screenRef}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={disabled ? undefined : onKeyDown}
      onMouseMove={onMouseMove}
      onClick={disabled ? undefined : onClick}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onContextMenu={disabled ? undefined : onContextMenu}
      onAuxClick={disabled ? undefined : onAuxClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      onMouseUp={disabled ? undefined : onMouseUp}
      onWheel={disabled ? undefined : onWheel}
    >
      <div
        className="screen-toolbar"
        style={chromeStyle}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <div className="row">
          {scrcpyStatus === "running" ? (
            <Button size="sm" variant="primary" onClick={onStopScrcpy}>
              {t("detail.control.mirroringActive")}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={onStartScrcpy}>
              {t("detail.control.startMirroring")}
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={scrcpyStatus !== "running"} onClick={onStopScrcpy}>
            {t("detail.control.disconnect")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || scrcpyStatus !== "running"}
            onClick={onRestartScrcpy}
          >
            {t("detail.control.reconnect")}
          </Button>
          <Button size="sm" icon={<Camera size={14} />} disabled={disabled} onClick={onTakeShot}>
            {t("detail.control.screenshot")}
          </Button>
          {preview.path && <Button size="sm" variant="ghost" onClick={onOpenFolder}>{t("detail.control.openFolder")}</Button>}
        </div>
        <div className="row">
          <Button size="sm" variant="ghost" icon={<Expand size={14} />} onClick={onFullscreen}>
            {fullscreen ? t("detail.control.exitFullscreen") : t("detail.control.fullscreen")}
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} disabled={disabled} onClick={onRotate}>
            {t("detail.control.rotate")}
          </Button>
        </div>
      </div>

      {preview.image ? (
        <>
          <img
            ref={frameRef as RefObject<HTMLImageElement | null>}
            src={preview.image}
            alt={t("detail.control.previewAlt")}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
          <div
            className="row preview-toolbar"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            style={{ ...chromeStyle, position: "absolute", top: 52, right: 12, zIndex: 2, gap: 6 }}
          >
            {preview.status === "loading" && (
              <span className="badge info">{t("detail.control.previewLoading")}</span>
            )}
            {preview.updatedAt !== null && (
              <span className="badge info" style={{ opacity: previewFlash ? 1 : 0.7 }}>
                {previewFlash
                  ? t("detail.control.updated", { time: new Date(preview.updatedAt).toLocaleTimeString() })
                  : new Date(preview.updatedAt).toLocaleTimeString()}
              </span>
            )}
            <button type="button" className="badge" onClick={onToggleLivePreview}>
              {livePreview ? t("detail.control.stopRefresh") : t("detail.control.resumeRefresh")}
            </button>
            <button type="button" className="badge" onClick={onRefreshPreview}>
              {t("detail.control.refreshPreview")}
            </button>
            <button type="button" className="badge" onClick={onClosePreview}>
              {t("detail.control.closePreview")}
            </button>
          </div>
        </>
      ) : (
        <div ref={frameRef as RefObject<HTMLDivElement | null>} className="screen-placeholder">
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{t("detail.control.previewTitle")}</div>
          <div style={{ fontSize: 13, opacity: 0.8, maxWidth: 360, lineHeight: 1.6 }}>
            {t("detail.control.previewHint")}
          </div>
          {preview.status === "loading" ? (
            <div style={{ marginTop: 12 }} className="badge info">{t("detail.control.previewLoading")}</div>
          ) : preview.status === "error" ? (
            <div className="stack" style={{ alignItems: "center", marginTop: 12 }}>
              <span className="badge danger" title={preview.error}>{preview.error}</span>
              <Button size="sm" variant="secondary" disabled={disabled} onClick={onRefreshPreview}>
                {t("detail.control.retryPreview")}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={onRefreshPreview} style={{ marginTop: 12 }}>
              {t("detail.control.refreshPreview")}
            </Button>
          )}
          <div style={{ marginTop: 12 }} className="badge info">
            scrcpy: {scrcpyStatus}
          </div>
          {preview.path && (
            <div style={{ marginTop: 12 }}>
              <Button size="sm" variant="ghost" onClick={onOpenFolder}>
                {t("detail.control.openLastShotFolder")}
              </Button>
            </div>
          )}
        </div>
      )}

      {preview.status === "error" && preview.image && (
        <span className="badge danger preview-error" title={preview.error}>{preview.error}</span>
      )}

      <div
        className="screen-stats"
        hidden={fullscreen}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <span className="badge">{t("detail.control.hint.click")}</span>
        <span className="badge">{t("detail.control.hint.drag")}</span>
        <span className="badge">{t("detail.control.hint.wheel")}</span>
        <span className="badge">{t("detail.control.hint.dblclick")}</span>
        <span className="badge">{t("detail.control.hint.right")}</span>
        <span className="badge">{t("detail.control.hint.middle")}</span>
        <span className="badge">{t("detail.control.hint.keyboard")}</span>
      </div>
    </div>
  );
}
