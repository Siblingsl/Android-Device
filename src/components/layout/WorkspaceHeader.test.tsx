// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../i18n";
import { WorkspaceHeader } from "./WorkspaceHeader";

function TestShell({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <I18nProvider>{children}</I18nProvider>
    </MemoryRouter>
  );
}

describe("WorkspaceHeader", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => cleanup());

  it("exposes the existing tools without rendering the old large sidebar", () => {
    render(<WorkspaceHeader />, { wrapper: TestShell });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));

    expect(screen.getByRole("link", { name: "设备中心" }).getAttribute("href")).toBe("/devices");
    expect(screen.getByRole("link", { name: "文件与应用" }).getAttribute("href")).toBe("/devices");
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  });
});
