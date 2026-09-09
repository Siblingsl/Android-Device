// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { UpdateCenterPage } from "./UpdateCenter";

function TestShell() {
  return <MemoryRouter><I18nProvider><UpdateCenterPage /></I18nProvider></MemoryRouter>;
}

describe("UpdateCenterPage", () => {
  beforeEach(() => {
    localStorage.setItem("rdc.lang", "zh-CN");
  });

  afterEach(() => cleanup());

  it("shows an explicit unavailable state instead of pretending an update source exists", () => {
    render(<TestShell />);

    expect(screen.getByRole("heading", { name: "更新中心" })).toBeTruthy();
    expect(screen.getByText("当前未配置更新源")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(screen.getByText("更新服务尚未配置，无法检查或下载。")).toBeTruthy();
  });

  it("keeps a documentation entry available", () => {
    render(<TestShell />);

    expect(screen.getByRole("link", { name: "打开项目文档" }).getAttribute("href")).toBe("https://github.com/Siblingsl/Android-Device");
  });
});
