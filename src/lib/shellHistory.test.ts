import { describe, expect, it } from "vitest";
import { navigateShellHistory } from "./shellHistory";

describe("navigateShellHistory", () => {
  it("moves upward from the newest command to older commands", () => {
    expect(navigateShellHistory(["latest", "older"], -1, "draft", "up")).toEqual({
      index: 0,
      value: "latest",
    });
    expect(navigateShellHistory(["latest", "older"], 0, "draft", "up")).toEqual({
      index: 1,
      value: "older",
    });
  });

  it("stays on the oldest command when moving upward again", () => {
    expect(navigateShellHistory(["latest", "older"], 1, "draft", "up")).toEqual({
      index: 1,
      value: "older",
    });
  });

  it("restores the draft after moving back down past the newest command", () => {
    expect(navigateShellHistory(["latest", "older"], 1, "draft", "down")).toEqual({
      index: 0,
      value: "latest",
    });
    expect(navigateShellHistory(["latest", "older"], 0, "draft", "down")).toEqual({
      index: -1,
      value: "draft",
    });
  });

  it("ignores navigation when history is empty or already at the draft", () => {
    expect(navigateShellHistory([], -1, "draft", "up")).toEqual({ index: -1, value: "draft" });
    expect(navigateShellHistory(["latest"], -1, "draft", "down")).toEqual({ index: -1, value: "draft" });
  });
});
