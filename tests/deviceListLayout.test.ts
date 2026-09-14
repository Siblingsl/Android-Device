import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("device center session strip layout", () => {
  it("uses a compact session strip with an expandable device row", () => {
    const page = read("src/pages/Devices.tsx");

    expect(page).toMatch(/className="[^"]*device-session-strip[^"]*"/);
    expect(page).toContain("device-session-row");
    expect(page).toMatch(/className="[^"]*device-session-pulse[^"]*"/);
    expect(page).toMatch(/className="[^"]*device-session-details[^"]*"/);
    expect(page).toMatch(/className="[^"]*device-session-actions[^"]*"/);
    expect(page).not.toContain("<table className=\"table devices-table device-runtime-rail-table\">");
  });

  it("keeps list scrolling inside the session strip", () => {
    const stylesheet = read("src/styles/global.css");

    expect(stylesheet).toMatch(/\.device-session-strip\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
    expect(stylesheet).toMatch(/\.device-session-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(stylesheet).toMatch(/\.device-session-main\s*\{[^}]*display:\s*grid;/s);
    expect(stylesheet).toMatch(/\.device-session-pulse\s*\{[^}]*display:\s*flex;/s);
  });

  it("uses translated labels for the session strip", () => {
    const dictionary = read("src/i18n/pages/devices.ts");

    for (const key of [
      '"devices.table.status"',
      '"devices.table.services"',
      '"devices.view.table"',
      '"devices.view.cards"',
      '"devices.layout.title"',
    ]) {
      expect(dictionary).toContain(key);
    }
  });
});
