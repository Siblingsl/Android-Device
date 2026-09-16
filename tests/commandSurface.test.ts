import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const rendererSources = [
  readFileSync(resolve(root, "src/services/deviceService.ts"), "utf8"),
  readFileSync(resolve(root, "src/services/terminalSessionService.ts"), "utf8"),
];
const rustEntry = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
const rustCommands = readFileSync(resolve(root, "src-tauri/src/commands/mod.rs"), "utf8");

function invokedCommands(source: string): string[] {
  return [...source.matchAll(/invoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((command): command is string => Boolean(command));
}

function registeredCommands(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^\s{12}([a-z][a-z0-9_]*)\s*,/gm)]
      .map((match) => match[1])
      .filter((command): command is string => Boolean(command)),
  );
}

describe("renderer/native command surface", () => {
  it("defines and registers every static renderer invoke", () => {
    const registered = registeredCommands(rustEntry);
    const defined = new Set(
      [...rustCommands.matchAll(/pub\s+(?:async\s+)?fn\s+([a-z][a-z0-9_]*)\s*\(/g)].map((match) => match[1]),
    );
    const invoked = [...new Set(rendererSources.flatMap(invokedCommands))];
    const missing = invoked.filter((command) => !registered.has(command) || !defined.has(command));
    expect(missing).toEqual([]);
  });
});
