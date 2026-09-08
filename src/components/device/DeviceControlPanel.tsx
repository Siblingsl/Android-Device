import { useState } from "react";
import { Camera, Clipboard, Home, Keyboard } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { validateDeviceText } from "../../lib/deviceInput";
import { controlBusyState, type ControlBusyAction } from "../../lib/controlBusy";
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
  onAction: (action: DeviceControlAction, value?: string | boolean) => void;
  onScreenshot: () => void;
  onValidationError: (message: string) => void;
}

export function DeviceControlPanel({
  disabled = false,
  busyAction = null,
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
