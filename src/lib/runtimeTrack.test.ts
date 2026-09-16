import { describe, expect, it } from "vitest";
import {
  FALLBACK_RUNTIME_TRACK,
  RUNTIME_ROUTE,
  normalizeRuntimeTrack,
  resolveRuntimeLink,
  resolveRuntimeTrack,
} from "./runtimeTrack";

describe("resolveRuntimeTrack (spec §6.1 priority)", () => {
  it("lets ?track= win over the remembered choice", () => {
    expect(resolveRuntimeTrack("qemu", "docker")).toBe("qemu");
    expect(resolveRuntimeTrack("docker", "qemu")).toBe("docker");
  });

  it("falls back to the remembered choice, then to docker", () => {
    expect(resolveRuntimeTrack(null, "qemu")).toBe("qemu");
    expect(resolveRuntimeTrack(null, "podman")).toBe(FALLBACK_RUNTIME_TRACK);
    expect(resolveRuntimeTrack(null, null)).toBe(FALLBACK_RUNTIME_TRACK);
    expect(normalizeRuntimeTrack("podman")).toBeNull();
  });
});

/**
 * P4: in-app clicks go straight to the merged route. The one navigation target
 * we do not author ourselves is the Dashboard checklist's `ReadinessItem.cta`,
 * which the backend still emits as `/docker` / `/qemu`.
 */
describe("resolveRuntimeLink (P4)", () => {
  it("maps the legacy runtime routes onto the merged route's tracks", () => {
    expect(resolveRuntimeLink("/docker")).toBe(`${RUNTIME_ROUTE}?track=docker`);
    expect(resolveRuntimeLink("/qemu")).toBe(`${RUNTIME_ROUTE}?track=qemu`);
  });

  it("returns every other target untouched", () => {
    for (const target of ["/containers", "/containers?track=qemu", "/devices/rdc-1", "/adb", "/", "/settings"]) {
      expect(resolveRuntimeLink(target)).toBe(target);
    }
  });
});
