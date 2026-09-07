import { useState } from "react";
import { Camera, Clipboard, Home, Keyboard } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { validateDeviceText } from "../../lib/deviceInput";
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
  busy?: boolean;
  onAction: (action: DeviceControlAction, value?: string | boolean) => void;
  onScreenshot: () => void;
  onValidationError: (message: string) => void;
}

export function DeviceControlPanel({
  disabled = false,
  busy = false,
  onAction,
  onScreenshot,
  onValidationError,
}: DeviceControlPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [clipboard, setClipboard] = useState("");
  const [landscape, setLandscape] = useState(true);
  const controlDisabled = disabled || busy;

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
        <Button disabled={controlDisabled} onClick={() => onAction("home")} icon={<Home size={14} />}>
          HOME
        </Button>
        <Button disabled={controlDisabled} onClick={() => onAction("back")}>BACK</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("recent")}>RECENT</Button>
      </div>

      <div className="control-section-label">{t("detail.control.group.device")}</div>
      <div className="control-group">
        <Button disabled={controlDisabled} onClick={() => onAction("wake")}>{t("detail.control.wake")}</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("lock")}>{t("detail.control.lock")}</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("power")}>POWER</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("volup")}>{t("detail.control.volUp")}</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("voldown")}>{t("detail.control.volDown")}</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("notify")}>{t("detail.control.notify")}</Button>
        <Button disabled={controlDisabled} onClick={() => onAction("settings")}>{t("detail.control.settings")}</Button>
      </div>

      <div className="control-section-label">{t("detail.control.group.display")}</div>
      <div className="control-group">
        <Button disabled={controlDisabled} onClick={onScreenshot} icon={<Camera size={14} />}>
          {t("detail.control.screenshot")}
        </Button>
        <Button
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
