import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("device center registry layout", () => {
  it("uses a flat ledger header and a status spine for each device", () => {
    const page = read("src/pages/Devices.tsx");

    expect(page).toContain('className="device-list-table-head"');
    expect(page).toContain('className="device-list-row-status"');
    expect(page).toContain('className="device-list-bulk-actions"');
    expect(page).not.toContain('className="device-list-overview"');
    expect(page).not.toContain('className="device-list-expand"');
  });

  it("keeps list scrolling inside the registry module", () => {
    const stylesheet = read("src/styles/global.css");

    expect(stylesheet).toMatch(/\.device-list-module\s*\{[^}]*overflow:\s*hidden;/s);
    expect(stylesheet).toMatch(/\.device-list-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(stylesheet).toMatch(/\.device-list-row-status\s*\{[^}]*width:\s*3px;[^}]*background:/s);
    expect(stylesheet).toMatch(/\.device-list-table-head\s*\{[^}]*border-bottom:\s*1px solid var\(--line\);/s);
  });
});
