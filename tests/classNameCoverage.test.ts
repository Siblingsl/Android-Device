import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

const DEVICE_COMPONENTS = [
  "AgentPanel",
  "AutomationPanel",
  "DeviceBroadcastInput",
  "DeviceControlBar",
  "DeviceControlPanel",
  "DeviceHealthPanel",
  "DeviceHoverCard",
  "DeviceInputModes",
  "DeviceMediaControls",
  "DeviceMetadataPanel",
  "DevicePreview",
  "DeviceShell",
  "DeviceStream",
  "FileExplorer",
  "GnirehtetPanel",
  "GroupControlPanel",
  "InteractiveTerminal",
  "KeyboardMappingPanel",
  "QuickAppLauncher",
  "RecordingPanel",
  "ScrcpyControlBar",
  "ScrcpyOptionsPanel",
  "ScrcpyPreferences",
].map((name) => `src/components/device/${name}.tsx`);

const TARGETS = ["src/pages/DeviceDetail.tsx", ...DEVICE_COMPONENTS];

const CLASS_TOKEN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Collect every statically-determinable class token from className attributes:
 * plain strings, template literals (with `${...}` segments stripped), and
 * string literals inside brace expressions.
 */
function extractClassTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  const push = (fragment: string) => {
    for (const raw of fragment.split(/\s+/)) {
      const token = raw.trim();
      if (token && CLASS_TOKEN.test(token)) tokens.add(token);
    }
  };

  for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) push(match[1]);
  for (const match of source.matchAll(/className\s*=\s*'([^']*)'/g)) push(match[1]);
  for (const match of source.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) {
    push(match[1].replace(/\$\{[^}]*\}/g, " "));
  }
  for (const match of source.matchAll(/className\s*=\s*\{([^}]*)\}/g)) {
    const expression = match[1];
    if (expression.includes("`")) continue; // template literals are handled above
    for (const inner of expression.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const literal = inner[1] ?? inner[2];
      if (literal != null) push(literal);
    }
  }
  return tokens;
}

/**
 * Class-name-looking literals that are values in ternary/comparison expressions
 * rather than real CSS classes, plus dynamic prefixes whose suffix is supplied
 * at runtime (e.g. `agent-session-${status}`, `depth-${n}`).
 */
const ALLOWLIST = new Set(["otg", "agent-session-", "depth-"]);

function isDefinedInCss(css: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?=[\\s:{.,>)#\\[~]|$])`).test(css);
}

describe("device detail className coverage", () => {
  it("defines every static class name in global.css", () => {
    const css = read("src/styles/global.css");
    const failures: string[] = [];
    for (const target of TARGETS) {
      for (const token of extractClassTokens(read(target))) {
        if (ALLOWLIST.has(token)) continue;
        if (!isDefinedInCss(css, token)) failures.push(`${target}: .${token}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
