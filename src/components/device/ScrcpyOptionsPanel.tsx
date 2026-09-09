import { SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  mergeScrcpyOptions,
  parseScrcpyOptions,
  type ScrcpyVisualOptions,
  type ScrcpyWindowMode,
} from "../../lib/scrcpyOptions";

interface ScrcpyOptionsPanelProps {
  args: string;
  disabled?: boolean;
  onChange: (args: string) => void;
}

const SIZE_PRESETS = [720, 1080, 1440, 2160] as const;
const BIT_RATE_PRESETS = [2, 4, 8, 16, 32] as const;
const FPS_PRESETS = [30, 60, 90, 120] as const;

function selectValue(value: number, presets: readonly number[]): string {
  return presets.includes(value) ? String(value) : "custom";
}

export function ScrcpyOptionsPanel({ args, disabled = false, onChange }: ScrcpyOptionsPanelProps) {
  const { t } = useI18n();
  const options = parseScrcpyOptions(args);
  const sizeValue = selectValue(options.maxSize, SIZE_PRESETS);
  const bitRateValue = selectValue(options.bitRate, BIT_RATE_PRESETS);
  const fpsValue = options.maxFps === null ? "auto" : selectValue(options.maxFps, FPS_PRESETS);

  const update = (patch: Partial<ScrcpyVisualOptions>) => {
    onChange(mergeScrcpyOptions(args, { ...options, ...patch }));
  };

  return (
    <details className="scrcpy-options-details">
      <summary>
        <SlidersHorizontal size={13} />
        {t("detail.settings.visualOptions")}
      </summary>
      <div className="scrcpy-options-panel">
        <label>
          {t("detail.settings.maxSize")}
          <select
            aria-label={t("detail.settings.maxSize")}
            value={sizeValue}
            onChange={(event) => {
              if (event.target.value !== "custom") update({ maxSize: Number(event.target.value) });
            }}
            disabled={disabled}
          >
            {SIZE_PRESETS.map((value) => <option key={value} value={value}>{value}p</option>)}
            {sizeValue === "custom" && <option value="custom">{options.maxSize}p</option>}
          </select>
        </label>
        <label>
          {t("detail.settings.bitRate")}
          <select
            aria-label={t("detail.settings.bitRate")}
            value={bitRateValue}
            onChange={(event) => {
              if (event.target.value !== "custom") update({ bitRate: Number(event.target.value) });
            }}
            disabled={disabled}
          >
            {BIT_RATE_PRESETS.map((value) => <option key={value} value={value}>{value}M</option>)}
            {bitRateValue === "custom" && <option value="custom">{options.bitRate}M</option>}
          </select>
        </label>
        <label>
          {t("detail.settings.maxFps")}
          <select
            aria-label={t("detail.settings.maxFps")}
            value={fpsValue}
            onChange={(event) => update({ maxFps: event.target.value === "auto" || event.target.value === "custom" ? options.maxFps : Number(event.target.value) })}
            disabled={disabled}
          >
            <option value="auto">{t("detail.settings.fpsAuto")}</option>
            {FPS_PRESETS.map((value) => <option key={value} value={value}>{value} fps</option>)}
            {fpsValue === "custom" && <option value="custom">{options.maxFps} fps</option>}
          </select>
        </label>
        <label>
          {t("detail.settings.windowMode")}
          <select
            aria-label={t("detail.settings.windowMode")}
            value={options.windowMode}
            onChange={(event) => update({ windowMode: event.target.value as ScrcpyWindowMode })}
            disabled={disabled}
          >
            <option value="normal">{t("detail.settings.windowNormal")}</option>
            <option value="borderless">{t("detail.settings.windowBorderless")}</option>
            <option value="fullscreen">{t("detail.settings.windowFullscreen")}</option>
          </select>
        </label>
        <label className="scrcpy-options-check">
          <input type="checkbox" checked={options.alwaysOnTop} onChange={(event) => update({ alwaysOnTop: event.target.checked })} disabled={disabled} />
          {t("detail.settings.alwaysOnTop")}
        </label>
        <label className="scrcpy-options-check">
          <input type="checkbox" checked={options.control} onChange={(event) => update({ control: event.target.checked })} disabled={disabled} />
          {t("detail.settings.allowControl")}
        </label>
        <label className="scrcpy-options-check">
          <input type="checkbox" checked={options.audio} onChange={(event) => update({ audio: event.target.checked })} disabled={disabled} />
          {t("detail.settings.enableAudio")}
        </label>
      </div>
    </details>
  );
}
