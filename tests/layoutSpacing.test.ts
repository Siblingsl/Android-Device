import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

describe("settings and ADB page module rhythm", () => {
  it("keeps page modules separated and prevents flex compression", () => {
    expect(stylesheet).toMatch(
      /\.page-settings \.page-fade > div,\s*\.page-adb \.page-fade > div \{[^}]*gap:\s*8px;/s,
    );
    expect(stylesheet).toMatch(
      /\.page-settings \.page-fade > div > \.module:not\(\.auto-start-card\),[\s\S]*?\{[^}]*flex:\s*0 0 auto;/s,
    );
    expect(stylesheet).toMatch(
      /\.page-adb \.page-fade > div \{[^}]*overflow-y:\s*auto;/s,
    );
  });
});
