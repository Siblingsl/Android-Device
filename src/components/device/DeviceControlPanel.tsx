import { useState } from "react";
import { Camera, Clipboard, Home, Keyboard } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { validateDeviceText } from "../../lib/deviceInput";
import { controlBusyState, type ControlBusyAction } from "../../lib/controlBusy";
import type { ControlFeedback } from "../../lib/controlFeedback";
import { useI18n } from "../../i18n";

export type DeviceControlAction =
  | "home"
  | "back"
  | "recent"
  | "power"
  | "volup"
  | "voldown"
  | "lock"
  | "wake"
  | "rotate"
  | "notify"
  | "settings"
  | "text"
  | "clipboard";

interface DeviceControlPanelProps {
  disabled?: boolean;
  busyAction?: ControlBusyAction | null;
  feedback?: ControlFeedback[];
  retryingFeedbackId?: number | null;
  onRetryFeedback?: (feedback: ControlFeedback) => void;
  onAction: (action: DeviceControlAction, value?: string | boolean) => void;
  onScreenshot: () => void;
  onValidationError: (message: string) => void;
}

export function DeviceControlPanel({
  disabled = false,
  busyAction = null,
  feedback = [],
  retryingFeedbackId = null,
  onRetryFeedback,
  onAction,
  onScreenshot,
  onValidationError,
}: DeviceControlPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [clipboard, setClipboard] = useState("");
  const [landscape, setLandscape] = useState(true);
  const controlDisabled = disabled || controlBusyState(busyAction, "home").disabled;

  const sendText = (kind: "text" | "clipboard", value: string, emptyMessage: string) => {
    const error = validateDeviceText(value, emptyMessage);
    if (error) {
      onValidationError(error);
      return;
    }
    onAction(kind, value);
  };

  return (
    <Card title={t("detail.control.panelTitle")} padding>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {t("detail.control.panelHint")}
      </div>
      {feedback.length > 0 && (
        <div className="control-feedback">
          <div className="row-between">
            <div className="muted" style={{ fontSize: 12 }}>{t("detail.control.recentActions")}</div>
            <span className="muted" style={{ fontSize: 11 }}>{feedback.length}</span>
          </div>
          <div className="control-feedback-list">
            {feedback.map((item) => (
              <div key={item.id} className={`control-feedback-item ${item.status}`}>
                <div className="row-between">
                  <div className="row" style={{ gap: 6 }}>
                    <span className={`badge ${item.status === "success" ? "success" : "danger"}`}>
                      {t(item.status === "success" ? "detail.control.feedbackSuccess" : "detail.control.feedbackError")}
                    </span>
                    <span>{item.action}</span>
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>{new Date(item.at).toLocaleTimeString()}</span>
                </div>
                <div className="control-feedback-message muted" title={item.message}>{item.message}</div>
                {item.status === "error" && item.retryable && item.retry && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={retryingFeedbackId === item.id}
                    disabled={controlDisabled}
                    onClick={() => onRetryFeedback?.(item)}
                    style={{ marginTop: 6 }}
                  >
                    {t("detail.control.retry")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="control-section-label">{t("detail.control.group.navigation")}</div>
      <div className="control-group">
        <Button loading={controlBusyState(busyAction, "home").loading} disabled={controlDisabled} onClick={() => onAction("home")} icon={<Home size={14} />}>
          HOME
        </Button>
        <Button loading={controlBusyState(busyAction, "back").loading} disabled={controlDisabled} onClick={() => onAction("back")}>BACK</Button>
        <Button loading={controlBusyState(busyAction, "recent").loading} disabled={controlDisabled} onClick={() => onAction("recent")}>RECENT</Button>
      </div>

      <div className="control-section-label">{t("detail.control.group.device")}</div>
      <div className="control-group">
        <Button loading={controlBusyState(busyAction, "wake").loading} disabled={controlDisabled} onClick={() => onAction("wake")}>{t("detail.control.wake")}</Button>
        <Button loading={controlBusyState(busyAction, "lock").loading} disabled={controlDisabled} onClick={() => onAction("lock")}>{t("detail.control.lock")}</Button>
        <Button loading={controlBusyState(busyAction, "power").loading} disabled={controlDisabled} onClick={() => onAction("power")}>POWER</Button>
        <Button loading={controlBusyState(busyAction, "volup").loading} disabled={controlDisabled} onClick={() => onAction("volup")}>{t("detail.control.volUp")}</Button>
        <Button loading={controlBusyState(busyAction, "voldown").loading} disabled={controlDisabled} onClick={() => onAction("voldown")}>{t("detail.control.volDown")}</Button>
        <Button loading={controlBusyState(busyAction, "notify").loading} disabled={controlDisabled} onClick={() => onAction("notify")}>{t("detail.control.notify")}</Button>
        <Button loading={controlBusyState(busyAction, "settings").loading} disabled={controlDisabled} onClick={() => onAction("settings")}>{t("detail.control.settings")}</Button>
      </div>

      <div className="control-section-label">{t("detail.control.group.display")}</div>
      <div className="control-group">
        <Button loading={controlBusyState(busyAction, "screenshot").loading} disabled={controlDisabled} onClick={onScreenshot} icon={<Camera size={14} />}>
          {t("detail.control.screenshot")}
        </Button>
        <Button
          loading={controlBusyState(busyAction, "rotate").loading}
          disabled={controlDisabled}
          onClick={() => {
            const next = !landscape;
            setLandscape(next);
            onAction("rotate", next);
          }}
        >
          {landscape ? t("detail.control.rotateLandscape") : t("detail.control.rotatePortrait")}
        </Button>
      </div>

      <div className="control-section-label">{t("detail.control.group.input")}</div>
      <div className="field">
        <label>{t("detail.control.inputText")}</label>
        <div className="row">
          <input
            style={{ flex: 1 }}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("detail.control.inputPlaceholder")}
            disabled={controlDisabled}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                sendText("text", text, t("detail.control.inputRequired"));
              }
            }}
          />
          <Button
            loading={controlBusyState(busyAction, "text").loading}
            disabled={controlDisabled}
            icon={<Keyboard size={14} />}
            onClick={() => sendText("text", text, t("detail.control.inputRequired"))}
          >
            {t("detail.control.send")}
          </Button>
        </div>
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label>{t("detail.control.sendClipboard")}</label>
        <div className="row">
          <input
            style={{ flex: 1 }}
            value={clipboard}
            onChange={(event) => setClipboard(event.target.value)}
            placeholder={t("detail.control.inputPlaceholder")}
            disabled={controlDisabled}
          />
          <Button
            loading={controlBusyState(busyAction, "clipboard").loading}
            disabled={controlDisabled}
            icon={<Clipboard size={14} />}
            onClick={() => sendText("clipboard", clipboard, t("detail.control.clipboardRequired"))}
          >
            {t("detail.control.send")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
