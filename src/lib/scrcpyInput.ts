import type { ScrcpyInputMode, ScrcpyInputOptions } from "../types";

export const DEFAULT_UHID_OPTIONS: ScrcpyInputOptions = {
  keyboard: true,
  mouse: true,
  gamepad: false,
};

export const DEFAULT_OTG_OPTIONS: ScrcpyInputOptions = {
  keyboard: true,
  mouse: true,
  gamepad: false,
};

export function normalizeInputOptions(
  mode: ScrcpyInputMode,
  input: Partial<ScrcpyInputOptions> = {},
): ScrcpyInputOptions {
  return {
    keyboard: input.keyboard !== false,
    mouse: input.mouse !== false,
    // OTG gamepad support is explicit in scrcpy; never enable it by accident.
    gamepad: mode === "otg" && input.gamepad === true,
  };
}

export function inputModeArgs(
  mode: ScrcpyInputMode,
  options: ScrcpyInputOptions,
): string[] {
  const normalized = normalizeInputOptions(mode, options);
  if (mode === "otg") {
    return [
      "--otg",
      `--keyboard=${normalized.keyboard ? "aoa" : "disabled"}`,
      `--mouse=${normalized.mouse ? "aoa" : "disabled"}`,
      ...(normalized.gamepad ? ["--gamepad=aoa"] : []),
    ];
  }
  return [
    "--no-video",
    "--no-audio",
    `--keyboard=${normalized.keyboard ? "uhid" : "disabled"}`,
    `--mouse=${normalized.mouse ? "uhid" : "disabled"}`,
  ];
}
