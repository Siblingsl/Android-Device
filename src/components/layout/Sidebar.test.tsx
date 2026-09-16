// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
// Evaluated before the sidebar tree on purpose: `appStore` and `i18n` form an
// import cycle (the store calls tStatic while initializing), so importing the
// store first keeps the cycle in the order the other page tests rely on.
import { useAppStore } from "../../stores/appStore";
import { Sidebar } from "./Sidebar";
import { I18nProvider } from "../../i18n";
import { commonZh, commonEn } from "../../i18n/pages/common";
import { qemuZh, qemuEn } from "../../i18n/pages/qemu";

/** The nav the merged entry lives in (the settings link sits outside it). */
function primaryNav() {
  return screen.getByRole("navigation", { name: "Primary navigation" });
}

function navHrefs() {
  return within(primaryNav())
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
}

function renderSidebar(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Sidebar />
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Deterministic language: the real provider resolves it from localStorage and
  // falls back to navigator.language (en-US under jsdom).
  localStorage.setItem("rdc.lang", "zh-CN");
  useAppStore.setState({ devices: [] });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("rdc.lang");
});

/**
 * P4 (merge spec §6.1 / §8): the two runtime entries collapse into the single
 * "containers & nodes" one. The legacy `/docker` and `/qemu` routes stay as
 * redirects, but they must not come back as sidebar entries.
 */
describe("sidebar runtime entry (P4)", () => {
  it("offers one entry for both tracks and no per-track entry", () => {
    renderSidebar("/containers");
    const nav = primaryNav();

    const entry = within(nav).getByRole("link", { name: "容器与节点" });
    // Bare merged route: which track it lands on is decided by `?track=` >
    // remembered `defaultTrack` > docker inside the page, not by this link.
    expect(entry.getAttribute("href")).toBe("/containers");

    const hrefs = navHrefs();
    expect(hrefs.filter((href) => href?.startsWith("/containers"))).toHaveLength(1);
    expect(hrefs).not.toContain("/docker");
    expect(hrefs).not.toContain("/qemu");
    // The two old labels are gone as entries too (they only survive as i18n keys).
    expect(within(nav).queryByRole("link", { name: "Docker" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "QEMU 节点" })).toBeNull();
  });

  it("stays highlighted on the merged route whichever track is selected", () => {
    for (const path of ["/containers", "/containers?track=docker", "/containers?track=qemu"]) {
      const { unmount } = renderSidebar(path);
      const entry = screen.getByRole("link", { name: "容器与节点" });
      expect(entry.classList.contains("active"), `active on ${path}`).toBe(true);
      unmount();
    }

    renderSidebar("/devices");
    expect(screen.getByRole("link", { name: "容器与节点" }).classList.contains("active")).toBe(false);
  });

  it("keeps the settings entry rendered exactly once", () => {
    // The nav is rendered in two slices that stop before the trailing settings
    // item; dropping one entry must not pull settings into the nav twice.
    renderSidebar("/");
    expect(screen.getAllByRole("link", { name: "设置" })).toHaveLength(1);
  });

  it("labels the entry in both languages", () => {
    localStorage.setItem("rdc.lang", "en-US");
    renderSidebar("/containers");
    expect(screen.getByRole("link", { name: "Containers & Nodes" })).toBeTruthy();
  });
});

/**
 * Spec §6.6: the merged entry gets a new key, and the two old nav keys are kept
 * for at least one version — the legacy routes still redirect onto the tracks,
 * and older landing pages/tests may still resolve the old labels.
 */
describe("navigation i18n keys", () => {
  it("defines the merged entry label from the agreed copy", () => {
    expect(commonZh["common.nav.containers"]).toBe("容器与节点");
    expect(commonEn["common.nav.containers"]).toBe("Containers & Nodes");
  });

  it("keeps the legacy docker/qemu nav keys in both languages", () => {
    expect(commonZh["common.nav.docker"]).toBe("Docker");
    expect(commonEn["common.nav.docker"]).toBe("Docker");
    expect(qemuZh["common.nav.qemu"]).toBe("QEMU 节点");
    expect(qemuEn["common.nav.qemu"]).toBe("QEMU Nodes");
  });
});
