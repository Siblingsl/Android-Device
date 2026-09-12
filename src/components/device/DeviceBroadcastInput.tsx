import { useState } from "react";
import { Home, Keyboard, Send } from "lucide-react";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";

interface DeviceBroadcastInputProps {
  disabled?: boolean;
  busy?: string | null;
  onText: (text: string) => Promise<boolean>;
  onKey: (code: number) => Promise<boolean>;
}

const broadcastKeys = [
  { key: "home", code: 3, label: "devices.broadcast.home" },
  { key: "back", code: 4, label: "devices.broadcast.back" },
  { key: "recent", code: 187, label: "devices.broadcast.recent" },
] as const;

export function DeviceBroadcastInput({
  disabled = false,
  busy = null,
  onText,
  onKey,
}: DeviceBroadcastInputProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const blocked = disabled || Boolean(busy) || Boolean(localBusy);

  const sendText = async () => {
    const value = text.trim();
    if (!value || blocked) return;
    setLocalBusy("text");
    try {
      if (await onText(value)) setText("");
    } finally {
      setLocalBusy(null);
    }
  };

  const sendKey = async (key: (typeof broadcastKeys)[number]) => {
    if (blocked) return;
    setLocalBusy(key.key);
    try {
      await onKey(key.code);
    } finally {
      setLocalBusy(null);
    }
  };

  return (
    <details className="batch-broadcast-details">
      <summary>
        <Keyboard size={13} />
        {t("devices.broadcast.title")}
      </summary>
      <div className="batch-broadcast-panel">
        <div className="batch-broadcast-text">
          <input
            aria-label={t("devices.broadcast.textLabel")}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void sendText();
            }}
            placeholder={t("devices.broadcast.placeholder")}
            disabled={blocked}
          />
          <Button
            size="sm"
            icon={<Send size={12} />}
            loading={localBusy === "text"}
            disabled={blocked || !text.trim()}
            onClick={() => void sendText()}
          >
            {t("devices.broadcast.sendText")}
          </Button>
        </div>
        <div className="batch-broadcast-keys">
          <span className="muted">{t("devices.broadcast.keyLabel")}</span>
          {broadcastKeys.map((key) => (
            <Button
              key={key.key}
              size="sm"
              variant="ghost"
              icon={key.key === "home" ? <Home size={12} /> : undefined}
              loading={localBusy === key.key}
              disabled={blocked}
              onClick={() => void sendKey(key)}
            >
              {t(key.label)}
            </Button>
          ))}
        </div>
      </div>
    </details>
  );
}
