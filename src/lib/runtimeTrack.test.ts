import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_VIEW,
  FALLBACK_RUNTIME_TRACK,
  RUNTIME_ROUTE,
  normalizeRuntimeTrack,
  resolveRuntimeLink,
  resolveRuntimeTrack,
  resolveRuntimeView,
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
 * P6: `?view=compare` selects the read-only compare view. Anything else — a
 * bare `/containers`, an old deep link, a typo — stays on the track view, so no
 * existing URL changes meaning and `?track=` keeps working alongside it.
 */
describe("resolveRuntimeView (P6)", () => {
  it("selects the compare view only for ?view=compare", () => {
    expect(resolveRuntimeView("compare")).toBe("compare");
    expect(resolveRuntimeView("tracks")).toBe(DEFAULT_RUNTIME_VIEW);
    for (const value of [null, undefined, "", "compare view", "COMPARE", "podman"]) {
      expect(resolveRuntimeView(value)).toBe(DEFAULT_RUNTIME_VIEW);
    }
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
