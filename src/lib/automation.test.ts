// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_STORAGE_KEY,
  createAutomationScript,
  defaultAutomationScript,
  parseAutomationScript,
  readAutomationScripts,
  serializeAutomationScript,
  writeAutomationScripts,
} from "./automation";

describe("automation script storage", () => {
  afterEach(() => localStorage.clear());

  it("creates a usable starter script with the supported step vocabulary", () => {
    const script = defaultAutomationScript();

    expect(script.name).toBeTruthy();
    expect(script.enabled).toBe(true);
    expect(script.steps.map((step) => step.kind)).toEqual(["wait", "screenshot"]);
    expect(script.variables).toEqual({});
  });

  it("normalizes duplicate or missing step ids before persisting", () => {
    const script = createAutomationScript({
      id: "demo",
      name: "演示流程",
      steps: [
        { id: "same", kind: "tap", label: "点按", enabled: true, params: { x: 10, y: 20 } },
        { id: "same", kind: "wait", label: "等待", enabled: true, params: { milliseconds: 100 } },
        { id: "", kind: "shell", label: "命令", enabled: true, params: { command: "echo ok" } },
      ],
    });

    expect(script.steps.map((step) => step.id)).toEqual(["same", "step-2", "step-3"]);
    expect(script.updatedAt).toBeTruthy();
  });

  it("returns a safe empty list when storage is damaged", () => {
    localStorage.setItem(AUTOMATION_STORAGE_KEY, "not-json");
    expect(readAutomationScripts()).toEqual([]);
  });

  it("round-trips scripts through local persistence", () => {
    const script = defaultAutomationScript();
    writeAutomationScripts([script]);

    expect(readAutomationScripts()).toEqual([script]);
  });

  it("serializes and safely parses one importable JSON script", () => {
    const script = defaultAutomationScript();
    const imported = parseAutomationScript(serializeAutomationScript(script));

    expect(imported).toEqual(script);
    expect(parseAutomationScript("{\"name\":\"bad\"}")).toBeNull();
  });
});
