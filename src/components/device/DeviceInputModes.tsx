import { useEffect, useState } from "react";
import { Gamepad2, Keyboard, Mouse, Usb } from "lucide-react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";
import { DEFAULT_OTG_OPTIONS, DEFAULT_UHID_OPTIONS, normalizeInputOptions } from "../../lib/scrcpyInput";
import type { ScrcpyInputMode, ScrcpyInputOptions } from "../../types";

interface DeviceInputModesProps {
  disabled?: boolean;
  busy?: string | null;
  onStart: (mode: ScrcpyInputMode, options: ScrcpyInputOptions) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  onStatus?: () => Promise<string>;
}

export function DeviceInputModes({
  disabled = false,
  busy = null,
  onStart,
  onStop,
  onStatus,
}: DeviceInputModesProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ScrcpyInputMode>("uhid");
  const [options, setOptions] = useState<ScrcpyInputOptions>(DEFAULT_UHID_OPTIONS);
  const [active, setActive] = useState(false);
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const blocked = disabled || Boolean(busy) || Boolean(localBusy);

  useEffect(() => {
    if (!active || !onStatus) return;
    const timer = window.setInterval(() => {
      void onStatus().then((status) => {
        if (status !== "running") setActive(false);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [active, onStatus]);

  const selectMode = (next: ScrcpyInputMode) => {
    setMode(next);
    setOptions(next === "otg" ? { ...DEFAULT_OTG_OPTIONS, keyboard: options.keyboard, mouse: options.mouse } : { ...DEFAULT_UHID_OPTIONS, keyboard: options.keyboard, mouse: options.mouse });
  };

  const start = async () => {
    if (blocked || active) return;
    setLocalBusy("start");
    try {
      if (await onStart(mode, normalizeInputOptions(mode, options))) setActive(true);
    } finally {
      setLocalBusy(null);
    }
  };

  const stop = async () => {
    if (blocked || !active) return;
    setLocalBusy("stop");
    try {
      if (await onStop()) setActive(false);
    } finally {
      setLocalBusy(null);
    }
  };

  const update = (patch: Partial<ScrcpyInputOptions>) => setOptions((current) => ({ ...current, ...patch }));

  return (
    <Card title={t("detail.input.title")} padding>
      <div className="input-mode-toolbar">
        <div className="input-mode-heading"><Keyboard size={14} />{t("detail.input.heading")}</div>
        <select aria-label={t("detail.input.mode")} value={mode} onChange={(event) => selectMode(event.target.value as ScrcpyInputMode)} disabled={blocked || active}>
          <option value="uhid">UHID · USB / TCP</option>
          <option value="otg">OTG · USB</option>
        </select>
        <Button size="sm" variant={active ? "danger" : "primary"} loading={localBusy !== null} disabled={blocked} icon={active ? <Usb size={13} /> : <Keyboard size={13} />} onClick={() => void (active ? stop() : start())}>
          {active ? t("detail.input.stop") : t("detail.input.start")}
        </Button>
        {active && <span className="media-control-live">{t("detail.input.active")}</span>}
      </div>
      <div className="input-mode-options">
        <label><input type="checkbox" checked={options.keyboard} onChange={(event) => update({ keyboard: event.target.checked })} disabled={blocked || active} /><Keyboard size={12} />{t("detail.input.keyboard")}</label>
        <label><input type="checkbox" checked={options.mouse} onChange={(event) => update({ mouse: event.target.checked })} disabled={blocked || active} /><Mouse size={12} />{t("detail.input.mouse")}</label>
        <label className={mode === "otg" ? "" : "is-muted"}><input type="checkbox" checked={options.gamepad} onChange={(event) => update({ gamepad: event.target.checked })} disabled={blocked || active || mode !== "otg"} /><Gamepad2 size={12} />{t("detail.input.gamepad")}</label>
      </div>
      <div className="muted input-mode-hint">{t(mode === "otg" ? "detail.input.otgHint" : "detail.input.uhidHint")}</div>
    </Card>
  );
}
