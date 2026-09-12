import { describe, expect, it } from "vitest";
import { appendAutomationStep, createAutomationScript, interpolate, moveAutomationStepTree, normalizeAutomationScript, normalizeAutomationStep, removeAutomationStepTree, updateAutomationStepTree, validateAutomationScript } from "../src/lib/automation";

describe("automation", () => {
  it("normalizes and validates device automation steps", () => {
    const script = createAutomationScript();
    script.steps = [normalizeAutomationStep({ kind: "text", text: "hello" }), normalizeAutomationStep({ kind: "shell", command: "id" })];
    expect(validateAutomationScript(script)).toEqual([]);
    expect(normalizeAutomationStep({ x: -1 }).x).toBe(0);
  });

  it("reports missing inputs and interpolates variables", () => {
    const script = createAutomationScript();
    script.steps = [normalizeAutomationStep({ kind: "condition" }), normalizeAutomationStep({ kind: "repeat" })];
    expect(validateAutomationScript(script)).toHaveLength(2);
    expect(interpolate("adb {{serial}}", { serial: "emulator-5554" })).toBe("adb emulator-5554");
  });

  it("normalizes random coordinate offsets and validates image crop dimensions", () => {
    const step = normalizeAutomationStep({ kind: "image-match", templateData: "data:image/png;base64,AA==", cropWidth: 200 });
    expect(step.randomOffsetX).toBe(0);
    expect(validateAutomationScript({ ...createAutomationScript(), steps: [step] })[0]).toContain("宽和高");
  });

  it("keeps user variables while normalizing imported scripts", () => {
    const script = normalizeAutomationScript({ name: "登录", variables: { user: "alice", ignored: 42 } });
    expect(script.variables).toEqual({ user: "alice" });
    expect(interpolate("{{user}}/{{missing}}", script.variables)).toBe("alice/");
  });

  it("updates nested repeat steps without changing sibling steps", () => {
    const repeat = normalizeAutomationStep({ id: "repeat", kind: "repeat", children: [normalizeAutomationStep({ id: "child", kind: "tap" })] });
    const sibling = normalizeAutomationStep({ id: "sibling", kind: "wait" });
    const steps = [repeat, sibling];
    const updated = updateAutomationStepTree(steps, "child", { x: 321, y: 654 });
    expect(updated[0].children[0].x).toBe(321);
    expect(updated[0].children[0].y).toBe(654);
    expect(updated[1]).toEqual(sibling);
  });

  it("adds, reorders, and removes nested steps", () => {
    const repeat = normalizeAutomationStep({ id: "repeat", kind: "repeat" });
    const first = normalizeAutomationStep({ id: "first", kind: "tap" });
    const second = normalizeAutomationStep({ id: "second", kind: "wait" });
    const withChildren = appendAutomationStep([repeat], "repeat", first);
    const withMoreChildren = appendAutomationStep(withChildren, "repeat", second);
    const reordered = moveAutomationStepTree(withMoreChildren, "second", -1);
    expect(reordered[0].children.map((step) => step.id)).toEqual(["second", "first"]);
    expect(removeAutomationStepTree(reordered, "second")[0].children.map((step) => step.id)).toEqual(["first"]);
  });
});
