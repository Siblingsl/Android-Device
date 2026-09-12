import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SettingsPage hook ordering", () => {
  it("declares the stale metadata memo before the loading early return", () => {
    const source = readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
    const memoIndex = source.indexOf("const staleMetadata = useMemo(");
    const loadingReturnIndex = source.indexOf("if (!form) {");

    expect(memoIndex).toBeGreaterThanOrEqual(0);
    expect(loadingReturnIndex).toBeGreaterThanOrEqual(0);
    expect(memoIndex).toBeLessThan(loadingReturnIndex);
  });
});
