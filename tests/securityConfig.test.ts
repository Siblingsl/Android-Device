import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri security policy", () => {
  it("defines a restrictive content security policy", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app?: { security?: { csp?: unknown; devCsp?: unknown } } };
    const csp = config.app?.security?.csp;
    const devCsp = config.app?.security?.devCsp;

    expect(typeof csp).toBe("string");
    expect(typeof devCsp).toBe("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).not.toContain("127.0.0.1:1420");
    expect(devCsp).toContain("127.0.0.1:1420");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
