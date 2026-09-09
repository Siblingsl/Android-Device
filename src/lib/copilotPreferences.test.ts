// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  COPILOT_PREFERENCES_STORAGE_KEY,
  DEFAULT_COPILOT_PREFERENCES,
  readCopilotPreferences,
  writeCopilotPreferences,
} from "./copilotPreferences";

describe("copilot preferences", () => {
  beforeEach(() => localStorage.clear());

  it("uses safe defaults when no preferences exist", () => {
    expect(readCopilotPreferences()).toEqual(DEFAULT_COPILOT_PREFERENCES);
  });

  it("persists non-secret provider and execution settings with bounds", () => {
    writeCopilotPreferences({
      ...DEFAULT_COPILOT_PREFERENCES,
      endpoint: " https://example.test/v1/ ",
      model: " demo ",
      targetSerial: " serial-1 ",
      maxSteps: 999,
      timeoutMs: 100,
      totalTimeoutMs: 999_999,
    });

    expect(readCopilotPreferences()).toMatchObject({
      endpoint: "https://example.test/v1/",
      model: "demo",
      targetSerial: "serial-1",
      maxSteps: 32,
      timeoutMs: 1_000,
      totalTimeoutMs: 600_000,
    });
    expect(localStorage.getItem(COPILOT_PREFERENCES_STORAGE_KEY)).not.toContain("apiKey");
  });
});
