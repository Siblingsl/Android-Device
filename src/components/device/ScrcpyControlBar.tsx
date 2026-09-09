import { useRef, useState } from "react";
import {
  Camera,
  Expand,
  GripVertical,
  House,
  Lock,
  Power,
  RotateCcw,
  RotateCw,
  Square,
  Triangle,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import {
  DEFAULT_SCRCPY_CONTROL_ORDER,
  moveScrcpyControl,
  normalizeScrcpyControlOrder,
  type ScrcpyControlId,
} from "../../lib/scrcpyControlLayout";

type ScrcpyControlBarProps = {
  scrcpyStatus: string;
  disabled?: boolean;
  busy?: string | null;
  onAction: (action: ScrcpyControlId) => void;
};

const STORAGE_KEY = "rdc.scrcpy.controlOrder";

export function ScrcpyControlBar({ scrcpyStatus, disabled = false, busy = null, onAction }: ScrcpyControlBarProps) {
  const { t } = useI18n();
  const [order, setOrder] = useState<ScrcpyControlId[]>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      return normalizeScrcpyControlOrder(stored ? JSON.parse(stored) : DEFAULT_SCRCPY_CONTROL_ORDER);
    } catch {
      return [...DEFAULT_SCRCPY_CONTROL_ORDER];
    }
  });
  const dragId = useRef<ScrcpyControlId | null>(null);

  const saveOrder = (next: ScrcpyControlId[]) => {
    setOrder(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage is optional */
    }
  };

  const labelFor = (id: ScrcpyControlId) => {
    const labels: Record<ScrcpyControlId, string> = {
      start: t("detail.control.startMirroring"),
      stop: t("detail.control.disconnect"),
      restart: t("detail.control.reconnect"),
      screenshot: t("detail.control.screenshot"),
      home: "HOME",
      back: "BACK",
      recent: "RECENT",
      volumeUp: t("detail.control.volUp"),
      volumeDown: t("detail.control.volDown"),
      power: "POWER",
      lock: t("detail.control.lock"),
      wake: t("detail.control.wake"),
      rotate: t("detail.control.rotate"),
      fullscreen: t("detail.control.fullscreen"),
    };
    return labels[id];
  };

  const iconFor = (id: ScrcpyControlId) => {
    const icons: Record<ScrcpyControlId, React.ReactNode> = {
      start: <Triangle size={13} fill="currentColor" />,
      stop: <Square size={13} />,
      restart: <RotateCcw size={13} />,
      screenshot: <Camera size={13} />,
      home: <House size={13} />,
      back: <RotateCcw size={13} />,
      recent: <Square size={13} />,
      volumeUp: <Volume2 size={13} />,
      volumeDown: <Volume1 size={13} />,
      power: <Power size={13} />,
      lock: <Lock size={13} />,
      wake: <VolumeX size={13} />,
      rotate: <RotateCw size={13} />,
      fullscreen: <Expand size={13} />,
    };
    return icons[id];
  };

  return (
    <div className="scrcpy-control-bar" aria-label={t("detail.control.quickBar")}>
      <div className="scrcpy-control-bar-title">{t("detail.control.quickBar")}</div>
      <div className="scrcpy-control-items">
        {order.map((id) => {
          const actionBusy = busy === id || (id === "start" && busy === "start") || (id === "stop" && busy === "stop") || (id === "restart" && busy === "restart");
          const actionDisabled = disabled || Boolean(busy) || (id === "stop" || id === "restart" ? scrcpyStatus !== "running" : false);
          return (
            <div
              key={id}
              className="scrcpy-control-item-wrap"
              draggable
              onDragStart={() => { dragId.current = id; }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragId.current) saveOrder(moveScrcpyControl(order, dragId.current, id));
                dragId.current = null;
              }}
              onDragEnd={() => { dragId.current = null; }}
            >
              <GripVertical size={11} className="scrcpy-control-drag" aria-hidden="true" />
              <Button
                size="sm"
                variant={id === "start" && scrcpyStatus !== "running" ? "primary" : "ghost"}
                icon={iconFor(id)}
                title={labelFor(id)}
                aria-label={labelFor(id)}
                loading={actionBusy}
                disabled={actionDisabled}
                onClick={() => onAction(id)}
              >
                <span className="scrcpy-control-label">{labelFor(id)}</span>
              </Button>
            </div>
          );
        })}
      </div>
      <span className="scrcpy-control-hint">{t("detail.control.quickBarHint")}</span>
    </div>
  );
}
