// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { COPILOT_HISTORY_STORAGE_KEY, readCopilotHistory, writeCopilotHistory } from "./copilotHistory";

describe("copilot history", () => {
  afterEach(() => localStorage.clear());

  it("persists only safe conversation protocol fields", () => {
    writeCopilotHistory([
      { role: "user", content: "查看设备", name: "secret-name", tool_call_id: "secret-call" },
      { role: "assistant", content: "结果" },
    ]);

    expect(JSON.parse(localStorage.getItem(COPILOT_HISTORY_STORAGE_KEY) || "[]")).toEqual([
      { role: "user", content: "查看设备" },
      { role: "assistant", content: "结果" },
    ]);
    expect(readCopilotHistory()).toEqual([
      { role: "user", content: "查看设备" },
      { role: "assistant", content: "结果" },
    ]);
  });

  it("falls back to an empty history for malformed storage", () => {
    localStorage.setItem(COPILOT_HISTORY_STORAGE_KEY, "not-json");
    expect(readCopilotHistory()).toEqual([]);
  });
});
