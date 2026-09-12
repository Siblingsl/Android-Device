import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("topbar navigation placement", () => {
  it("keeps primary navigation beside settings with a dedicated divider", () => {
    const sidebar = read("src/components/layout/Sidebar.tsx");
    const toolsStart = sidebar.indexOf('<div className="topbar-tools">');
    const navStart = sidebar.indexOf('<nav className="nav"', toolsStart);
    const dividerStart = sidebar.indexOf('<span className="topbar-divider"', navStart);
    const actionsStart = sidebar.indexOf('<div className="topbar-actions">', dividerStart);

    expect(toolsStart).toBeGreaterThanOrEqual(0);
    expect(navStart).toBeGreaterThan(toolsStart);
    expect(dividerStart).toBeGreaterThan(navStart);
    expect(actionsStart).toBeGreaterThan(dividerStart);
  });

  it("anchors the navigation group to the right without moving the brand", () => {
    const stylesheet = read("src/styles/global.css");

    expect(stylesheet).toMatch(/\.topbar-tools\s*\{[^}]*margin-left:\s*auto;/s);
    expect(stylesheet).toMatch(/\.topbar-divider\s*\{[^}]*width:\s*1px;[^}]*height:\s*22px;/s);
    expect(stylesheet).toMatch(/\.nav\s*\{[^}]*flex:\s*0 1 auto;/s);
  });
});
