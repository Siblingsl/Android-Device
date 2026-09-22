import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Just Run application branding", () => {
  test("uses Just Run for user-visible application surfaces", () => {
    expect(read("index.html")).toContain("<title>Just Run</title>");
    expect(read("index.html")).toContain('href="/just-run-logo.png"');
    expect(read("src-tauri/tauri.conf.json")).toContain('"productName": "Just Run"');
    expect(read("src-tauri/tauri.conf.json")).toContain('"title": "Just Run"');
    expect(read("src/components/layout/Sidebar.tsx")).toContain('src="/just-run-logo.png"');
    expect(read("src/components/layout/Sidebar.tsx")).toContain('className="brand-title">Just Run');
    expect(read("src/i18n/pages/common.ts")).toContain('"common.appName": "Just Run"');
    expect(read("src/lib/dialogs.ts")).toContain('title: "Just Run"');
    expect(read("src/pages/Settings.tsx")).toContain("<strong>Just Run</strong>");
  });
});
